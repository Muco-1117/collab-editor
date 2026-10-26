import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const base = process.env.E2E_BASE_URL || 'http://localhost:5173'
const out = path.resolve(process.env.E2E_OUTPUT_DIR || 'artifacts/round2-20261022/home-trash')
await fs.mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
page.setDefaultTimeout(12_000)
const checks = [],
  errors = [],
  requests = []
page.on('pageerror', (error) => errors.push(error.message))
const pass = (name) => {
  checks.push(name)
  console.log('PASS', name)
}
const user = { id: 902041, username: 'round_two', nickname: '林间来信', avatarUrl: '' }
const spaces = [
  { id: 501, name: '产品设计协作空间', my_role: 'owner', doc_count: 11 },
  { id: 502, name: '团队共享空间', my_role: 'viewer', doc_count: 1 },
  { id: 503, name: '研究与灵感', my_role: 'owner', doc_count: 0 },
]
const titles = [
  '产品需求与功能规划',
  '工作台交互方案',
  '第一阶段迭代计划',
  '项目介绍与使用指南',
  '团队会议记录',
  '组件与布局规范',
  '接口联调记录',
  '灵感收集',
  '验收清单',
  '技术方案',
  '数据库设计',
  '共享文档',
]
let docs = titles.map((title, index) => ({
  doc_key: `work-${index}`,
  title,
  kind: index === 1 || index === 7 ? 'board' : index === 2 ? 'kanban' : 'doc',
  space_id: index === 11 ? 502 : 501,
  space_name: index === 11 ? spaces[1].name : spaces[0].name,
  my_role: index === 11 ? 'viewer' : 'owner',
  updated_at: `2026-10-${String(22 - index).padStart(2, '0')}T08:00:00`,
}))
let trash = ['doc', 'board', 'kanban'].map((kind, index) => ({
  doc_key: `deleted-${kind}`,
  title: ['旧版需求说明', '原型讨论草图', '上一轮迭代任务'][index],
  kind,
  space_id: 501,
  space_name: spaces[0].name,
  my_role: 'owner',
  deleted_at: '2026-10-22T09:30:00',
  updated_at: '2026-10-21T08:00:00',
}))
const element = (id, type, fields) => ({
  id,
  type,
  fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value }])),
})
const body = [
  element('paragraph-2', 'TEXT', { order: 200, text: '让信息查找更容易，让协作过程更清晰。' }),
  element('paragraph-1', 'TEXT', { order: 100, text: '围绕团队工作场景，梳理文档、白板与看板的使用流程。' }),
  element('paragraph-deleted', 'TEXT', { text: '已删除的私有正文不得显示', '#tombstone': true }),
  element('image', 'IMAGE', { order: 300, assetId: 'body-image', name: '需求示意图' }),
]
const board = [
  element('note-a', 'CARD', {
    x: 45,
    y: 40,
    w: 220,
    h: 150,
    z: 1,
    text: '明确入口分工\n首页负责继续工作',
    color: '#fff1a8',
  }),
  element('note-b', 'CARD', {
    x: 325,
    y: 100,
    w: 220,
    h: 150,
    z: 2,
    text: '栏目直达\n文档、白板、看板',
    color: '#dcecff',
  }),
]
const kanban = [
  ...['需求确认', '设计中', '开发中', '待验收'].map((title, i) =>
    element(`col-${i}`, 'COLUMN', { title, order: i * 100 }),
  ),
  ...['明确首页职责', '调整导航结构', '增加正文摘要', '验证窄屏布局', '保留误删内容'].map((text, i) =>
    element(`task-${i}`, 'CARD', { text, column: `col-${i % 4}`, order: i * 100 }),
  ),
]
let failTrash = false,
  failRestore = false,
  failPreview = false,
  holdTrash = false,
  releaseTrash,
  heldTrash,
  seenTrash
let markTrashSeen,
  restoreCalls = 0
