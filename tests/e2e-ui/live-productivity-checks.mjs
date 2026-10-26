import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

// Run only against the isolated real-service runner backed by collab_editor_test.
// Each run creates separate accounts and content; existing work is never changed.
const base = process.env.E2E_BASE_URL || 'http://localhost:5175'
const out = path.resolve(process.env.E2E_OUTPUT_DIR || 'artifacts/round2-20261022/live-productivity')
await fs.mkdir(out, { recursive: true })
const suffix = randomBytes(5).toString('hex')
const password = randomBytes(16).toString('base64')
const checks = [],
  errors = [],
  evidence = [],
  accounts = []
let browser
const pass = (label) => {
  checks.push(label)
  console.log('PASS', label)
}

async function api(route, token, method = 'GET', body) {
  const response = await fetch(base + route, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  })
  assert.ok(response.ok, `${method} ${route}: ${response.status}`)
  return response.json()
}

async function account(role, nickname) {
  const auth = await api('/api/auth/register', null, 'POST', {
    username: `productive_${role}_${suffix}`,
    nickname,
    password,
  })
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
  await context.addInitScript((token) => localStorage.setItem('collab_access_token', token), auth.token)
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  const client = { role, token: auth.token, user: auth.user, page, docKey: '', operations: [] }
  page.on('pageerror', (error) => errors.push({ role, message: error.message }))
  page.on('websocket', (socket) => {
    const docKey = client.docKey
    socket.on('framesent', ({ payload }) => {
      try {
        const message = JSON.parse(String(payload))
        if (message.type === 'op') client.operations.push({ docKey: message.docId || docKey, op: message.op })
      } catch {
        // Diagnostic parsing must not change the real transport.
      }
    })
  })
  accounts.push(client)
  return client
}

async function flushUI(page) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )
}

async function saved(client) {
  await flushUI(client.page)
  await client.page.waitForFunction(
    () => document.querySelector('.connection-success') && !document.querySelector('.connection-pending'),
  )
}

async function open(client, doc) {
  client.docKey = doc.docKey
  await client.page.goto(`${base}/#/work/${doc.kind}/${doc.docKey}`)
  await saved(client)
}

async function state(doc, token) {
  const history = await api(`/api/docs/${doc.docKey}/history?limit=200`, token)
  const replay = await api(`/api/docs/${doc.docKey}/replay?rev=${history.rev}`, token)
  assert.equal(replay.rev, history.rev)
  return { revision: history.rev, elements: replay.elements, history: history.ops }
}

function elementValues(snapshot, id) {
  const element = snapshot.elements.find((element) => element.id === id)
  assert.ok(element, `Missing persisted element ${id}`)
  return Object.fromEntries(
    Object.entries(element.fields || {})
      .filter(([name]) => name !== '#version')
      .map(([name, field]) => [name, field.value]),
  )
}

async function unchanged(doc, token, before, clients, counts) {
  for (const client of clients) await saved(client)
  const after = await state(doc, token)
  assert.equal(after.revision, before.revision, 'Local navigation must not advance server revision')
  assert.deepEqual(after.elements, before.elements, 'Local navigation must not change saved content')
  clients.forEach((client, index) => assert.equal(client.operations.length, counts[index]))
  return after
}

async function waitValue(page, selector, text) {
  await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.value === text, {
    selector,
    text,
  })
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true, animations: 'disabled' })
}

async function findStatus(page, text) {
  await page.waitForFunction(
    (text) => document.querySelector('.document-find-count')?.textContent === text,
    text,
  )
}

async function zoomTo(page, percent) {
  await page.getByRole('combobox', { name: '白板缩放', exact: true }).selectOption(String(percent))
  await page.waitForFunction(
    (scale) =>
      Math.abs(new DOMMatrix(getComputedStyle(document.querySelector('.board-canvas')).transform).a - scale) <
      0.001,
    percent / 100,
  )
  await flushUI(page)
}

async function boardPosition(page, id) {
  return page.locator(`[data-card-id="${id}"]`).evaluate((element) => {
    const matrix = new DOMMatrix(element.style.transform)
    return { x: matrix.e, y: matrix.f }
  })
}

async function waitBoardPosition(page, id, x, y) {
  await page.waitForFunction(
    ({ id, x, y }) => {
      const element = document.querySelector(`[data-card-id="${CSS.escape(id)}"]`)
      if (!element) return false
      const matrix = new DOMMatrix(element.style.transform)
      return Math.abs(matrix.e - x) <= 1 && Math.abs(matrix.f - y) <= 1
    },
    { id, x, y },
  )
}

