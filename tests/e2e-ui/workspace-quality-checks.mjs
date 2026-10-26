import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const base = process.env.E2E_BASE_URL || 'http://localhost:5173'
const out = path.resolve(process.env.E2E_OUTPUT_DIR || 'artifacts/two-hour-20261022/workspace')
await fs.mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
const page = await context.newPage()
page.setDefaultTimeout(10_000)
const checks = [], errors = []
const pass = (label) => { checks.push(label); console.log('PASS', label) }
page.on('pageerror', (error) => errors.push(error.message))
const user = { id: 905001, username: 'workspace_quality', nickname: '协作检查', avatarUrl: '' }
const docs = [
  { doc_key: 'doc-a', title: '项目需求与设计说明', kind: 'doc' },
  { doc_key: 'doc-b', title: '团队会议记录', kind: 'doc' },
  { doc_key: 'board-a', title: '工作台交互流程', kind: 'board' },
  { doc_key: 'kanban-a', title: '本周迭代计划', kind: 'kanban' },
].map((row) => ({ ...row, space_id: 501, space_name: '项目协作空间', my_role: 'owner', updated_at: '2026-10-22T15:00:00' }))
const element = (id, type, values) => ({ id, type, rootClock: 'fixture:1', fields: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, clock: 'fixture:1' }])) })
const snapshots = {
  'doc-a': [element('paragraph-a', 'TEXT', { order: 100, text: '用一份文档记录团队的共同目标。' }), element('paragraph-b', 'TEXT', { order: 200, text: '把想法写下来，与伙伴一起完善。' })],
  'doc-b': [element('paragraph-c', 'TEXT', { order: 100, text: '今天的讨论与下一步行动。' })],
  'board-a': [element('note-a', 'CARD', { x: 56, y: 50, w: 220, h: 150, z: 1, color: '#fff1a8', text: '梳理用户需求' }), element('note-b', 'CARD', { x: 340, y: 115, w: 220, h: 150, z: 2, color: '#dcecff', text: '绘制协作流程' })],
  'kanban-a': [element('todo', 'COLUMN', { order: 100, title: '待开始' }), element('doing', 'COLUMN', { order: 200, title: '进行中' }), element('task-a', 'CARD', { column: 'todo', order: 100, text: '整理需求反馈', color: '#ffffff' }), element('task-b', 'CARD', { column: 'doing', order: 100, text: '完善协同体验', color: '#e2edff' })],
}
let failList = false, failMetadata = false, holdMetadata = false, metadataSeen, resolveMetadataSeen, releaseMetadata, metadataGate
let holdAcks = false, activeSocket, pendingAcks = [], revision = 10
await context.addInitScript(() => localStorage.setItem('collab_access_token', 'workspace-quality-mock'))
await context.route('**/api/**', async (route) => {
  const url = new URL(route.request().url())
  const fail = () => route.fulfill({ status: 503, json: { msg: '模拟网络中断' } })
  if (url.pathname === '/api/auth/me') return route.fulfill({ json: { user } })
  if (url.pathname === '/api/spaces') return route.fulfill({ json: [{ id: 501, name: '项目协作空间', my_role: 'owner', doc_count: 4 }] })
  if (url.pathname.endsWith('/members')) return route.fulfill({ json: { members: [user] } })
  if (url.pathname === '/api/stats') return route.fulfill({ json: { spaces: 1, documents: 4, operations: 10 } })
  if (url.pathname === '/api/docs') return failList ? fail() : route.fulfill({ json: docs })
  if (url.pathname.endsWith('/history')) return route.fulfill({ json: { rev: revision, ops: [] } })
  if (url.pathname.endsWith('/replay')) return route.fulfill({ json: { rev: Number(url.searchParams.get('rev')), elements: snapshots[url.pathname.split('/')[3]] || [] } })
  const doc = docs.find((row) => url.pathname === `/api/docs/${row.doc_key}`)
  if (doc) {
    if (holdMetadata && doc.doc_key === 'doc-a') { resolveMetadataSeen(); await metadataGate }
    return failMetadata ? fail() : route.fulfill({ json: doc })
  }
  return route.fulfill({ json: {} })
})
await context.routeWebSocket(/\/ws(?:\?|\/|$)/, (socket) => {
  activeSocket = socket
  socket.onMessage((raw) => {
    const message = JSON.parse(String(raw))
    if (message.type === 'hello') socket.send(JSON.stringify({ type: 'welcome', rev: revision, role: 'owner', canWrite: true, snapshot: snapshots[message.docId] || [] }))
    if (message.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }))
    if (message.type === 'op') {
      const ack = { type: 'applied', rev: ++revision, op: message.op }
      if (holdAcks) pendingAcks.push({ socket, ack })
      else socket.send(JSON.stringify(ack))
    }
  })
})
async function open(kind = 'doc', key = 'doc-a') {
  await page.goto(`${base}/#/work/${kind}/${key}`)
  await page.locator('.workspace-title').waitFor()
  await page.locator('.connection-success').waitFor()
}
async function screenshot(name) { await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true, animations: 'disabled' }) }
try {
  failList = true
  await open()
  assert.equal(await page.locator('[data-paragraph-id="paragraph-a"]').inputValue(), '用一份文档记录团队的共同目标。')
  await page.getByRole('button', { name: '重试列表' }).waitFor()
  failList = false
  await page.getByRole('button', { name: '重试列表' }).click()
  await page.locator('.workspace-sidebar .document-row').nth(3).waitFor()
  pass('列表接口失败不阻塞正文及协同连接，列表可以独立重试')

  failMetadata = true
  await page.reload()
  await page.getByRole('heading', { name: '无法打开内容' }).waitFor()
  failMetadata = false
  await page.getByRole('button', { name: '重试打开' }).click()
  await page.locator('.workspace-title').waitFor()
  pass('内容加载失败可直接重试，不必退出工作台')

  await open('doc', 'doc-b')
  holdMetadata = true
  metadataGate = new Promise((resolve) => { releaseMetadata = resolve })
  metadataSeen = new Promise((resolve) => { resolveMetadataSeen = resolve })
  await page.evaluate(() => { location.hash = '/work/doc/doc-a' })
  await metadataSeen
  await page.evaluate(() => { location.hash = '/work/board/board-a' })
  await page.locator('.workspace-title').filter({ hasText: '工作台交互流程' }).waitFor()
  releaseMetadata(); holdMetadata = false
  await page.waitForTimeout(100)
  assert.equal(await page.locator('.workspace-title').textContent(), '工作台交互流程')
  assert.equal(await page.locator('.board-editor').count(), 1)
  assert.ok(page.url().endsWith('#/work/board/board-a'))
  pass('快速打开不同内容时迟到元数据不会覆盖当前标题或编辑器')

  activeSocket.send(JSON.stringify({ type: 'metadata', docId: 'board-a', kind: 'board', title: '共同完善的交互流程' }))
  await page.locator('.workspace-title').filter({ hasText: '共同完善的交互流程' }).waitFor()
  await page.locator('.workspace-sidebar .document-row.active strong').filter({ hasText: '共同完善的交互流程' }).waitFor()
  assert.equal(await page.locator('.board-card').count(), 2)
  activeSocket.send(JSON.stringify({ type: 'metadata', docId: 'doc-a', kind: 'doc', title: '其他文档标题' }))
  await page.waitForTimeout(80)
  assert.equal(await page.locator('.workspace-title').textContent(), '共同完善的交互流程')
  pass('协作者改名实时更新顶部和当前列表项，不影响正文且忽略其他内容的通知')

  await open()
  holdAcks = true
  await page.locator('[data-paragraph-id="paragraph-a"]').fill('等待同步的修改')
  await page.locator('.connection-pending').waitFor()
  assert.equal(await page.getByRole('button', { name: '导出', exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: '返回工作台', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: '修改还没有同步完成', exact: true })
  await dialog.waitFor()
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  assert.ok(page.url().endsWith('#/work/doc/doc-a'))
  assert.equal(await page.locator('[data-paragraph-id="paragraph-a"]').inputValue(), '等待同步的修改')
  await page.getByRole('button', { name: '返回工作台', exact: true }).click()
  await dialog.waitFor()
  for (const { socket, ack } of pendingAcks.splice(0)) socket.send(JSON.stringify(ack))
  holdAcks = false
  await page.waitForURL((url) => /^#\/(?:\?|$)/.test(url.hash))
  assert.equal(await page.getByRole('dialog').count(), 0)
  pass('未确认修改离开时提醒，取消保留正文，确认到达后自动完成原导航')

  for (const [kind, key] of [['doc', 'doc-a'], ['board', 'board-a'], ['kanban', 'kanban-a']]) {
    await page.setViewportSize({ width: 1440, height: 960 })
    await open(kind, key)
    await screenshot(`${kind}-desktop`)
    for (const width of [820, 600, 390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      await page.waitForFunction(() => document.querySelector('.workspace-sidebar').inert)
      await page.getByRole('button', { name: '打开内容列表', exact: true }).click()
      const drawer = page.getByRole('dialog', { name: '空间内容导航', exact: true })
      await drawer.waitFor()
      assert.equal(await page.locator('.workspace-main').evaluate((el) => el.inert), true)
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.body.classList.contains('modal-open') && !document.querySelector('.workspace-main').inert && document.querySelector('.workspace-sidebar').getBoundingClientRect().right <= 0)
      assert.equal(await page.getByRole('button', { name: '打开内容列表', exact: true }).evaluate((el) => el === document.activeElement), true)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${kind} ${width}px overflow`)
      if (width === 390 || width === 320) await screenshot(`${kind}-${width}`)
    }
  }
  pass('编辑器手机抽屉支持 Esc 与焦点恢复，三种编辑器在820至320px无全页横向溢出')

  await page.setViewportSize({ width: 1440, height: 960 })
  await open()
  activeSocket.send(JSON.stringify({ type: 'access', role: 'viewer', canWrite: false, message: '你已被调整为只读者' }))
  await page.locator('.readonly-strip').waitFor()
  await page.getByRole('button', { name: '更多操作：项目需求与设计说明', exact: true }).click()
  assert.equal(await page.getByRole('menuitem', { name: '重命名', exact: true }).count(), 0)
  assert.equal(await page.getByRole('menuitem', { name: '删除内容', exact: true }).count(), 0)
  await page.keyboard.press('Escape')
  activeSocket.send(JSON.stringify({ type: 'access', role: 'editor', canWrite: true, message: '你已被调整为编辑者' }))
  await page.getByRole('button', { name: '添加段落', exact: true }).waitFor()
  await page.getByRole('button', { name: '更多操作：项目需求与设计说明', exact: true }).click()
  await page.getByRole('menuitem', { name: '重命名', exact: true }).waitFor()
  assert.equal(await page.getByRole('menuitem', { name: '删除内容', exact: true }).count(), 0)
  await page.keyboard.press('Escape')
  activeSocket.send(JSON.stringify({ type: 'error', code: 'MEMBERSHIP_REVOKED', message: '你已不再是此空间成员', fatal: true }))
  await page.getByRole('heading', { name: '当前内容已无法访问', exact: true }).waitFor()
  assert.equal(await page.locator('.document-editor').count(), 0)
  assert.equal(await page.getByRole('button', { name: '导出', exact: true }).isDisabled(), true)
  await screenshot('access-revoked')
  pass('实时权限变化同步内容菜单，成员移除后显示明确返回入口并关闭编辑、历史及导出')
  assert.deepEqual(errors, [])
  await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify({ status: 'passed', checks, errors }, null, 2))
} catch (error) {
  releaseMetadata?.()
  await screenshot('failure')
  await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify({ status: 'failed', checks, errors, error: String(error) }, null, 2))
  throw error
} finally { await browser.close() }