await context.addInitScript(
  ({ userId }) => {
    localStorage.setItem('collab_access_token', 'round-two-home-fixture')
    if (!localStorage.getItem(`collab_recent_work:${userId}`)) {
      localStorage.setItem(
        `collab_recent_work:${userId}`,
        JSON.stringify([
          { docKey: 'work-2', spaceId: '501', kind: 'kanban', openedAt: Date.now() - 180_000 },
          { docKey: 'work-0', spaceId: '501', kind: 'doc', openedAt: Date.now() - 600_000 },
          { docKey: 'work-1', spaceId: '501', kind: 'board', openedAt: Date.now() - 3_600_000 },
          { docKey: 'removed', spaceId: '501', kind: 'doc', openedAt: Date.now() },
          { docKey: 'work-11', spaceId: '502', kind: 'doc', openedAt: Date.now() },
        ]),
      )
    }
    localStorage.setItem(
      `collab_dashboard:${userId}`,
      JSON.stringify({ kind: 'kanban', layout: 'grid', sort: 'title' }),
    )
  },
  { userId: user.id },
)
await context.route('**/api/**', async (route) => {
  const request = route.request(),
    url = new URL(request.url()),
    method = request.method()
  requests.push({ path: url.pathname, method })
  const ok = (json) => route.fulfill({ json })
  const fail = () => route.fulfill({ status: 503, json: { msg: '模拟连接中断' } })
  if (url.pathname === '/api/auth/me') return ok({ user })
  if (url.pathname === '/api/spaces') return ok(spaces)
  if (url.pathname.endsWith('/members')) return ok({ members: [{ ...user, role: 'owner' }] })
  if (url.pathname === '/api/stats') return ok({ spaces: 3, documents: docs.length, operations: 85 })
  if (url.pathname === '/api/docs/search')
    return ok(docs.filter((doc) => doc.title.includes(url.searchParams.get('q') || '')))
  if (url.pathname === '/api/docs')
    return ok(docs.filter((doc) => doc.space_id === Number(url.searchParams.get('spaceId'))))
  const trashMatch = url.pathname.match(/^\/api\/spaces\/(\d+)\/trash$/)
  if (trashMatch) {
    if (failTrash) return fail()
    const result = trash.filter((doc) => doc.space_id === Number(trashMatch[1]))
    if (holdTrash && trashMatch[1] === '501') {
      markTrashSeen()
      await heldTrash
    }
    return ok({ documents: result })
  }
  const match = url.pathname.match(/^\/api\/docs\/([^/]+)(?:\/(history|replay|restore-deleted))?$/)
  if (match) {
    const [, key, action] = match
    if (action === 'restore-deleted') {
      restoreCalls++
      if (failRestore) return fail()
      const doc = trash.find((doc) => doc.doc_key === key)
      trash = trash.filter((doc) => doc.doc_key !== key)
      if (doc) docs.push({ ...doc, deleted_at: null, updated_at: '2026-10-22T10:00:00' })
      return ok({ docKey: key, title: doc.title, kind: doc.kind, spaceId: doc.space_id })
    }
    const doc = docs.find((doc) => doc.doc_key === key)
    if (action === 'history') return failPreview && key === 'work-0' ? fail() : ok({ rev: 7, ops: [] })
    if (action === 'replay')
      return ok({ rev: 7, elements: doc?.kind === 'board' ? board : doc?.kind === 'kanban' ? kanban : body })
    if (method === 'DELETE') {
      docs = docs.filter((doc) => doc.doc_key !== key)
      trash.push({ ...doc, deleted_at: '2026-10-22T11:00:00' })
      return ok({ deleted: true })
    }
    return doc ? ok(doc) : route.fulfill({ status: 404, json: { msg: '内容不存在' } })
  }
  return ok({})
})
await context.routeWebSocket(/\/ws(?:\?|\/|$)/, (socket) => {
  socket.onMessage((raw) => {
    const message = JSON.parse(String(raw))
    if (message.type === 'hello')
      socket.send(JSON.stringify({ type: 'welcome', snapshot: [], rev: 7, role: 'owner', canWrite: true }))
    if (message.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }))
  })
})
async function nav(name) {
  const menu = page.getByRole('button', { name: '打开导航', exact: true })
  if (
    (await menu.isVisible()) &&
    !(await page.locator('.app-sidebar').evaluate((el) => el.classList.contains('open')))
  )
    await menu.click()
  await page.locator('.workbench-nav').getByRole('link', { name, exact: true }).click()
}
async function space(name) {
  const menu = page.getByRole('button', { name: '打开导航', exact: true })
  if (
    (await menu.isVisible()) &&
    !(await page.locator('.app-sidebar').evaluate((el) => el.classList.contains('open')))
  )
    await menu.click()
  await page
    .getByRole('navigation', { name: '空间列表' })
    .getByRole('button', { name: new RegExp(name) })
    .click()
}
async function shot(name) {
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true, animations: 'disabled' })
}
async function ready(key) {
  await page.locator(`[data-preview-key="${key}"][data-preview-status="ready"]`).waitFor()
}

