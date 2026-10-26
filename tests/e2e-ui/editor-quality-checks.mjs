import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

// Every API request and websocket connection is mocked. No account or document
// is created in the local database by this interaction suite.
const base = process.env.E2E_BASE_URL || 'http://localhost:5173'
const out = path.resolve(process.env.E2E_OUTPUT_DIR || 'artifacts/ui-editor-quality-20261022')
await fs.mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
const checks = []
const errors = []
const apiRequests = []
page.on('pageerror', (error) => errors.push(error.message))
page.setDefaultTimeout(12_000)
const pass = (label) => {
  checks.push(label)
  console.log('PASS', label)
}
const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfZkAAAAASUVORK5CYII=',
  'base64',
)
const user = { id: 99201, username: 'editor_quality_check', nickname: '编辑器交互检查', avatarUrl: '' }
let counter = 0
let imageNumber = 0
let heldUpload = null
let holdNextUpload = false
const documents = Object.fromEntries(
  ['doc', 'board', 'kanban'].map((kind) => [
    kind,
    {
      metadata: {
        doc_key: `editor-quality-${kind}`,
        kind,
        title: `编辑器检查 ${kind}`,
        space_id: 99201,
        space_name: '编辑器检查空间',
        my_role: 'owner',
      },
      elements: new Map(),
      operations: [],
      sockets: new Set(),
      rev: 0,
      canWrite: true,
    },
  ]),
)

function snapshotElement(operation) {
  return {
    id: operation.elementId,
    type: operation.elementType,
    rootClock: operation.clock,
    fields: {
      ...Object.fromEntries(
        Object.entries(operation.value).map(([key, value]) => [key, { value, clock: operation.clock }]),
      ),
      '#version': { value: operation.opId, clock: operation.clock },
    },
  }
}

function values(kind, id) {
  return Object.fromEntries(
    Object.entries(documents[kind].elements.get(id)?.fields || {})
      .filter(([key]) => key !== '#version')
      .map(([key, field]) => [key, field.value]),
  )
}

function remote(kind, id, type, changes) {
  const entry = documents[kind]
  const op = {
    type: 'STATE',
    elementId: id,
    elementType: type,
    value: { ...values(kind, id), ...changes },
    clock: `quality-remote:${++counter}`,
    opId: `remote-${counter}`,
  }
  entry.elements.set(id, snapshotElement(op))
  entry.rev += 1
  for (const socket of entry.sockets) socket.send(JSON.stringify({ type: 'applied', rev: entry.rev, op }))
  return op
}

function permission(kind, canWrite) {
  const entry = documents[kind]
  entry.canWrite = canWrite
  for (const socket of entry.sockets) {
    if (canWrite) socket.close({ code: 4001, reason: 'refresh permission' })
    else
      socket.send(
        JSON.stringify({
          type: 'error',
          code: 'READ_ONLY',
          message: '只读成员（viewer）不可编辑',
          fatal: false,
        }),
      )
  }
}

function operationCount(kind) {
  return documents[kind].operations.length
}

async function settled() {
  // Allow the browser's websocket and Vue render queues to complete. This is
  // only used for asserting that a cancellation did not send an operation.
  await page.waitForTimeout(90)
}

async function actionOperations(kind, action, expected = 1) {
  const start = operationCount(kind)
  await action()
  if (expected) await waitUntil(() => operationCount(kind) >= start + expected)
  await settled()
  const sent = documents[kind].operations.slice(start)
  assert.equal(
    sent.length,
    expected,
    `${kind}: expected ${expected} complete STATE operations, got ${sent.length}`,
  )
  assert.ok(sent.every((op) => op.type === 'STATE'))
  return sent
}

async function waitUntil(check) {
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Condition was not met before timeout')
}

async function goto(kind) {
  await page.goto(`${base}/#/work/${kind}/${documents[kind].metadata.doc_key}`)
  await page.locator(kind === 'doc' ? '.document-editor' : `.${kind}-editor`).waitFor()
  await page.waitForFunction(() => !document.querySelector('.offline-strip'))
}

