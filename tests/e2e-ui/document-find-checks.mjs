import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

// Uses the real Vue document editor with fixture metadata and websocket state.
// No API or collaboration requests reach real accounts or data.
const base = process.env.E2E_BASE_URL || 'http://localhost:5173'
const out = path.resolve(process.env.E2E_OUTPUT_DIR || 'artifacts/round2-20261022/document-find')
await fs.mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
page.setDefaultTimeout(12_000)
const checks = []
const errors = []
const requests = []
const operations = []
const sockets = new Set()
const user = { id: 99620, username: 'document_find_check', nickname: '正文查找验证', avatarUrl: '' }
const metadata = {
  doc_key: 'document-find-check',
  title: '跨专业协作项目计划',
  kind: 'doc',
  space_id: 99620,
  space_name: '文档查找检查空间',
  my_role: 'owner',
}
let revision = 1
let clock = 1
let role = 'owner'
const element = (id, text, order, extra = {}) => ({
  id,
  type: 'TEXT',
  rootClock: 'seed:1',
  fields: {
    text: { value: text, clock: 'seed:1' },
    order: { value: order, clock: 'seed:1' },
    '#version': { value: 'seed', clock: 'seed:1' },
    ...extra,
  },
})
const elements = new Map([
  ['first', element('first', '😀İ 前文Vue vue；关键词 [a+b]* 应按字面查找。', 1024)],
  ...Array.from({ length: 16 }, (_, index) => {
    const id = `body-${index}`
    return [
      id,
      element(
        id,
        `第 ${index + 1} 阶段：共同梳理研究目标、讨论实际使用场景，并记录协作中的关键决定。每位成员都能补充建议，项目进度与内容保存在同一工作台。`,
        (index + 2) * 1024,
      ),
    ]
  }),
  ['last', element('last', '最终验收：VUE 文档查找应能快速定位到这里。', 30 * 1024)],
  [
    'deleted',
    element('deleted', 'Vue 已删除内容不会出现在查找结果里。', 31 * 1024, {
      '#tombstone': { value: true, clock: 'seed:1' },
    }),
  ],
])
const pass = (label) => {
  checks.push(label)
  console.log('PASS', label)
}
page.on('pageerror', (error) => errors.push(error.message))
await page.addInitScript(() => {
  localStorage.setItem('collab_access_token', 'document-find-mock')
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      queueMicrotask(() => {
        window.__findKeyPrevented = event.defaultPrevented
      })
    }
  })
})
await page.route('**/api/**', async (route) => {
  const request = route.request()
  const url = new URL(request.url())
  requests.push({ path: url.pathname, method: request.method() })
  assert.equal(request.method(), 'GET')
  if (url.pathname === '/api/auth/me') return route.fulfill({ json: { user } })
  if (url.pathname === '/api/docs') return route.fulfill({ json: [metadata] })
  if (url.pathname === '/api/docs/document-find-check') return route.fulfill({ json: metadata })
  if (url.pathname.endsWith('/history')) return route.fulfill({ json: { rev: revision, ops: [] } })
  if (url.pathname.endsWith('/replay'))
    return route.fulfill({ json: { rev: revision, elements: [...elements.values()] } })
  throw new Error(`Unexpected API request: ${url.pathname}`)
})
await page.routeWebSocket(/\/ws\/collab/, (socket) => {
  sockets.add(socket)
  socket.onClose(() => sockets.delete(socket))
  socket.onMessage((raw) => {
    const message = JSON.parse(String(raw))
    if (message.type === 'hello') {
      socket.send(
        JSON.stringify({
          type: 'welcome',
          rev: revision,
          role,
          canWrite: role !== 'viewer',
          snapshot: [...elements.values()],
        }),
      )
    } else if (message.type === 'op') {
      operations.push(message.op)
      apply(message.op)
    } else if (message.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }))
  })
})

