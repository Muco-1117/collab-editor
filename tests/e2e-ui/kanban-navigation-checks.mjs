import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

// All API/WS traffic is simulated. No real users, content, or databases change.
const base = process.env.E2E_BASE_URL || 'http://localhost:5173'
const out = path.resolve(process.env.E2E_OUTPUT_DIR || 'artifacts/round2-20261022/kanban-navigation')
await fs.mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
page.setDefaultTimeout(10_000)
const checks = [],
  errors = [],
  operations = [],
  apiRequests = []
const pass = (label) => {
  checks.push(label)
  console.log('PASS', label)
}
page.on('pageerror', (error) => errors.push(error.message))
const user = { id: 99431, username: 'kanban_navigation_check', nickname: '看板交互检查', avatarUrl: '' }
const metadata = {
  doc_key: 'kanban-navigation-check',
  kind: 'kanban',
  title: '协作工作台迭代计划',
  space_id: 99431,
  space_name: '产品设计空间',
  my_role: 'owner',
}
let clock = 1,
  revision = 1,
  role = 'owner',
  writable = true,
  holdWelcome = false,
  socket
const heldSockets = new Set()
const elements = new Map()
const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfZkAAAAASUVORK5CYII=',
  'base64',
)

function snapshot(id, type, values, timestamp = 'seed:1', opId = 'seed') {
  return {
    id,
    type,
    rootClock: timestamp,
    fields: {
      ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, clock: timestamp }])),
      '#version': { value: opId, clock: timestamp },
    },
  }
}
function values(id) {
  return Object.fromEntries(
    Object.entries(elements.get(id)?.fields || {})
      .filter(([key]) => key !== '#version')
      .map(([key, field]) => [key, field.value]),
  )
}
function remote(id, type, changes) {
  const op = {
    type: 'STATE',
    elementId: id,
    elementType: type,
    value: { ...values(id), ...changes },
    clock: `kanban-remote:${++clock}`,
    opId: `remote-${clock}`,
  }
  elements.set(id, snapshot(id, type, op.value, op.clock, op.opId))
  socket.send(JSON.stringify({ type: 'applied', rev: ++revision, op }))
}
function welcome(target) {
  target.send(
    JSON.stringify({
      type: 'welcome',
      rev: revision,
      role,
      canWrite: writable,
      snapshot: [...elements.values()],
    }),
  )
}
function access(nextRole, canWrite = nextRole !== 'viewer') {
  role = nextRole
  writable = canWrite
  socket.send(JSON.stringify({ type: 'access', role, canWrite }))
}
const titles = ['待梳理', '设计中', '评审', '开发中', '待验证', '评审', '已归档']
for (const [index, title] of titles.entries())
  elements.set(
    `column-${index + 1}`,
    snapshot(`column-${index + 1}`, 'COLUMN', { title, order: (index + 1) * 1024 }),
  )
elements.set(
  'task-main',
  snapshot('task-main', 'CARD', {
    column: 'column-1',
    order: 1024,
    text: '完善内容工作台\n明确每个页面的使用场景',
    color: '#e2edff',
    coverId: 'plan-cover',
    coverName: '协作草图.png',
    coverUrl: '/api/assets/plan-cover',
  }),
)
elements.set(
  'task-peer',
  snapshot('task-peer', 'CARD', { column: 'column-1', order: 2048, text: '补充交互说明', color: '#fff1c9' }),
)
elements.set(
  'task-review',
  snapshot('task-review', 'CARD', {
    column: 'column-3',
    order: 1024,
    text: '检查页面层级',
    color: '#ffffff',
  }),
)
for (let i = 1; i <= 7; i++)
  elements.set(
    `task-archive-${i}`,
    snapshot(`task-archive-${i}`, 'CARD', {
      column: 'column-7',
      order: i * 1024,
      text: `已完成的协作事项 ${i}`,
      color: i % 2 ? '#ffffff' : '#dff3e5',
    }),
  )