async function dragCard(page, id, dx, dy) {
  const handle = page.locator(`[data-card-id="${id}"] .board-card-top`)
  await handle.scrollIntoViewIfNeeded()
  const bounds = await handle.boundingBox()
  assert.ok(bounds)
  const start = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 6 })
  await page.mouse.up()
}

async function jumpTo(page, id) {
  await page.getByRole('combobox', { name: '跳转列表', exact: true }).selectOption(id)
  await page.waitForFunction((id) => {
    const viewport = document.querySelector('.kanban-scroll').getBoundingClientRect()
    const column = document.querySelector(`[data-column-id="${CSS.escape(id)}"]`).getBoundingClientRect()
    return column.left >= viewport.left - 1 && column.right <= viewport.right + 1
  }, id)
}

try {
  browser = await chromium.launch({ headless: true })
  const owner = await account('owner', '内容所有者')
  const editor = await account('editor', '协作同学')
  const viewer = await account('viewer', '只读同学')
  const space = await api('/api/spaces', owner.token, 'POST', { name: `编辑便利验证_${suffix}` })
  for (const client of [editor, viewer])
    await api(`/api/spaces/${space.spaceId}/members`, owner.token, 'POST', {
      username: client.user.username,
      role: client.role,
    })
  const docs = {}
  for (const kind of ['doc', 'board', 'kanban'])
    docs[kind] = await api('/api/docs', owner.token, 'POST', {
      kind,
      title: `${kind} 真实便利功能验证`,
      spaceId: space.spaceId,
    })
  pass('真实创建独立账号和协作空间，所有者、编辑者、只读者加入三种内容')

  const doc = docs.doc
  await open(owner, doc)
  if ((await owner.page.locator('.paragraph-row textarea').count()) === 0)
    await owner.page.getByRole('button', { name: '添加段落', exact: true }).click()
  const body = '😀 协作让讨论更清楚；第二处协作保留中文与 emoji。'
  await owner.page.locator('.paragraph-row textarea').first().fill(body)
  await saved(owner)
  const paragraphId = await owner.page
    .locator('.paragraph-row textarea')
    .first()
    .getAttribute('data-paragraph-id')
  const paragraphSelector = `[data-paragraph-id="${paragraphId}"]`
  await open(editor, doc)
  await waitValue(editor.page, paragraphSelector, body)
  const beforeFind = await state(doc, owner.token)
  const editorOperations = editor.operations.length
  const field = editor.page.locator(paragraphSelector)
  await field.focus()
  await field.evaluate((element) => element.setSelectionRange(0, 2))
  await editor.page.keyboard.press('Control+f')
  const query = editor.page.getByRole('searchbox', { name: '查找正文', exact: true })
  await query.fill('协作')
  await findStatus(editor.page, '1 / 2')
  assert.deepEqual(
    await field.evaluate((element) => ({
      start: element.selectionStart,
      end: element.selectionEnd,
      text: element.value.slice(element.selectionStart, element.selectionEnd),
    })),
    { start: body.indexOf('协作'), end: body.indexOf('协作') + 2, text: '协作' },
  )
  await query.press('Enter')
  await findStatus(editor.page, '2 / 2')
  assert.equal(await field.evaluate((element) => element.selectionStart), body.lastIndexOf('协作'))
  await query.press('Shift+Enter')
  await findStatus(editor.page, '1 / 2')
  await shot(editor.page, 'document-find-editor')
  await query.press('Escape')
  await editor.page.getByRole('search', { name: '文档内查找', exact: true }).waitFor({ state: 'detached' })
  assert.deepEqual(
    await field.evaluate((element) => ({
      focused: document.activeElement === element,
      start: element.selectionStart,
      end: element.selectionEnd,
    })),
    { focused: true, start: 0, end: 2 },
  )
  await unchanged(doc, owner.token, beforeFind, [editor], [editorOperations])
  pass('编辑者 Ctrl+F 正确定位 emoji 后中文，Enter/Shift+Enter 与 Esc 恢复选区且不写版本')

  await open(viewer, doc)
  await waitValue(viewer.page, paragraphSelector, body)
  assert.equal(await viewer.page.locator(paragraphSelector).isEditable(), false)
  assert.equal(await viewer.page.getByRole('button', { name: '添加段落', exact: true }).count(), 0)
  const viewerOperations = viewer.operations.length
  await viewer.page.locator(paragraphSelector).focus()
  await viewer.page.keyboard.press('Control+f')
  const viewerQuery = viewer.page.getByRole('searchbox', { name: '查找正文', exact: true })
  await viewerQuery.fill('协作')
  await findStatus(viewer.page, '1 / 2')
  await viewerQuery.press('Enter')
  await findStatus(viewer.page, '2 / 2')
  await shot(viewer.page, 'document-find-viewer')
  await viewerQuery.press('Escape')
  await unchanged(doc, owner.token, beforeFind, [editor, viewer], [editorOperations, viewerOperations])
  evidence.push({ kind: 'doc', docKey: doc.docKey, revision: beforeFind.revision, query: '协作', matches: 2 })
  pass('只读者可查找和跳转中文匹配，编辑入口不可用，服务端正文和版本保持一致')

  const board = docs.board
  await open(owner, board)
  await owner.page.getByRole('button', { name: '添加卡片', exact: true }).click()
  const cardText = '缩放后的卡片仍按真实坐标协作'
  await owner.page.locator('.board-card textarea').first().fill(cardText)
  await saved(owner)
  const cardId = await owner.page.locator('.board-card').first().getAttribute('data-card-id')
  await open(editor, board)
  await waitValue(editor.page, `[data-card-id="${cardId}"] textarea`, cardText)
  const beforeView = await state(board, owner.token)
  const beforeViewOps = editor.operations.length
  await zoomTo(editor.page, 50)
  const boardViewport = await editor.page.locator('.board-scroll').boundingBox()
  await editor.page.mouse.move(
    boardViewport.x + boardViewport.width / 2,
    boardViewport.y + boardViewport.height / 2,
  )
  await editor.page.keyboard.down('Control')
  await editor.page.mouse.wheel(0, -120)
  await editor.page.keyboard.up('Control')
  await editor.page.waitForFunction(
    () => new DOMMatrix(getComputedStyle(document.querySelector('.board-canvas')).transform).a > 0.5,
  )
  await editor.page.getByRole('button', { name: '适应全部内容', exact: true }).click()
  await flushUI(editor.page)
  const visibleCard = await editor.page.locator(`[data-card-id="${cardId}"]`).boundingBox()
  const fittedViewport = await editor.page.locator('.board-scroll').boundingBox()
  assert.ok(
    visibleCard.x >= fittedViewport.x - 1 &&
      visibleCard.y >= fittedViewport.y - 1 &&
      visibleCard.x + visibleCard.width <= fittedViewport.x + fittedViewport.width + 1 &&
      visibleCard.y + visibleCard.height <= fittedViewport.y + fittedViewport.height + 1,
  )
  await zoomTo(editor.page, 100)
  await editor.page.getByRole('button', { name: '平移白板', exact: true }).click()
  const panViewport = await editor.page.locator('.board-scroll').boundingBox()
  const panBefore = await editor.page
    .locator('.board-scroll')
    .evaluate((element) => ({ x: element.scrollLeft, y: element.scrollTop }))
  const panPoint = { x: panViewport.x + panViewport.width / 2, y: panViewport.y + panViewport.height / 2 }
  await editor.page.mouse.move(panPoint.x, panPoint.y)
  await editor.page.mouse.down()
  await editor.page.mouse.move(panPoint.x - 60, panPoint.y - 40, { steps: 6 })
  await editor.page.mouse.up()
  const panAfter = await editor.page
    .locator('.board-scroll')
    .evaluate((element) => ({ x: element.scrollLeft, y: element.scrollTop }))
  assert.ok(Math.abs(panAfter.x - panBefore.x - 60) <= 1 && Math.abs(panAfter.y - panBefore.y - 40) <= 1)
  await editor.page.getByRole('button', { name: '平移白板', exact: true }).click()
  await unchanged(board, owner.token, beforeView, [editor], [beforeViewOps])
  pass('真实白板的 50% 缩放、Ctrl 滚轮、适应和平移只改变本地视图，不产生写操作')

  await zoomTo(editor.page, 50)
  const initialCard = elementValues(beforeView, cardId)
  await dragCard(editor.page, cardId, 40, 30)
  await waitBoardPosition(owner.page, cardId, initialCard.x + 80, initialCard.y + 60)
  await saved(editor)
  const afterDrag = await state(board, owner.token)
  const movedValues = elementValues(afterDrag, cardId)
  assert.equal(afterDrag.revision, beforeView.revision + 1)
  assert.deepEqual(movedValues, { ...initialCard, x: initialCard.x + 80, y: initialCard.y + 60 })
  const dragOperations = editor.operations.slice(beforeViewOps)
  assert.equal(dragOperations.length, 1)
  assert.equal(dragOperations[0].op.type, 'STATE')
  assert.equal(dragOperations[0].op.elementId, cardId)
  assert.equal(dragOperations[0].op.value.text, cardText)
  assert.deepEqual(await boardPosition(editor.page, cardId), await boardPosition(owner.page, cardId))
  await shot(editor.page, 'board-drag-at-50-percent')
  pass('50% 缩放后拖动 40×30 屏幕像素写入 80×60 真实坐标，单个 STATE 同步到所有者')

  await open(viewer, board)
  await waitBoardPosition(viewer.page, cardId, movedValues.x, movedValues.y)
  const viewerBeforeBoardOps = viewer.operations.length
  assert.equal(await viewer.page.locator(`[data-card-id="${cardId}"] textarea`).isEditable(), false)
  assert.equal(await viewer.page.getByRole('button', { name: '添加卡片', exact: true }).count(), 0)
  assert.equal(await viewer.page.getByRole('button', { name: '调整卡片大小', exact: true }).count(), 0)
  await zoomTo(viewer.page, 50)
  await dragCard(viewer.page, cardId, 30, 20)
  assert.deepEqual(await boardPosition(viewer.page, cardId), { x: movedValues.x, y: movedValues.y })
  await viewer.page.getByRole('button', { name: '适应全部内容', exact: true }).click()
  await unchanged(board, owner.token, afterDrag, [viewer], [viewerBeforeBoardOps])
  await shot(viewer.page, 'board-viewer-navigation')
  evidence.push({
    kind: 'board',
    docKey: board.docKey,
    beforeRevision: beforeView.revision,
    afterDragRevision: afterDrag.revision,
    cardId,
    from: { x: initialCard.x, y: initialCard.y },
    to: { x: movedValues.x, y: movedValues.y },
    screenDelta: { x: 40, y: 30 },
    scale: 0.5,
  })
  pass('只读者仍可缩放和适应白板，拖动卡片不会改变内容或服务端版本')

  const kanban = docs.kanban
  await open(owner, kanban)
  const columns = []
  for (const title of ['待办', '评审', '评审']) {
    await owner.page.locator('.kanban-tools').getByRole('button', { name: '添加列表', exact: true }).click()
    const column = owner.page.locator('.kanban-column').nth(columns.length)
    await column.waitFor()
    const id = await column.getAttribute('data-column-id')
    await column.getByRole('textbox', { name: '列表标题', exact: true }).fill(title)
    await column.getByRole('textbox', { name: '列表标题', exact: true }).press('Tab')
    await saved(owner)
    columns.push(id)
  }
  const firstColumn = owner.page.locator(`[data-column-id="${columns[0]}"]`)
  for (const text of ['保留原列表的参照任务', '跨越同名列表的协作任务 😀']) {
    await firstColumn.getByRole('button', { name: '添加卡片', exact: true }).click()
    await firstColumn.locator('.kanban-card textarea').last().fill(text)
    await saved(owner)
  }
  const mainCardId = await firstColumn.locator('.kanban-card').last().getAttribute('data-card-id')
  const taskText = '跨越同名列表的协作任务 😀'
  await open(editor, kanban)
  await waitValue(editor.page, `[data-card-id="${mainCardId}"] textarea`, taskText)
  const beforeMove = await state(kanban, owner.token)
  const originalTask = elementValues(beforeMove, mainCardId)
  assert.equal(originalTask.color, '#fff1c9')
  const destination = owner.page
    .locator(`[data-card-id="${mainCardId}"]`)
    .getByRole('combobox', { name: '移至列表', exact: true })
  assert.equal((await destination.locator(`option[value="${columns[1]}"]`).textContent()).trim(), '2. 评审')
  assert.equal((await destination.locator(`option[value="${columns[2]}"]`).textContent()).trim(), '3. 评审')
  const ownerBeforeMoveOps = owner.operations.length
  await destination.selectOption(columns[2])
  await editor.page.locator(`[data-column-id="${columns[2]}"] [data-card-id="${mainCardId}"]`).waitFor()
  await waitValue(editor.page, `[data-card-id="${mainCardId}"] textarea`, taskText)
  await saved(owner)
  const afterMove = await state(kanban, owner.token)
  const movedTask = elementValues(afterMove, mainCardId)
  assert.equal(afterMove.revision, beforeMove.revision + 1)
  assert.equal(movedTask.column, columns[2])
  assert.equal(movedTask.order, 1024)
  assert.equal(movedTask.text, originalTask.text)
  assert.equal(movedTask.color, originalTask.color)
  const moveOperations = owner.operations.slice(ownerBeforeMoveOps)
  assert.equal(moveOperations.length, 1)
  assert.equal(moveOperations[0].op.type, 'STATE')
  assert.equal(moveOperations[0].op.elementId, mainCardId)
  assert.equal(moveOperations[0].op.value.column, columns[2])
  assert.equal(moveOperations[0].op.value.text, originalTask.text)
  assert.equal(moveOperations[0].op.value.color, originalTask.color)
  const persistedMoves = afterMove.history.filter((operation) => Number(operation.seq) > beforeMove.revision)
  assert.equal(persistedMoves.length, 1)
  assert.match(persistedMoves[0].clock, /^STATE\|/)
  assert.equal(persistedMoves[0].element_id, mainCardId)
  const persistedValue =
    typeof persistedMoves[0].value_json === 'string'
      ? JSON.parse(persistedMoves[0].value_json)
      : persistedMoves[0].value_json
  assert.equal(persistedValue.column, columns[2])
  assert.equal(persistedValue.text, originalTask.text)
  assert.equal(persistedValue.color, originalTask.color)
  assert.equal(
    await editor.page
      .locator(`[data-card-id="${mainCardId}"]`)
      .evaluate((element) => getComputedStyle(element).backgroundColor),
    'rgb(255, 241, 201)',
  )
  await shot(owner.page, 'kanban-moved-third-column')
  pass('同名列表以序号区分，一次移动到第三列只写一个完整 STATE，文字和黄色卡片同步保留')

  const editorBeforeJumpOps = editor.operations.length
  await jumpTo(editor.page, columns[2])
  await jumpTo(editor.page, columns[0])
  await unchanged(kanban, owner.token, afterMove, [editor], [editorBeforeJumpOps])
  await open(viewer, kanban)
  await waitValue(viewer.page, `[data-card-id="${mainCardId}"] textarea`, taskText)
  const viewerBeforeJumpOps = viewer.operations.length
  assert.equal(await viewer.page.getByRole('combobox', { name: '移至列表', exact: true }).count(), 0)
  assert.equal(await viewer.page.getByRole('button', { name: '添加列表', exact: true }).count(), 0)
  assert.equal(await viewer.page.getByRole('button', { name: '拖动卡片', exact: true }).count(), 0)
  assert.equal(await viewer.page.locator(`[data-card-id="${mainCardId}"] textarea`).isEditable(), false)
  await jumpTo(viewer.page, columns[2])
  await jumpTo(viewer.page, columns[0])
  await unchanged(
    kanban,
    owner.token,
    afterMove,
    [editor, viewer],
    [editorBeforeJumpOps, viewerBeforeJumpOps],
  )
  await shot(viewer.page, 'kanban-viewer-navigation')
  evidence.push({
    kind: 'kanban',
    docKey: kanban.docKey,
    beforeRevision: beforeMove.revision,
    afterMoveRevision: afterMove.revision,
    cardId: mainCardId,
    fromColumn: columns[0],
    toColumn: columns[2],
    color: movedTask.color,
    moveOperationCount: 1,
  })
  pass('编辑者和只读者均可跳转列表且不增版本，只读页面没有移动和新增控件')

  assert.deepEqual(errors, [])
  await fs.writeFile(
    path.join(out, 'summary.json'),
    JSON.stringify({ status: 'passed', database: 'collab_editor_test', checks, errors, evidence }, null, 2),
  )
} catch (error) {
  for (const client of accounts) {
    try {
      await shot(client.page, `failure-${client.role}`)
    } catch {
      // Preserve the original failure even if setup or the browser was interrupted.
    }
  }
  await fs.writeFile(
    path.join(out, 'summary.json'),
    JSON.stringify({ status: 'failed', checks, errors, evidence, error: String(error) }, null, 2),
  )
  throw error
} finally {
  await browser?.close()
}