try {
  await page.goto(`${base}/#/?space=501`)
  await page.locator('.document-row').nth(7).waitFor()
  assert.equal(await page.locator('.document-row').count(), 8)
  assert.equal(await page.locator('.content-filters,.view-switch').count(), 0)
  assert.equal(await page.locator('.recent-work-item').count(), 3)
  assert.match(await page.locator('.recent-work-item').first().textContent(), /第一阶段迭代计划/)
  assert.match(await page.locator('.document-row').first().textContent(), /产品需求与功能规划/)
  assert.equal(
    requests.some((request) => /history|replay/.test(request.path)),
    false,
  )
  await shot('home-desktop')
  pass('首页无重复类型筛选，最近更新限制8项，继续工作按真实打开顺序且过滤删除与其他空间内容')

  await page.getByRole('button', { name: '继续文档：产品需求与功能规划', exact: true }).click()
  await page.getByRole('heading', { name: '内容标题', exact: true }).waitFor()
  await page.getByRole('button', { name: '返回工作台', exact: true }).click()
  await page.locator('.recent-work-item').first().waitFor()
  assert.match(await page.locator('.recent-work-item').first().textContent(), /产品需求与功能规划/)
  await page.reload()
  await page.locator('.recent-work-item').first().waitFor()
  assert.match(await page.locator('.recent-work-item').first().textContent(), /产品需求与功能规划/)
  pass('打开后立即更新继续工作顺序，刷新仍保留当前账号记录')

  await nav('文档')
  await ready('work-0')
  const excerpt = page.locator('[data-preview-key="work-0"]')
  assert.match(await excerpt.textContent(), /围绕团队工作场景.*让信息查找更容易/s)
  assert.match(await excerpt.textContent(), /2 段落.*1 张图片/s)
  assert.doesNotMatch(await excerpt.textContent(), /已删除的私有正文/)
  await shot('documents-desktop')
  failPreview = true
  await page.reload()
  await page.getByRole('button', { name: '重新加载“产品需求与功能规划”的摘要' }).waitFor()
  assert.equal(
    await page.getByRole('button', { name: '打开文档：产品需求与功能规划', exact: true }).isEnabled(),
    true,
  )
  failPreview = false
  await page.getByRole('button', { name: '重新加载“产品需求与功能规划”的摘要' }).click()
  await ready('work-0')
  pass('文档栏目显示真实正文摘要与数量，忽略墓碑，摘要失败独立重试且不阻止打开')

  await nav('白板')
  await ready('work-1')
  await shot('boards-desktop')
  await nav('看板')
  await ready('work-2')
  assert.match(
    await page.locator('.library-distribution-label').textContent(),
    /需求确认 2.*设计中 1.*开发中 1.*待验收 1/,
  )
  assert.equal(await page.locator('.library-distribution-bar > span').count(), 4)
  assert.doesNotMatch(await page.locator('.library-preview-summary').textContent(), /已完成|进度/)
  await shot('kanbans-desktop')
  pass('白板画布与看板任务有专属布局，四列任务分布完整且不猜测完成状态')

  await nav('回收站')
  await page.locator('.trash-row').nth(2).waitFor()
  await shot('trash-desktop')
  await page.getByRole('searchbox', { name: '查找已删除的内容' }).fill('不存在')
  await page.getByRole('heading', { name: '没有找到匹配的内容', exact: true }).waitFor()
  await page.getByRole('button', { name: '清除查找', exact: true }).click()
  failRestore = true
  await page.getByRole('button', { name: '恢复旧版需求说明', exact: true }).click()
  await page.locator('.trash-restore-error').waitFor()
  assert.equal(await page.locator('.trash-row').count(), 3)
  failRestore = false
  await page.getByRole('button', { name: '恢复旧版需求说明', exact: true }).click()
  await page.locator('.trash-restored').waitFor()
  assert.equal(await page.locator('.trash-row').count(), 2)
  assert.equal(restoreCalls, 2)
  await page.locator('.trash-restored').getByRole('button', { name: '打开内容' }).click()
  await page.waitForURL('**/#/work/doc/deleted-doc')
  await page.getByRole('heading', { name: '内容标题', exact: true }).waitFor()
  await page.getByRole('button', { name: '返回工作台', exact: true }).click()
  await page.waitForURL('**/#/trash?space=501')
  await nav('文档')
  await ready('deleted-doc')
  pass('回收站查找、失败重试、恢复后打开及返回原栏目正常，恢复内容重新出现在文档库')

  await nav('回收站')
  failTrash = true
  await page.getByRole('button', { name: '刷新回收站', exact: true }).click()
  await page.getByRole('button', { name: '重新加载回收站' }).waitFor()
  assert.equal(await page.getByRole('heading', { name: '回收站是空的', exact: true }).count(), 0)
  failTrash = false
  await page.getByRole('button', { name: '重新加载回收站' }).click()
  await page.locator('.trash-row').nth(1).waitFor()
  heldTrash = new Promise((resolve) => {
    releaseTrash = resolve
  })
  seenTrash = new Promise((resolve) => {
    markTrashSeen = resolve
  })
  holdTrash = true
  await page.getByRole('button', { name: '刷新回收站', exact: true }).click()
  await seenTrash
  await space('研究与灵感')
  await page.getByRole('heading', { name: '回收站是空的', exact: true }).waitFor()
  holdTrash = false
  releaseTrash()
  await page.waitForTimeout(100)
  assert.equal(await page.locator('.trash-row').count(), 0)
  pass('回收站网络错误不伪装空态，切空间时迟到响应不会覆盖新空间')

  const countBefore = requests.filter((request) => request.path === '/api/spaces/502/trash').length
  await space('团队共享空间')
  await page.getByRole('heading', { name: '仅空间所有者可管理回收站' }).waitFor()
  assert.equal(
    await page.locator('.workbench-nav').getByRole('link', { name: '回收站', exact: true }).count(),
    0,
  )
  assert.equal(requests.filter((request) => request.path === '/api/spaces/502/trash').length, countBefore)
  await space('产品设计协作空间')
  await page.locator('.trash-row').nth(1).waitFor()
  pass('只读空间隐藏恢复入口，直达回收站也不请求或显示删除内容')

  for (const width of [820, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    for (const name of ['空间首页', '文档', '白板', '看板', '回收站']) {
      await nav(name)
      if (name === '文档') await ready('work-0')
      if (name === '白板') await ready('work-1')
      if (name === '看板') await ready('work-2')
      if (name === '回收站') await page.locator('.trash-row').first().waitFor()
      await page.waitForFunction(
        () => document.querySelector('.app-sidebar').getBoundingClientRect().right <= 0,
      )
      assert.ok(
        await page.evaluate(
          () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= innerWidth + 1,
        ),
        `${width}px ${name} overflow`,
      )
      if (width === 390)
        await shot(
          `${name === '空间首页' ? 'home' : name === '回收站' ? 'trash' : name === '文档' ? 'documents' : name === '白板' ? 'boards' : 'kanbans'}-390`,
        )
    }
  }
  pass('820/390/320px 首页、三个栏目和回收站均无横向溢出，导航抽屉正常关闭')
  assert.deepEqual(errors, [])
  await fs.writeFile(
    path.join(out, 'summary.json'),
    JSON.stringify({ status: 'passed', checks, errors }, null, 2),
  )
} catch (error) {
  releaseTrash?.()
  await shot('failure')
  await fs.writeFile(
    path.join(out, 'summary.json'),
    JSON.stringify({ status: 'failed', checks, errors, error: String(error) }, null, 2),
  )
  throw error
} finally {
  await browser.close()
}