async function focused(locator) {
  await locator.waitFor()
  try {
    await page.waitForFunction((element) => document.activeElement === element, await locator.elementHandle())
  } catch (error) {
    console.error(
      'FOCUS_DIAGNOSTIC',
      JSON.stringify(
        await page.evaluate(() => ({
          active: document.activeElement?.outerHTML?.slice(0, 500),
          events: window.__editorFocusEvents?.slice(-16),
          inert: [...document.querySelectorAll('[inert]')].map((element) => element.className),
        })),
      ),
    )
    throw error
  }
}

async function beginBoardDrag(card, mode = 'move') {
  const handle =
    mode === 'resize'
      ? card.getByRole('button', { name: '调整卡片大小', exact: true })
      : card.locator('.board-card-top')
  const box = await handle.boundingBox()
  assert.ok(box)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 35, { steps: 3 })
}

async function beginKanbanDrag(card, targetColumn) {
  const handle = card.getByRole('button', { name: '拖动卡片', exact: true })
  const box = await handle.boundingBox()
  const target = await targetColumn.locator('.kanban-cards').boundingBox()
  assert.ok(box && target)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x + target.width / 2, target.y + target.height - 8, { steps: 4 })
  await page.waitForFunction(() => document.body.classList.contains('kanban-dragging'))
}

async function checkComposition(kind, id, locator) {
  await actionOperations(
    kind,
    () =>
      locator.evaluate((element) => {
        element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
        element.value = 'zhong'
        element.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'zhong', isComposing: true }))
      }),
    0,
  )
  remote(kind, id, 'CARD', { text: '远端输入', note: '组合期间远端字段' })
  await settled()
  assert.equal(await locator.inputValue(), 'zhong')
  const [operation] = await actionOperations(kind, () =>
    locator.evaluate((element) => {
      element.value = '中文卡片'
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文卡片' }))
      element.dispatchEvent(new InputEvent('input', { bubbles: true, data: '中文卡片', isComposing: false }))
    }),
  )
  assert.equal(operation.value.text, '中文卡片')
  assert.equal(operation.value.note, '组合期间远端字段')
}

async function waitForLayout() {
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})))
  })
}

await page.addInitScript(() => {
  localStorage.setItem('collab_access_token', 'mock-editor-quality-check')
  window.__editorFocusEvents = []
  for (const type of ['focusin', 'focusout'])
    document.addEventListener(type, (event) => {
      window.__editorFocusEvents.push({
        type,
        tag: event.target.tagName,
        label: event.target.getAttribute?.('aria-label'),
        at: performance.now(),
      })
    })
})
await page.route('**/api/**', async (route) => {
  const request = route.request()
  const url = new URL(request.url())
  apiRequests.push(`${request.method()} ${url.pathname}`)
  const metadata = Object.values(documents).map((entry) => entry.metadata)
  if (url.pathname.startsWith('/api/assets/')) {
    await route.fulfill({ status: 200, contentType: 'image/png', body: tinyPng })
    return
  }
  let result
  if (url.pathname === '/api/auth/me') result = user
  else if (url.pathname === '/api/spaces')
    result = [{ id: 99201, name: '编辑器检查空间', my_role: 'owner', doc_count: 3 }]
  else if (url.pathname.endsWith('/members')) result = { members: [{ ...user, role: 'owner' }] }
  else if (url.pathname === '/api/stats') result = { spaces: 1, documents: 3, operations: 0 }
  else if (url.pathname === '/api/docs') result = metadata
  else if (url.pathname.endsWith('/images') && request.method() === 'POST') {
    imageNumber += 1
    result = {
      assetId: `quality-image-${imageNumber}`,
      name: `图片 ${imageNumber}.png`,
      url: `/api/assets/quality-image-${imageNumber}`,
      width: 400,
      height: 240,
    }
    if (holdNextUpload) {
      holdNextUpload = false
      await new Promise((resolve) => {
        heldUpload = resolve
      })
      heldUpload = null
    }
  } else result = metadata.find((item) => url.pathname === `/api/docs/${item.doc_key}`)
  if (!result) throw new Error(`Unexpected mock API request: ${request.method()} ${url.pathname}`)
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) })
})
await page.routeWebSocket(/\/ws(?:\?|\/|$)/, (socket) => {
  let entry
  socket.onMessage((raw) => {
    const message = JSON.parse(String(raw))
    if (message.type === 'hello') {
      entry = Object.values(documents).find((item) => item.metadata.doc_key === message.docId)
      assert.ok(entry, 'Only mocked documents may connect')
      entry.sockets.add(socket)
      socket.send(
        JSON.stringify({
          type: 'welcome',
          snapshot: [...entry.elements.values()],
          rev: entry.rev,
          role: entry.canWrite ? 'owner' : 'viewer',
          canWrite: entry.canWrite,
        }),
      )
    } else if (message.type === 'op') {
      const op = message.op
      counter = Math.max(counter, Number(op.clock.split(':').at(-1)))
      entry.operations.push(op)
      entry.elements.set(op.elementId, snapshotElement(op))
      entry.rev += 1
      socket.send(JSON.stringify({ type: 'applied', rev: entry.rev, op }))
    } else if (message.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }))
  })
  socket.onClose(() => entry?.sockets.delete(socket))
})