await page.addInitScript(() => localStorage.setItem('collab_access_token', 'kanban-navigation-mock'))
await page.route('**/api/**', async (route) => {
  const request = route.request(),
    url = new URL(request.url())
  apiRequests.push(`${request.method()} ${url.pathname}`)
  let result
  if (url.pathname === '/api/auth/me') result = user
  else if (url.pathname === '/api/docs') result = [metadata]
  else if (url.pathname === '/api/docs/kanban-navigation-check') result = metadata
  else if (url.pathname.startsWith('/api/assets/'))
    return route.fulfill({ status: 200, contentType: 'image/png', body: tinyPng })
  else throw new Error(`Unexpected mock request ${request.method()} ${url.pathname}`)
  await route.fulfill({ json: result })
})
await page.routeWebSocket(/\/ws(?:\?|\/|$)/, (ws) => {
  socket = ws
  ws.onMessage((raw) => {
    const message = JSON.parse(String(raw))
    if (message.type === 'hello') {
      if (holdWelcome) heldSockets.add(ws)
      else welcome(ws)
    } else if (message.type === 'op') {
      assert.ok(writable && role !== 'viewer')
      operations.push(message.op)
      clock = Math.max(clock, Number(message.op.clock.split(':').at(-1)))
      elements.set(
        message.op.elementId,
        snapshot(
          message.op.elementId,
          message.op.elementType,
          message.op.value,
          message.op.clock,
          message.op.opId,
        ),
      )
      ws.send(JSON.stringify({ type: 'applied', rev: ++revision, op: message.op }))
    } else if (message.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }))
  })
  ws.onClose(() => heldSockets.delete(ws))
})

async function settle() {
  await page.waitForTimeout(100)
}
async function waitUntil(check) {
  const end = Date.now() + 6000
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Condition not met')
}
async function action(callback, expected = 1) {
  const before = operations.length
  await callback()
  if (expected) await waitUntil(() => operations.length >= before + expected)
  await settle()
  const sent = operations.slice(before)
  assert.equal(sent.length, expected)
  assert.ok(sent.every((op) => op.type === 'STATE'))
  return sent
}
function card(id = 'task-main') {
  return page.locator(`[data-card-id="${id}"]`)
}
function moveSelect(id = 'task-main') {
  return card(id).getByRole('combobox', { name: '移至列表', exact: true })
}
const jumpSelect = () => page.getByRole('combobox', { name: '跳转列表', exact: true })
async function globalPosition() {
  return page.evaluate(() => ({
    x: scrollX,
    y: scrollY,
    documentX: document.documentElement.scrollLeft,
    documentY: document.documentElement.scrollTop,
    mainTop: document.querySelector('.workspace-main')?.scrollTop || 0,
  }))
}
async function assertColumnVisible(id) {
  const viewport = await page.locator('.kanban-scroll').boundingBox()
  const column = await page.locator(`[data-column-id="${id}"]`).boundingBox()
  assert.ok(
    column.x >= viewport.x - 1 && column.x + column.width <= viewport.x + viewport.width + 1,
    `Column ${id} inside board viewport`,
  )
}
async function focused(selector) {
  await page.waitForFunction(
    (selector) => document.activeElement === document.querySelector(selector),
    selector,
  )
}
async function screenshot(name) {
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true, animations: 'disabled' })
}