function apply(op) {
  clock = Math.max(clock, Number(String(op.clock).split(':').at(-1)) || 0)
  elements.set(op.elementId, {
    id: op.elementId,
    type: op.elementType,
    rootClock: op.clock,
    fields: {
      ...Object.fromEntries(
        Object.entries(op.value).map(([name, value]) => [name, { value, clock: op.clock }]),
      ),
      '#version': { value: op.opId, clock: op.clock },
    },
  })
  revision += 1
  for (const socket of sockets) socket.send(JSON.stringify({ type: 'applied', rev: revision, op }))
}
function remote(id, changes) {
  const previous = elements.get(id)
  const values = Object.fromEntries(
    Object.entries(previous?.fields || {})
      .filter(([key]) => key !== '#version')
      .map(([key, field]) => [key, field.value]),
  )
  apply({
    type: 'STATE',
    elementId: id,
    elementType: 'TEXT',
    value: { ...values, ...changes },
    clock: `find-remote:${++clock}`,
    opId: `remote-${clock}`,
  })
}
const finder = () => page.getByRole('search', { name: '文档内查找', exact: true })
const query = () => finder().getByRole('searchbox', { name: '查找正文', exact: true })
const count = () => finder().locator('.document-find-count')
async function status(expected) {
  await page.waitForFunction(
    (expected) => document.querySelector('.document-find-count')?.textContent === expected,
    expected,
  )
}
async function selection(id) {
  return page
    .locator(`[data-paragraph-id="${id}"]`)
    .evaluate((field) => ({
      start: field.selectionStart,
      end: field.selectionEnd,
      text: field.value.slice(field.selectionStart, field.selectionEnd),
    }))
}
async function until(predicate) {
  const deadline = Date.now() + 6000
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Condition not met')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

try {
  await page.goto(`${base}/#/work/doc/document-find-check`)
  const first = page.locator('[data-paragraph-id="first"]')
  await first.waitFor()
  await first.focus()
  await first.evaluate((field) => field.setSelectionRange(3, 5))
  await page.keyboard.press('Control+f')
  await query().waitFor()
  assert.equal(await query().evaluate((field) => document.activeElement === field), true)
  await query().fill('vUe')
  await status('1 / 3')
  assert.deepEqual(await selection('first'), { start: 6, end: 9, text: 'Vue' })
  assert.equal(await query().evaluate((field) => document.activeElement === field), true)
  assert.equal(operations.length, 0)
  pass('Ctrl+F 打开真正的文档内查找，忽略大小写、已删除段落不计入，emoji 后匹配选区准确且输入焦点保留')

  await query().press('Enter')
  await status('2 / 3')
  assert.equal((await selection('first')).text, 'vue')
  await finder().getByRole('button', { name: '上一处', exact: true }).click()
  await status('1 / 3')
  await finder().getByRole('button', { name: '下一处', exact: true }).click()
  await status('2 / 3')
  await query().focus()
  await query().press('Enter')
  await status('3 / 3')
  assert.equal((await selection('last')).text, 'VUE')
  const lastVisible = await page.locator('[data-paragraph-id="last"]').evaluate((field) => {
    const bounds = field.getBoundingClientRect()
    const scroller = field.closest('.document-editor').getBoundingClientRect()
    return bounds.top >= scroller.top && bounds.bottom <= scroller.bottom
  })
  assert.equal(lastVisible, true)
  await query().press('Enter')
  await status('1 / 3')
  await query().press('Shift+Enter')
  await status('3 / 3')
  await page.screenshot({ path: path.join(out, 'find-last-desktop.png'), fullPage: true })
  pass('Enter / Shift+Enter 在匹配间循环，长文档自动滚动到对应段落且工具栏保持可用')

  await query().fill('[a+b]*')
  await status('1 / 1')
  assert.equal((await selection('first')).text, '[a+b]*')
  await query().fill('这里完全不存在')
  await status('0 处匹配')
  assert.equal(await finder().getByRole('button', { name: '上一处', exact: true }).isDisabled(), true)
  assert.equal(await finder().getByRole('button', { name: '下一处', exact: true }).isDisabled(), true)
  await query().fill('')
  await status('输入关键词')
  pass('正则特殊字符按字面匹配，零结果明确显示且禁用导航，清空查询恢复提示')

  await query().fill('Vue')
  await status('1 / 3')
  await query().evaluate((field) => {
    field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      key: 'Enter',
      isComposing: true,
      cancelable: true,
    })
    field.dispatchEvent(event)
    field.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'Escape', isComposing: true, cancelable: true }),
    )
  })
  assert.equal(await count().textContent(), '1 / 3')
  assert.equal(await finder().isVisible(), true)
  await query().evaluate((field) =>
    field.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })),
  )
  await query().press('Enter')
  await status('2 / 3')
  pass('中文输入法组合期间 Enter 不跳下一处、Escape 不关闭，组合完成后正常导航')

  const viewportBefore = await page.locator('.document-editor').evaluate((element) => element.scrollTop)
  remote('body-6', { text: '远端补充一个 Vue 匹配，不能打断当前输入。' })
  await status('2 / 4')
  assert.equal(await query().evaluate((field) => document.activeElement === field), true)
  assert.equal(
    await page.locator('.document-editor').evaluate((element) => element.scrollTop),
    viewportBefore,
  )
  await query().press('Enter')
  await status('3 / 4')
  assert.equal(
    await page.locator('.paragraph-find-current textarea').getAttribute('data-paragraph-id'),
    'body-6',
  )
  remote('body-6', { '#tombstone': true })
  await status('3 / 3')
  assert.equal(await query().evaluate((field) => document.activeElement === field), true)
  assert.equal(
    await page.locator('.paragraph-find-current textarea').getAttribute('data-paragraph-id'),
    'last',
  )
  await query().press('Enter')
  await status('1 / 3')
  pass('远端新增/删除实时更新结果与当前序号，不抢搜索焦点或主动滚动画面，删除当前命中后可继续循环')

  const originalFirst = elements.get('first').fields.text.value
  const originalLast = elements.get('last').fields.text.value
  remote('first', { text: '暂时移除所有命中，仅供浏览器检查。' })
  remote('last', { text: '远端同步后的新正文。' })
  await status('0 处匹配')
  assert.equal(await page.locator('.paragraph-find-current').count(), 0)
  assert.equal(await query().evaluate((field) => document.activeElement === field), true)
  remote('first', { text: originalFirst })
  remote('last', { text: originalLast })
  await status('1 / 3')
  pass('远端把全部匹配移除时显示真实零结果并移除高亮，恢复匹配后继续查找无需重开')

  await query().press('Escape')
  await finder().waitFor({ state: 'detached' })
  assert.equal(await first.evaluate((field) => document.activeElement === field), true)
  assert.deepEqual(await selection('first'), { start: 3, end: 5, text: ' 前' })
  await page.keyboard.press('Meta+f')
  await query().waitFor()
  await query().press('Escape')
  pass('Esc 关闭查找并恢复原编辑焦点和选区，Cmd+F 同样可打开')

  await page.getByRole('button', { name: '历史', exact: true }).click()
  const history = page.getByRole('dialog')
  await history.waitFor()
  await history.evaluate((element) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'f', ctrlKey: true })
    element.dispatchEvent(event)
    window.__findModalKeyPrevented = event.defaultPrevented
  })
  assert.equal(await page.evaluate(() => window.__findModalKeyPrevented), false)
  assert.equal(await finder().count(), 0)
  await page.keyboard.press('Escape')
  await history.waitFor({ state: 'detached' })
  pass('历史弹窗打开时不接管 Ctrl+F，也不会在模态层背后打开或抢焦点')

  await page.getByRole('button', { name: '查找正文', exact: true }).click()
  await query().fill('Vue')
  await status('1 / 3')
  for (const socket of sockets)
    socket.send(JSON.stringify({ type: 'access', role: 'viewer', canWrite: false }))
  role = 'viewer'
  await page.locator('.readonly-strip').waitFor()
  await query().press('Shift+Enter')
  await status('3 / 3')
  assert.equal(await page.locator('[data-paragraph-id="last"]').getAttribute('readonly'), '')
  assert.equal((await selection('last')).text, 'VUE')
  assert.equal(operations.length, 0)
  pass('只读成员仍能查找、定位和选择匹配，查找全过程不发送任何协同写入')

  await page.setViewportSize({ width: 320, height: 844 })
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})))
  })
  await query().press('Enter')
  await query().press('Shift+Enter')
  await status('3 / 3')
  await page.screenshot({ path: path.join(out, 'find-mobile-320.png'), fullPage: true })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
  const searchBox = await finder().boundingBox()
  assert.ok(searchBox.x >= 0 && searchBox.x + searchBox.width <= 321)
  await query().fill('x'.repeat(150))
  assert.equal((await query().inputValue()).length, 128)
  assert.equal(await query().getAttribute('maxlength'), '128')
  await query().fill('Vue')
  for (const socket of sockets) socket.send(JSON.stringify({ type: 'access', role: 'owner', canWrite: true }))
  role = 'owner'
  await page.locator('.readonly-strip').waitFor({ state: 'detached' })
  await page.locator('.document-editor').evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  const add = page.getByRole('button', { name: '添加段落', exact: true })
  const image = page.getByRole('button', { name: '插入图片', exact: true })
  assert.equal(await add.isVisible(), true)
  assert.equal(await image.isVisible(), true)
  assert.ok(
    (await add.boundingBox()).y > (await finder().boundingBox()).y + (await finder().boundingBox()).height,
  )
  await page.screenshot({ path: path.join(out, 'find-mobile-insert-actions.png'), fullPage: true })
  pass('320px 搜索栏自适应换行、关键词限制128字符，底部添加段落与插图入口可见且不被遮挡')

  await page.setViewportSize({ width: 1440, height: 960 })
  await query().press('Escape')
  await page.getByRole('button', { name: '添加段落', exact: true }).click()
  await until(() => operations.length === 1)
  const newId = operations[0].elementId
  const created = page.locator(`[data-paragraph-id="${newId}"]`)
  await created.fill('完成查找后仍能正常编辑新段落')
  await until(() => operations.length === 2)
  assert.equal(operations[1].value.text, '完成查找后仍能正常编辑新段落')
  pass('退出查找后添加段落和输入继续正常工作，新建与文字各发送一次完整STATE')

  assert.deepEqual(errors, [])
  await fs.writeFile(
    path.join(out, 'summary.json'),
    JSON.stringify({ status: 'passed', checks, errors, requests }, null, 2),
  )
} catch (error) {
  await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true })
  await fs.writeFile(
    path.join(out, 'summary.json'),
    JSON.stringify({ status: 'failed', checks, errors, error: String(error), requests }, null, 2),
  )
  throw error
} finally {
  await browser.close()
}