try {
  await goto('doc')
  const [paragraph] = await actionOperations('doc', () =>
    page.getByRole('button', { name: '添加段落', exact: true }).click(),
  )
  assert.deepEqual(paragraph.value, { text: '', order: 1024 })
  const firstParagraph = page.locator(`[data-paragraph-id="${paragraph.elementId}"]`)
  await focused(firstParagraph)
  await firstParagraph.fill('前面选中后面')
  await firstParagraph.evaluate((element) => element.setSelectionRange(2, 4))
  const split = await actionOperations('doc', () => firstParagraph.press('Enter'), 2)
  assert.equal(split[0].value.text, '后面')
  assert.equal(split[1].value.text, '前面')
  const secondParagraph = page.locator(`[data-paragraph-id="${split[0].elementId}"]`)
  await focused(secondParagraph)
  assert.equal(await secondParagraph.evaluate((element) => element.selectionStart), 0)
  await actionOperations('doc', () => secondParagraph.press('Shift+Enter'))
  assert.equal(await secondParagraph.inputValue(), '\n后面')
  assert.equal(await page.locator('[data-paragraph-id]').count(), 2)
  pass('文档创建一次发送完整段落，Enter 替换选区并聚焦新段开头，Shift+Enter 段内换行')

  await secondParagraph.fill('')
  await actionOperations(
    'doc',
    async () => {
      await secondParagraph.evaluate((element) => {
        element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
        element.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Backspace',
            isComposing: true,
            bubbles: true,
            cancelable: true,
          }),
        )
        element.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }),
        )
        element.value = '中'
        element.dispatchEvent(new InputEvent('input', { bubbles: true, data: '中', isComposing: true }))
      })
    },
    0,
  )
  assert.equal(await page.locator('[data-paragraph-id]').count(), 2)
  remote('doc', split[0].elementId, 'TEXT', { text: '远端内容', extra: '保留远端元数据' })
  await settled()
  assert.equal(await secondParagraph.inputValue(), '中')
  const [composed] = await actionOperations('doc', () =>
    secondParagraph.evaluate((element) => {
      element.value = '中文输入'
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文输入' }))
      element.dispatchEvent(new InputEvent('input', { bubbles: true, data: '中文输入', isComposing: false }))
    }),
  )
  assert.equal(composed.value.text, '中文输入')
  assert.equal(composed.value.extra, '保留远端元数据')
  pass('中文组合输入期间不拆段、不删段、不发送半成品，远端更新不会打断组合输入，完成后保留最新元数据')

  const [paragraphMove] = await actionOperations('doc', () =>
    page.locator('.paragraph-row').nth(1).getByRole('button', { name: '段落上移', exact: true }).click(),
  )
  assert.equal(paragraphMove.elementId, split[0].elementId)
  assert.equal(paragraphMove.value.text, '中文输入')
  assert.equal(
    await page.locator('[data-paragraph-id]').first().getAttribute('data-paragraph-id'),
    split[0].elementId,
  )
  pass('段落排序一次提交且保留段落文本与其他字段')

  remote('doc', 'collision-a', 'TEXT', { text: '同时创建 A', order: 9000, custom: '甲' })
  remote('doc', 'collision-b', 'TEXT', { text: '同时创建 B', order: 9000, custom: '乙' })
  const collision = page.locator('[data-paragraph-id="collision-a"]')
  await collision.waitFor()
  await collision.focus()
  await collision.evaluate((element) => element.setSelectionRange(element.value.length, element.value.length))
  const collisionOperations = await actionOperations('doc', () => collision.press('Enter'), 6)
  const splitId = collisionOperations.find(
    (op) => !['collision-a', 'collision-b', paragraph.elementId, split[0].elementId].includes(op.elementId),
  ).elementId
  const documentOrder = await page
    .locator('[data-paragraph-id]')
    .evaluateAll((elements) => elements.map((element) => element.dataset.paragraphId))
  assert.equal(documentOrder[documentOrder.indexOf('collision-a') + 1], splitId)
  assert.equal(documentOrder[documentOrder.indexOf(splitId) + 1], 'collision-b')
  assert.equal(values('doc', 'collision-b').custom, '乙')
  pass('协作者同时创建相同排序号时仍能准确分段插入，必要重排保留所有内容')

  await goto('board')
  const [boardCreate] = await actionOperations('board', () =>
    page.getByRole('button', { name: '添加卡片', exact: true }).click(),
  )
  assert.deepEqual(boardCreate.value, { x: 56, y: 56, w: 220, h: 150, z: 1, text: '', color: '#fff1a8' })
  let boardCard = page.locator(`[data-card-id="${boardCreate.elementId}"]`)
  await focused(boardCard.getByRole('textbox', { name: '卡片内容', exact: true }))
  await boardCard.getByRole('textbox', { name: '卡片内容', exact: true }).fill('白板原内容')
  const beforeDrag = operationCount('board')
  await beginBoardDrag(boardCard)
  remote('board', boardCreate.elementId, 'CARD', {
    text: '拖动时远端编辑',
    color: '#dcecff',
    w: 260,
    h: 180,
    note: 'remote',
  })
  await settled()
  const [boardMove] = await actionOperations('board', () => page.mouse.up())
  assert.equal(operationCount('board'), beforeDrag + 1)
  assert.equal(boardMove.value.text, '拖动时远端编辑')
  assert.equal(boardMove.value.color, '#dcecff')
  assert.equal(boardMove.value.note, 'remote')
  assert.equal(boardMove.value.w, 260)
  assert.equal(boardMove.value.h, 180)
  assert.ok(boardMove.value.x > 56 && boardMove.value.y > 56)
  pass('白板创建与拖动各一次完整提交，拖动期间保留远端的新文本、颜色和尺寸')

  await beginBoardDrag(boardCard, 'resize')
  remote('board', boardCreate.elementId, 'CARD', { x: 250, y: 200, text: '缩放时的新文本' })
  await settled()
  const [resized] = await actionOperations('board', () => page.mouse.up())
  assert.equal(resized.value.x, 250)
  assert.equal(resized.value.y, 200)
  assert.equal(resized.value.text, '缩放时的新文本')
  assert.ok(resized.value.w > 260 && resized.value.h > 180)
  await boardCard.focus()
  const [nudge] = await actionOperations('board', () => page.keyboard.press('ArrowRight'))
  assert.equal(nudge.value.x, 255)
  assert.equal(nudge.value.y, 200)
  pass('白板缩放保留远端的新位置，方向键微调一次提交完整几何字段')

  const resizeHandle = boardCard.getByRole('button', { name: '调整卡片大小', exact: true })
  await resizeHandle.focus()
  const beforeKeyboardResize = values('board', boardCreate.elementId)
  const [keyboardResize] = await actionOperations('board', () => resizeHandle.press('Shift+ArrowRight'))
  assert.equal(keyboardResize.value.w, beforeKeyboardResize.w + 20)
  assert.equal(keyboardResize.value.h, beforeKeyboardResize.h)
  assert.equal(keyboardResize.value.text, beforeKeyboardResize.text)
  pass('白板缩放手柄可用方向键操作，Shift 每次调整 20 像素')

  await checkComposition(
    'board',
    boardCreate.elementId,
    boardCard.getByRole('textbox', { name: '卡片内容', exact: true }),
  )
  pass('白板中文组合输入不广播拼音中间态，完成后合并远端其他字段')

  for (const cancel of ['Escape', 'pointercancel', 'blur']) {
    const before = values('board', boardCreate.elementId)
    await beginBoardDrag(boardCard)
    await actionOperations(
      'board',
      async () => {
        if (cancel === 'Escape') await page.keyboard.press('Escape')
        else if (cancel === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')))
        else await boardCard.dispatchEvent('pointercancel', { pointerId: 1, bubbles: true })
        await page.mouse.up()
      },
      0,
    )
    assert.deepEqual(values('board', boardCreate.elementId), before)
    assert.equal(await boardCard.evaluate((element) => element.classList.contains('dragging')), false)
  }
  pass('白板 Esc、指针取消及窗口失焦都撤销草稿，不提交拖动')

  await beginBoardDrag(boardCard)
  const boardBeforeDelete = operationCount('board')
  remote('board', boardCreate.elementId, 'CARD', { '#tombstone': true })
  await boardCard.waitFor({ state: 'detached' })
  await page.mouse.up()
  await settled()
  assert.equal(operationCount('board'), boardBeforeDelete)
  assert.equal(values('board', boardCreate.elementId)['#tombstone'], true)
  const [afterDelete] = await actionOperations('board', () =>
    page.getByRole('button', { name: '添加卡片', exact: true }).click(),
  )
  boardCard = page.locator(`[data-card-id="${afterDelete.elementId}"]`)
  await beginBoardDrag(boardCard)
  await actionOperations(
    'board',
    async () => {
      permission('board', false)
      await page.waitForFunction(() => !!document.querySelector('.readonly-strip'))
      await page.mouse.up()
    },
    0,
  )
  assert.equal(await boardCard.evaluate((element) => element.classList.contains('dragging')), false)
  pass('白板拖动中被远端删除或撤销权限时立即取消，不崩溃、不复活内容')

  permission('board', true)
  await page.getByRole('button', { name: '添加卡片', exact: true }).waitFor()
  await beginBoardDrag(boardCard)
  await actionOperations(
    'board',
    async () => {
      await page
        .getByRole('button', { name: '返回工作台', exact: true })
        .evaluate((element) => element.click())
      await page.locator('.dashboard-shell').waitFor()
      await page.mouse.up()
    },
    0,
  )
  pass('离开白板时取消未完成拖动且不发送额外修改')

  await goto('kanban')
  const [firstColumn] = await actionOperations('kanban', () =>
    page.locator('.kanban-tools').getByRole('button', { name: '添加列表', exact: true }).click(),
  )
  assert.deepEqual(firstColumn.value, { title: '新列表 1', order: 1024 })
  let firstColumnElement = page.locator(`[data-column-id="${firstColumn.elementId}"]`)
  await focused(firstColumnElement.getByRole('textbox', { name: '列表标题', exact: true }))
  assert.equal(
    await firstColumnElement
      .getByRole('textbox', { name: '列表标题', exact: true })
      .evaluate((element) => element.selectionEnd - element.selectionStart),
    '新列表 1'.length,
  )
  const [secondColumn] = await actionOperations('kanban', () =>
    page.locator('.kanban-tools').getByRole('button', { name: '添加列表', exact: true }).click(),
  )
  assert.equal(secondColumn.value.title, '新列表 2')
  const secondColumnElement = page.locator(`[data-column-id="${secondColumn.elementId}"]`)
  const secondTitle = secondColumnElement.getByRole('textbox', { name: '列表标题', exact: true })
  await secondTitle.fill('  待验收  ')
  remote('kanban', secondColumn.elementId, 'COLUMN', { order: 2500, note: '其他成员调整顺序' })
  await settled()
  assert.equal(await secondTitle.inputValue(), '  待验收  ')
  const [renamedColumn] = await actionOperations('kanban', () => secondTitle.press('Enter'))
  assert.equal(renamedColumn.value.title, '待验收')
  assert.equal(renamedColumn.value.order, 2500)
  assert.equal(renamedColumn.value.note, '其他成员调整顺序')
  await secondTitle.fill('放弃这个标题')
  await actionOperations('kanban', () => secondTitle.press('Escape'), 0)
  assert.equal(await secondTitle.inputValue(), '待验收')
  pass('列表标题草稿不被远端排序打断，Enter 保存去除首尾空白，Esc 恢复服务器标题')
  const [kanbanCreate] = await actionOperations('kanban', () =>
    firstColumnElement.getByRole('button', { name: '添加卡片', exact: true }).click(),
  )
  assert.deepEqual(kanbanCreate.value, {
    column: firstColumn.elementId,
    order: 1024,
    text: '',
    color: '#ffffff',
  })
  let kanbanCard = page.locator(`[data-card-id="${kanbanCreate.elementId}"]`)
  await focused(kanbanCard.getByRole('textbox', { name: '任务卡片内容', exact: true }))
  await kanbanCard.getByRole('textbox', { name: '任务卡片内容', exact: true }).fill('任务原内容')
  pass('看板列表和任务各一次完整创建，列表从 1 正确编号，新建后自动聚焦输入')

  const [moved] = await actionOperations('kanban', () =>
    kanbanCard.getByRole('button', { name: '移到下一列表', exact: true }).click(),
  )
  assert.equal(moved.value.column, secondColumn.elementId)
  assert.equal(moved.value.text, '任务原内容')
  await secondColumnElement.locator(`[data-card-id="${kanbanCreate.elementId}"]`).waitFor()
  const [cover] = await actionOperations('kanban', () =>
    kanbanCard
      .locator('input[type="file"]')
      .setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: tinyPng }),
  )
  assert.equal(cover.value.coverId, 'quality-image-1')
  assert.equal(cover.value.coverName, '图片 1.png')
  assert.equal(cover.value.text, '任务原内容')
  const [removeCover] = await actionOperations('kanban', () =>
    kanbanCard.getByRole('button', { name: '移除封面', exact: true }).click(),
  )
  assert.equal(removeCover.value.coverId, null)
  assert.equal(removeCover.value.coverName, null)
  assert.equal(removeCover.value.coverUrl, null)
  assert.equal(removeCover.value.column, secondColumn.elementId)
  pass('跨列移动、上传与移除封面各一次提交，保留任务文本和全部业务字段')

  await beginKanbanDrag(kanbanCard, firstColumnElement)
  remote('kanban', kanbanCreate.elementId, 'CARD', {
    text: '拖动期间远端修改',
    coverId: 'remote-cover',
    coverName: '远端封面.png',
  })
  await settled()
  const [dragged] = await actionOperations('kanban', () => page.mouse.up())
  assert.equal(dragged.value.column, firstColumn.elementId)
  assert.equal(dragged.value.text, '拖动期间远端修改')
  assert.equal(dragged.value.coverId, 'remote-cover')
  pass('看板拖动在放下时读取最新任务，保留远端修改的文本与封面')

  await checkComposition(
    'kanban',
    kanbanCreate.elementId,
    kanbanCard.getByRole('textbox', { name: '任务卡片内容', exact: true }),
  )
  pass('看板中文组合输入保持本地草稿，完成后仅一次提交完整任务')

  for (const cancel of ['Escape', 'pointercancel', 'blur', 'outside']) {
    const before = values('kanban', kanbanCreate.elementId)
    await beginKanbanDrag(kanbanCard, secondColumnElement)
    await actionOperations(
      'kanban',
      async () => {
        if (cancel === 'Escape') await page.keyboard.press('Escape')
        else if (cancel === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')))
        else if (cancel === 'outside') await page.mouse.move(10, 10)
        else
          await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 })))
        await page.mouse.up()
      },
      0,
    )
    assert.deepEqual(values('kanban', kanbanCreate.elementId), before)
    assert.equal(await page.evaluate(() => document.body.classList.contains('kanban-dragging')), false)
  }
  pass('看板 Esc、指针取消、窗口失焦及放到列外均不提交，拖动状态正确清理')

  await beginKanbanDrag(kanbanCard, secondColumnElement)
  const beforeRemoteDelete = operationCount('kanban')
  remote('kanban', kanbanCreate.elementId, 'CARD', { '#tombstone': true })
  await kanbanCard.waitFor({ state: 'detached' })
  await page.mouse.up()
  await settled()
  assert.equal(operationCount('kanban'), beforeRemoteDelete)
  const [nextCard] = await actionOperations('kanban', () =>
    firstColumnElement.getByRole('button', { name: '添加卡片', exact: true }).click(),
  )
  kanbanCard = page.locator(`[data-card-id="${nextCard.elementId}"]`)
  await beginKanbanDrag(kanbanCard, secondColumnElement)
  await actionOperations(
    'kanban',
    async () => {
      permission('kanban', false)
      await page.waitForFunction(() => !!document.querySelector('.readonly-strip'))
      await page.mouse.up()
    },
    0,
  )
  assert.equal(await page.evaluate(() => document.body.classList.contains('kanban-dragging')), false)
  pass('看板拖动中远端删除任务或撤销权限均取消，不发送复活或越权写入')

  permission('kanban', true)
  await kanbanCard.getByRole('button', { name: '拖动卡片', exact: true }).waitFor()
  await beginKanbanDrag(kanbanCard, secondColumnElement)
  await actionOperations(
    'kanban',
    async () => {
      await page
        .getByRole('button', { name: '返回工作台', exact: true })
        .evaluate((element) => element.click())
      await page.locator('.dashboard-shell').waitFor()
      await page.mouse.up()
    },
    0,
  )
  assert.equal(await page.evaluate(() => document.body.classList.contains('kanban-dragging')), false)
  pass('离开看板时只取消拖动，移除全局监听和页面拖动状态')

  await goto('kanban')
  kanbanCard = page.locator(`[data-card-id="${nextCard.elementId}"]`)
  holdNextUpload = true
  const beforeUpload = operationCount('kanban')
  await kanbanCard
    .locator('input[type="file"]')
    .setInputFiles({ name: 'late-cover.png', mimeType: 'image/png', buffer: tinyPng })
  await waitUntil(() => heldUpload)
  remote('kanban', nextCard.elementId, 'CARD', { '#tombstone': true })
  await kanbanCard.waitFor({ state: 'detached' })
  heldUpload()
  await waitUntil(() => !heldUpload)
  await settled()
  assert.equal(operationCount('kanban'), beforeUpload)
  assert.equal(values('kanban', nextCard.elementId)['#tombstone'], true)
  pass('图片上传过程中任务被远端删除，迟到的上传结果不会重建任务')

  await goto('board')
  await page.locator('.board-scroll').evaluate((element) => {
    element.scrollLeft = 180
    element.scrollTop = 100
  })
  const viewportScroll = await page
    .locator('.board-scroll')
    .evaluate((element) => ({ x: element.scrollLeft, y: element.scrollTop }))
  const canvasBox = await page.locator('.board-canvas').boundingBox()
  const scrollBox = await page.locator('.board-scroll').boundingBox()
  const clickPoint = { x: scrollBox.x + 420, y: scrollBox.y + 360 }
  const [atPointer] = await actionOperations('board', () => page.mouse.dblclick(clickPoint.x, clickPoint.y))
  assert.equal(atPointer.value.x, Math.round(clickPoint.x - canvasBox.x))
  assert.equal(atPointer.value.y, Math.round(clickPoint.y - canvasBox.y))
  assert.ok(atPointer.value.x > viewportScroll.x)
  const [newImage] = await actionOperations('board', () =>
    page
      .locator('.board-tools input[type="file"][aria-label="插入图片"]')
      .setInputFiles({ name: 'board.png', mimeType: 'image/png', buffer: tinyPng }),
  )
  let imageCard = page.locator(`[data-card-id="${newImage.elementId}"]`)
  await imageCard.waitFor()
  assert.ok(newImage.value.assetId)
  const beforeReplacement = operationCount('board')
  holdNextUpload = true
  await page
    .locator('.board-tools input[type="file"][aria-label="替换图片"]')
    .setInputFiles({ name: 'board-new.png', mimeType: 'image/png', buffer: tinyPng })
  await waitUntil(() => heldUpload)
  remote('board', newImage.elementId, 'IMAGE', {
    x: 460,
    y: 280,
    w: 400,
    h: 300,
    z: 75,
    note: '图片替换期间移动',
  })
  await settled()
  heldUpload()
  await waitUntil(() => operationCount('board') === beforeReplacement + 1)
  const replacement = documents.board.operations.at(-1)
  assert.equal(replacement.elementId, newImage.elementId)
  assert.equal(replacement.value.x, 460)
  assert.equal(replacement.value.y, 280)
  assert.equal(replacement.value.w, 400)
  assert.equal(replacement.value.h, 300)
  assert.equal(replacement.value.z, 75)
  assert.equal(replacement.value.note, '图片替换期间移动')
  assert.notEqual(replacement.value.assetId, newImage.value.assetId)
  pass('白板双击在实际位置创建卡片，替换图片保留上传期间远端调整的位置、大小与层级')

  const [topCard] = await actionOperations('board', () =>
    page.getByRole('button', { name: '添加卡片', exact: true }).click(),
  )
  assert.equal(topCard.value.z, 76)
  const currentScroll = await page
    .locator('.board-scroll')
    .evaluate((element) => ({ x: element.scrollLeft, y: element.scrollTop }))
  assert.ok(topCard.value.x >= currentScroll.x && topCard.value.y >= currentScroll.y)
  pass('白板新增卡片出现在当前视口且层级高于已有内容，避免被已置顶的图片遮住')

  await imageCard.locator('.board-card-top').click({ position: { x: 100, y: 12 } })
  holdNextUpload = true
  const beforeDeletedImageUpload = operationCount('board')
  await page
    .locator('.board-tools input[type="file"][aria-label="替换图片"]')
    .setInputFiles({ name: 'deleted-board-image.png', mimeType: 'image/png', buffer: tinyPng })
  await waitUntil(() => heldUpload)
  remote('board', newImage.elementId, 'IMAGE', { '#tombstone': true })
  await imageCard.waitFor({ state: 'detached' })
  heldUpload()
  await waitUntil(() => !heldUpload)
  await settled()
  assert.equal(operationCount('board'), beforeDeletedImageUpload)
  assert.equal(values('board', newImage.elementId)['#tombstone'], true)
  pass('白板替换图片过程中远端删除，不会因迟到上传结果复活图片')

  await goto('kanban')

  await page.setViewportSize({ width: 390, height: 844 })
  await waitForLayout()
  await page.screenshot({ path: path.join(out, 'kanban-mobile.png'), fullPage: true })
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    'Mobile page must not overflow the viewport',
  )
  await page.setViewportSize({ width: 1440, height: 960 })
  await waitForLayout()
  await page.screenshot({ path: path.join(out, 'kanban-desktop.png'), fullPage: true })
  await goto('board')
  await page.screenshot({ path: path.join(out, 'board-desktop.png'), fullPage: true })
  await goto('doc')
  await page.screenshot({ path: path.join(out, 'document-desktop.png'), fullPage: true })
  const responsiveParagraph = page.locator('[data-paragraph-id]').first()
  const longText =
    '这是一段用于验证窄屏自动换行的真实正文。改变窗口宽度之后，所有文本都应该完整显示，而不是裁掉末尾几行。'.repeat(
      4,
    )
  await responsiveParagraph.fill(longText)
  await page.setViewportSize({ width: 320, height: 844 })
  await waitForLayout()
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-paragraph-id]')].every(
      (element) => element.scrollHeight <= element.clientHeight + 1,
    ),
  )
  await page.screenshot({ path: path.join(out, 'document-mobile-320.png'), fullPage: true })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
  const narrowHeight = await responsiveParagraph.evaluate((element) => element.clientHeight)
  const responsiveId = await responsiveParagraph.getAttribute('data-paragraph-id')
  remote('doc', responsiveId, 'TEXT', { text: `${longText}\n远端新段落也需要自动增加高度。`.repeat(2) })
  await page.waitForFunction((id) => {
    const element = document.querySelector(`[data-paragraph-id="${CSS.escape(id)}"]`)
    return element && element.scrollHeight <= element.clientHeight + 1
  }, responsiveId)
  await page.setViewportSize({ width: 1440, height: 960 })
  await waitForLayout()
  await page.waitForFunction(
    ({ id, previousHeight }) => {
      const element = document.querySelector(`[data-paragraph-id="${CSS.escape(id)}"]`)
      return (
        element && element.scrollHeight <= element.clientHeight + 1 && element.clientHeight < previousHeight
      )
    },
    { id: responsiveId, previousHeight: narrowHeight },
  )
  pass('文档在 320 像素窄屏、远端长文本更新与恢复桌面时自动伸缩，每一行均完整显示')
  assert.deepEqual(errors, [])
  assert.ok(
    apiRequests.every(
      (request) =>
        request.startsWith('GET ') ||
        /POST \/api\/docs\/editor-quality-(kanban|board)\/images$/.test(request),
    ),
  )
  pass('桌面与手机编辑器可用，浏览器无脚本错误，所有 API 和连接均为模拟')
  await fs.writeFile(
    path.join(out, 'summary.json'),
    JSON.stringify({ status: 'passed', checks, errors, apiRequests }, null, 2),
  )
} catch (error) {
  await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true })
  await fs.writeFile(
    path.join(out, 'summary.json'),
    JSON.stringify({ status: 'failed', checks, errors, error: String(error) }, null, 2),
  )
  throw error
} finally {
  heldUpload?.()
  await browser.close()
}