try {
  await page.goto(`${base}/#/work/kanban/kanban-navigation-check`)
  await moveSelect().waitFor()
  await page.waitForFunction(() => !document.querySelector('.offline-strip'))
  assert.equal(await moveSelect().inputValue(), 'column-1')
  assert.equal(await jumpSelect().locator('option').count(), 8)
  assert.equal(
    await jumpSelect()
      .locator('option[value="column-3"]')
      .textContent()
      .then((value) => value.trim()),
    '3. 评审（1 项）',
  )
  assert.equal(
    await jumpSelect()
      .locator('option[value="column-6"]')
      .textContent()
      .then((value) => value.trim()),
    '6. 评审（0 项）',
  )
  await screenshot('kanban-desktop')
  pass('每张卡片具备任意列表移动，列表导航展示真实数量，同名列表通过序号区分')

  await action(() => moveSelect().selectOption('column-1'), 0)
  await action(async () => {
    await moveSelect().focus()
    await page.keyboard.press('Escape')
  }, 0)
  const beforeGlobal = await globalPosition()
  const [moved] = await action(() => moveSelect().selectOption('column-7'))
  assert.equal(moved.elementId, 'task-main')
  assert.equal(moved.value.column, 'column-7')
  assert.equal(moved.value.order, 8192)
  assert.equal(moved.value.text, '完善内容工作台\n明确每个页面的使用场景')
  assert.equal(moved.value.color, '#e2edff')
  assert.equal(moved.value.coverId, 'plan-cover')
  assert.equal(moved.value.coverName, '协作草图.png')
  assert.equal(moved.value.coverUrl, '/api/assets/plan-cover')
  await focused('[data-card-id="task-main"] .kanban-card-destination select')
  await assertColumnVisible('column-7')
  const cardBounds = await card().boundingBox()
  const listBounds = await page.locator('[data-column-id="column-7"] .kanban-cards').boundingBox()
  assert.ok(
    cardBounds.y >= listBounds.y - 1 &&
      cardBounds.y + cardBounds.height <= listBounds.y + listBounds.height + 1,
    `Moved card ${JSON.stringify(cardBounds)} inside list ${JSON.stringify(listBounds)}`,
  )
  assert.deepEqual(await globalPosition(), beforeGlobal)
  pass('一次从第一列移至第七列，只提交一个完整STATE，追加目标末尾并跟随卡片和焦点，页面不滚动')

  await moveSelect().focus()
  remote('task-main', 'CARD', {
    text: '伙伴刚补充的完整任务',
    color: '#fff1c9',
    coverId: 'latest-cover',
    coverName: '最新封面.png',
    coverUrl: '/api/assets/latest-cover',
  })
  await page.waitForFunction(
    () => document.querySelector('[data-card-id="task-main"] textarea').value === '伙伴刚补充的完整任务',
  )
  const [merged] = await action(() => moveSelect().selectOption('column-6'))
  assert.equal(merged.value.column, 'column-6')
  assert.equal(merged.value.order, 1024)
  assert.equal(merged.value.text, '伙伴刚补充的完整任务')
  assert.equal(merged.value.color, '#fff1c9')
  assert.equal(merged.value.coverId, 'latest-cover')
  assert.equal(merged.value.coverName, '最新封面.png')
  assert.equal(merged.value.coverUrl, '/api/assets/latest-cover')
  await focused('[data-card-id="task-main"] .kanban-card-destination select')
  const [keyMoved] = await action(() => page.keyboard.press('ArrowUp'))
  assert.equal(keyMoved.value.column, 'column-5')
  await focused('[data-card-id="task-main"] .kanban-card-destination select')
  pass('打开移动选择后收到远端修改，提交使用最新文字颜色封面；键盘方向键可移动并保留焦点')

  const unchanged = await globalPosition()
  await action(() => jumpSelect().selectOption('column-1'), 0)
  await assertColumnVisible('column-1')
  await action(() => jumpSelect().selectOption('column-7'), 0)
  await assertColumnVisible('column-7')
  assert.deepEqual(await globalPosition(), unchanged)
  assert.equal(await jumpSelect().inputValue(), '')
  await jumpSelect().focus()
  await action(() => page.keyboard.press('End'), 0)
  await assertColumnVisible('column-7')
  await focused('.kanban-column-navigation select')
  pass('跳转列表只滚动看板容器，可重复选择及键盘操作，始终不发编辑操作')

  remote('column-6', 'COLUMN', { title: '复盘与总结' })
  remote('column-extra', 'COLUMN', { title: '预备工作', order: 8192 })
  await jumpSelect().locator('option[value="column-extra"]').waitFor({ state: 'attached' })
  assert.match(await jumpSelect().locator('option[value="column-6"]').textContent(), /复盘与总结/)
  await action(() => jumpSelect().selectOption('column-extra'), 0)
  await assertColumnVisible('column-extra')
  const unchangedCard = { ...values('task-main') }
  await action(async () => {
    remote('column-extra', 'COLUMN', { '#tombstone': true })
    await jumpSelect().locator('option[value="column-extra"]').waitFor({ state: 'detached' })
    // A stale native select event may arrive after the remote option disappears.
    await moveSelect().evaluate((element) => {
      const stale = document.createElement('option')
      stale.value = 'column-extra'
      element.append(stale)
      element.value = stale.value
      element.dispatchEvent(new Event('change', { bubbles: true }))
      stale.remove()
    })
  }, 0)
  assert.deepEqual(values('task-main'), unchangedCard)
  assert.equal(await moveSelect().inputValue(), 'column-5')
  pass('导航同步远端新增、改名和删除，迟到的已删除目标选择不会制造孤儿卡片')

  remote('task-second', 'CARD', { column: 'column-5', order: 2048, text: '另一张任务', color: '#ffffff' })
  await card('task-second').waitFor()
  await action(() => moveSelect().selectOption('column-5'), 0)
  assert.equal(values('task-main').order, 1024)
  await action(() => moveSelect('task-second').selectOption('column-7'))
  assert.equal(values('task-second').order, 8192)
  await action(() => moveSelect().selectOption('column-7'))
  assert.equal(values('task-main').order, 9216)
  const ids = await page
    .locator('[data-column-id="column-7"] .kanban-card')
    .evaluateAll((cards) => cards.map((card) => card.dataset.cardId))
  assert.deepEqual(ids.slice(-2), ['task-second', 'task-main'])
  pass('选回当前列不会改变排序，多张卡片连续移入目标按末尾顺序稳定追加')

  await action(async () => {
    access('owner', false)
    await waitUntil(() => moveSelect().isDisabled())
    await moveSelect().evaluate((element) => {
      element.value = 'column-1'
      element.dispatchEvent(new Event('change', { bubbles: true }))
    })
    assert.equal(await moveSelect().inputValue(), 'column-7')
    await jumpSelect().selectOption('column-1')
  }, 0)
  await action(async () => {
    access('viewer', false)
    await moveSelect().waitFor({ state: 'detached' })
    assert.equal(await page.getByRole('combobox', { name: '移至列表', exact: true }).count(), 0)
    await jumpSelect().selectOption('column-6')
    await assertColumnVisible('column-6')
  }, 0)
  pass('撤回写权限立即禁用移动，只读角色隐藏移动入口，查看者仍可跳转列表且无写操作')

  access('owner', true)
  await moveSelect().waitFor()
  await waitUntil(() => moveSelect().isEnabled())
  holdWelcome = true
  socket.close({ code: 1012, reason: 'mock network interruption' })
  await action(async () => {
    await waitUntil(() => moveSelect().isDisabled())
    await jumpSelect().selectOption('column-7')
    await assertColumnVisible('column-7')
  }, 0)
  await waitUntil(() => heldSockets.size > 0)
  holdWelcome = false
  for (const target of heldSockets) welcome(target)
  heldSockets.clear()
  await waitUntil(() => moveSelect().isEnabled())
  pass('失联时移动控件保持禁用，现有列表仍可导航，重连后恢复编辑')

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    await page.evaluate(async () =>
      Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))),
    )
    await action(() => jumpSelect().selectOption('column-7'), 0)
    await assertColumnVisible('column-7')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    const controlBounds = await jumpSelect().boundingBox()
    assert.ok(controlBounds.x >= 0 && controlBounds.x + controlBounds.width <= width + 1)
    const control = await moveSelect().boundingBox()
    const column = await page.locator('[data-column-id="column-7"]').boundingBox()
    assert.ok(control.x >= column.x && control.x + control.width <= column.x + column.width)
    const board = await page.locator('.kanban-scroll').boundingBox()
    assert.ok(column.y + column.height <= board.y + board.height + 1)
    await screenshot(`kanban-${width}`)
    await action(() => moveSelect().selectOption('column-2'))
    await assertColumnVisible('column-2')
    await focused('[data-card-id="task-main"] .kanban-card-destination select')
    await action(() => moveSelect().selectOption('column-7'))
    const movedControl = await moveSelect().boundingBox()
    const movedList = await page.locator('[data-column-id="column-7"] .kanban-cards').boundingBox()
    assert.ok(
      movedControl.y >= movedList.y && movedControl.y + movedControl.height <= movedList.y + movedList.height,
    )
    await screenshot(`kanban-moved-${width}`)
  }
  pass('390px和320px导航和卡片控件完整，长列表只在内部滚动，跨远端列后视口跟随且页面不溢出')

  assert.deepEqual(errors, [])
  assert.ok(apiRequests.every((request) => request.startsWith('GET ')))
  await fs.writeFile(
    path.join(out, 'summary.json'),
    JSON.stringify(
      { status: 'passed', checks, errors, operationCount: operations.length, apiRequests },
      null,
      2,
    ),
  )
} catch (error) {
  await screenshot('failure')
  await fs.writeFile(
    path.join(out, 'summary.json'),
    JSON.stringify({ status: 'failed', checks, errors, error: String(error) }, null, 2),
  )
  throw error
} finally {
  await browser.close()
}
