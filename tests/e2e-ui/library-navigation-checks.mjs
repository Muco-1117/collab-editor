import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

// Isolated fixtures: no requests reach real accounts or document data.
const base = process.env.E2E_BASE_URL || 'http://localhost:5173'
const out = path.resolve(process.env.E2E_OUTPUT_DIR || 'artifacts/round2-20261022/library-navigation')
await fs.mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
const page = await context.newPage()
page.setDefaultTimeout(12_000)
const checks = [],
  errors = []
page.on('pageerror', (error) => errors.push(error.message))
const pass = (label) => {
  checks.push(label)
  console.log('PASS', label)
}
const user = { id: 901099, username: 'library_preview', nickname: '林间来信', avatarUrl: '' }
const spaces = [
  { id: 501, name: '产品设计协作空间', my_role: 'owner', doc_count: 5 },
  { id: 502, name: '研究与灵感', my_role: 'owner', doc_count: 1 },
  { id: 503, name: '只读共享空间', my_role: 'viewer', doc_count: 1 },
  { id: 504, name: '编辑协作空间', my_role: 'editor', doc_count: 1 },
]
let docs = [
  ['requirements', '产品需求与功能规划', 'doc', 501],
  ['guide', '项目介绍与使用指南', 'doc', 501],
  ['board-one', '工作台交互方案', 'board', 501],
  ['board-empty', '下一次头脑风暴', 'board', 501],
  ['tasks', '第一阶段迭代计划', 'kanban', 501],
  ['board-two', '用户访谈线索', 'board', 502],
  ['board-viewer', '共享方案', 'board', 503],
  ['board-editor', '编辑方案', 'board', 504],
].map(([doc_key, title, kind, space_id], index) => ({
  doc_key,
  title,
  kind,
  space_id,
  space_name: spaces.find((space) => space.id === space_id).name,
  my_role: spaces.find((space) => space.id === space_id).my_role,
  updated_at: `2026-10-${String(22 - index).padStart(2, '0')}T08:00:00`,
}))
const element = (id, type, fields) => ({
  id,
  type,
  fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value }])),
})
const boardElements = [
  element('note-a', 'CARD', {
    x: 55,
    y: 50,
    w: 220,
    h: 150,
    z: 1,
    text: '收集想法\n让每个灵感都能被看见',
    color: '#fff1a8',
  }),
  element('note-b', 'CARD', {
    x: 315,
    y: 65,
    w: 220,
    h: 150,
    z: 2,
    text: '梳理流程\n把分散的信息连接起来',
    color: '#dcecff',
  }),
  element('note-c', 'CARD', {
    x: 90,
    y: 230,
    w: 220,
    h: 150,
    z: 3,
    text: '形成共识\n留下清晰的协作记录',
    color: '#e4f2dd',
  }),
  element('gone-note', 'CARD', { x: 900, text: '不应显示的旧想法', '#tombstone': true }),
]
const kanbanElements = [
  element('todo', 'COLUMN', { title: '待开始', order: 100 }),
  element('doing', 'COLUMN', { title: '进行中', order: 200 }),
  element('done', 'COLUMN', { title: '已完成', order: 300 }),
  element('task-a', 'CARD', { text: '整理访谈反馈', column: 'todo', order: 100 }),
  element('task-b', 'CARD', { text: '确认内容分类方案', column: 'todo', order: 200 }),
  element('task-c', 'CARD', { text: '优化工作台导航', column: 'doing', order: 100, color: '#f3effb' }),
  element('task-d', 'CARD', { text: '完成用户需求梳理', column: 'done', order: 100, color: '#edf5ee' }),
  element('gone-task', 'CARD', { text: '不应显示的旧任务', column: 'doing', '#tombstone': true }),
]
let failPreview = false,
  failOpen = false,
  failDocs = false,
  holdSpace = false,
  releaseSpace,
  spaceSeen
let resolveSpaceSeen,
  heldSpacePromise,
  creates = []
const bodies = new Map()
await context.addInitScript(() => {
  localStorage.setItem('collab_access_token', 'library-mock-token')
  if (!localStorage.getItem('collab_dashboard:901099')) {
    localStorage.setItem(
      'collab_dashboard:901099',
      JSON.stringify({ section: 'stats', kind: 'all', layout: 'list', sort: 'updated' }),
    )
  }
})
await context.route('**/api/**', async (route) => {
  const req = route.request(),
    url = new URL(req.url()),
    method = req.method()
  const ok = (json) => route.fulfill({ json })
  const fail = () => route.fulfill({ status: 503, json: { msg: '模拟连接中断' } })
  if (url.pathname === '/api/auth/me') return ok({ user })
  if (url.pathname === '/api/spaces') return ok(spaces)
  if (url.pathname.endsWith('/members')) return ok({ members: [{ ...user, role: 'owner' }] })
  if (url.pathname === '/api/stats') return ok({ spaces: 4, documents: docs.length, operations: 12 })
  if (url.pathname === '/api/docs/search')
    return ok(docs.filter((row) => row.title.includes(url.searchParams.get('q') || '')))
  if (url.pathname === '/api/docs') {
    if (method === 'POST') {
      const body = req.postDataJSON()
      creates.push(body)
      const space = spaces.find((item) => item.id === Number(body.spaceId))
      const doc = {
        doc_key: `created-${creates.length}`,
        title: body.title,
        kind: body.kind,
        space_id: space.id,
        space_name: space.name,
        my_role: space.my_role,
        updated_at: '2026-10-22T12:00:00',
      }
      docs.push(doc)
      return ok({ docKey: doc.doc_key, ...doc })
    }
    if (failDocs) return fail()
    const id = Number(url.searchParams.get('spaceId'))
    const snapshot = docs.filter((row) => !id || row.space_id === id)
    if (holdSpace && id === 501) {
      resolveSpaceSeen()
      await heldSpacePromise
    }
    return ok(snapshot)
  }
  const match = url.pathname.match(/^\/api\/docs\/([^/]+)(?:\/(history|replay))?$/)
  if (match) {
    const [, key, action] = match
    if (action === 'history') return failPreview && key === 'board-one' ? fail() : ok({ rev: 7, ops: [] })
    if (action === 'replay')
      return ok({
        rev: 7,
        elements:
          bodies.get(key) ||
          (key === 'tasks'
            ? kanbanElements
            : key === 'board-empty' || key.startsWith('created-')
              ? []
              : boardElements),
      })
    const doc = docs.find((row) => row.doc_key === key)
    if (method === 'PUT') {
      doc.title = req.postDataJSON().title
      doc.updated_at = '2026-10-22T12:01:00'
      return ok({ docKey: key, title: doc.title })
    }
    if (method === 'DELETE') {
      docs = docs.filter((row) => row.doc_key !== key)
      return ok({ deleted: true })
    }
    if (failOpen || !doc) return route.fulfill({ status: 404, json: { msg: '内容暂时无法打开' } })
    return ok(doc)
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
  await page.getByRole('navigation', { name: '工作台功能' }).getByRole('link', { name, exact: true }).click()
}
async function ready(key) {
  await page.locator(`.library-card[data-preview-key="${key}"][data-preview-status="ready"]`).waitFor()
}
async function expectLocation(kind, space = 501) {
  await page.waitForURL((url) => url.hash === `#/library/${kind}?space=${space}`)
  await page
    .getByRole('heading', {
      level: 1,
      name: { doc: '文档', board: '白板', kanban: '看板' }[kind],
      exact: true,
    })
    .waitFor()
}
async function screenshot(name) {
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true, animations: 'disabled' })
}
async function chooseSpace(name) {
  await page
    .getByRole('navigation', { name: '空间列表' })
    .getByRole('button', { name: new RegExp(name) })
    .click()
}
try {
  await page.goto(`${base}/#/?space=501`)
  await page.locator('.document-row').nth(4).waitFor()
  assert.equal(await page.locator('.content-filters').count(), 0)
  assert.equal(await page.locator('.document-row').count(), 5)
  await page.getByRole('heading', { name: '最近更新', exact: true }).waitFor()
  assert.equal(await page.locator('.workbench-breadcrumb strong').textContent(), '空间首页')
  assert.equal((await page.locator('.workbench-nav [aria-current="page"]').textContent()).trim(), '空间首页')
  assert.ok(new URL(page.url()).hash.startsWith('#/?'))
  pass('首页只展示最近更新，不再重复左侧的类型筛选')

  await nav('文档')
  await expectLocation('doc')
  await page.locator('.library-document-row').nth(1).waitFor()
  assert.equal(await page.locator('.creation-launchpad,.content-filters').count(), 0)
  await screenshot('documents-desktop')
  await nav('白板')
  await expectLocation('board')
  await ready('board-one')
  await ready('board-empty')
  assert.equal(await page.locator('[data-preview-key="board-one"] .library-board-canvas rect').count(), 3)
  assert.equal(
    await page.locator('[data-preview-key="board-one"] .library-board-canvas rect').first().getAttribute('x'),
    '55',
  )
  assert.match(await page.locator('[data-preview-key="board-one"]').textContent(), /收集想法/)
  assert.doesNotMatch(await page.locator('.library-gallery').textContent(), /不应显示的旧想法/)
  assert.match(await page.locator('[data-preview-key="board-empty"]').textContent(), /还没有卡片或图片/)
  await screenshot('whiteboards-desktop')
  await nav('看板')
  await expectLocation('kanban')
  await ready('tasks')
  assert.equal(await page.locator('.library-mini-column').count(), 3)
  assert.equal(await page.locator('.library-mini-task').count(), 4)
  assert.match(await page.locator('.library-mini-column').nth(1).textContent(), /进行中.*优化工作台导航/s)
  assert.doesNotMatch(await page.locator('.library-gallery').textContent(), /不应显示的旧任务/)
  await screenshot('kanbans-desktop')
  pass('三个栏目具备独立 URL、标题和布局，画布与任务预览反映真实结构及删除状态')

  await page.reload()
  await expectLocation('kanban')
  await ready('tasks')
  await page.goBack()
  await expectLocation('board')
  await ready('board-one')
  await page.goForward()
  await expectLocation('kanban')
  await ready('tasks')
  await nav('空间首页')
  await page.locator('.document-row').nth(4).waitFor()
  assert.equal(await page.locator('.document-row').count(), 5)
  await nav('白板')
  await ready('board-one')
  await chooseSpace('研究与灵感')
  await expectLocation('board', 502)
  await ready('board-two')
  assert.equal(await page.locator('.library-card').count(), 1)
  await page.goBack()
  await expectLocation('board', 501)
  await ready('board-one')
  pass('刷新、前进后退恢复栏目和空间，切空间保留栏目，回首页恢复跨类型最近更新')

  const search = page.getByRole('searchbox', { name: '查找白板' })
  await search.fill('交互')
  assert.equal(await page.locator('.library-card').count(), 1)
  await search.fill('不存在的名称')
  await page.getByRole('heading', { name: '没有找到匹配的白板' }).waitFor()
  await page.getByRole('button', { name: '清除查找', exact: true }).click()
  await ready('board-one')
  await page.getByRole('button', { name: '新建白板', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: '新建白板', exact: true })
  assert.equal(await dialog.locator('.kind-picker').count(), 0)
  await dialog.getByLabel('标题', { exact: true }).fill('新的协作草图')
  await dialog.getByRole('button', { name: '创建并打开' }).click()
  await page.waitForURL('**/#/work/board/created-1')
  await page.getByRole('heading', { level: 1, name: '内容标题', exact: true }).waitFor()
  assert.equal(await page.locator('.workspace-title').textContent(), '新的协作草图')
  assert.deepEqual(creates[0], { title: '新的协作草图', kind: 'board', spaceId: '501' })
  await page.reload()
  await page.getByRole('button', { name: '返回工作台', exact: true }).click()
  await expectLocation('board')
  await ready('created-1')
  await page.getByRole('link', { name: '进入个人主页', exact: true }).click()
  await page.getByRole('link', { name: '返回工作台', exact: true }).click()
  await expectLocation('board')
  await ready('board-one')
  failOpen = true
  await page.getByRole('button', { name: '打开白板：工作台交互方案', exact: true }).click()
  await page.getByRole('heading', { name: '无法打开内容', exact: true }).waitFor()
  await page.getByRole('button', { name: '返回工作台', exact: true }).click()
  failOpen = false
  await expectLocation('board')
  await ready('board-one')
  pass('栏目查找与创建正确，编辑页刷新、个人页和打开失败后均可回到原栏目')

  await page.getByRole('button', { name: '更多操作：新的协作草图', exact: true }).click()
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '重命名内容' })
  await dialog.getByLabel('标题').fill('已调整的协作草图')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('button', { name: '更多操作：已调整的协作草图', exact: true }).click()
  await page.getByRole('menuitem', { name: '删除内容', exact: true }).click()
  await page
    .getByRole('dialog', { name: '删除内容', exact: true })
    .getByRole('button', { name: '删除', exact: true })
    .click()
  await page.locator('[data-preview-key="created-1"]').waitFor({ state: 'detached' })
  await expectLocation('board')
  pass('专属栏目中的重命名与删除操作正常，操作后留在当前栏目')

  failPreview = true
  await page.reload()
  await expectLocation('board')
  await page.locator('[data-preview-key="board-one"][data-preview-status="error"]').waitFor()
  assert.match(await page.locator('[data-preview-key="board-one"]').textContent(), /预览暂时不可用/)
  await screenshot('preview-retry')
  failPreview = false
  await page.getByRole('button', { name: '重新加载“工作台交互方案”的预览' }).click()
  await ready('board-one')
  failDocs = true
  await page.reload()
  await page.getByRole('button', { name: '重新加载内容' }).waitFor()
  assert.equal(await page.locator('.library-empty').count(), 0)
  failDocs = false
  await page.getByRole('button', { name: '重新加载内容' }).click()
  await ready('board-one')
  pass('预览和栏目加载失败可分别重试，不误报为空内容')

  await chooseSpace('只读共享空间')
  await expectLocation('board', 503)
  await ready('board-viewer')
  assert.equal(await page.getByRole('button', { name: '新建白板', exact: true }).count(), 0)
  await page.getByRole('button', { name: '更多操作：共享方案', exact: true }).click()
  assert.equal(await page.getByRole('menuitem', { name: /重命名|删除内容/ }).count(), 0)
  await page.keyboard.press('Escape')
  await chooseSpace('编辑协作空间')
  await expectLocation('board', 504)
  await ready('board-editor')
  assert.equal(await page.getByRole('button', { name: '新建白板', exact: true }).count(), 1)
  await page.getByRole('button', { name: '更多操作：编辑方案', exact: true }).click()
  assert.equal(await page.getByRole('menuitem', { name: '重命名', exact: true }).count(), 1)
  assert.equal(await page.getByRole('menuitem', { name: '删除内容', exact: true }).count(), 0)
  await page.keyboard.press('Escape')
  pass('只读与编辑角色在新栏目保留正确的创建、改名、删除权限')

  holdSpace = true
  heldSpacePromise = new Promise((resolve) => {
    releaseSpace = resolve
  })
  spaceSeen = new Promise((resolve) => {
    resolveSpaceSeen = resolve
  })
  await chooseSpace('产品设计协作空间')
  await spaceSeen
  await chooseSpace('研究与灵感')
  await expectLocation('board', 502)
  await ready('board-two')
  releaseSpace()
  holdSpace = false
  await page.waitForTimeout(100)
  assert.equal(await page.locator('.library-card').count(), 1)
  assert.equal(await page.locator('[data-preview-key="board-one"]').count(), 0)
  await chooseSpace('产品设计协作空间')
  await ready('board-one')
  pass('快速切空间时迟到响应不会覆盖新空间内容')

  await nav('看板')
  await ready('tasks')
  await page.getByRole('button', { name: '新建看板', exact: true }).click()
  await page.getByRole('dialog', { name: '新建看板', exact: true }).getByLabel('标题').fill('未提交的草稿')
  await page.goBack()
  await expectLocation('board')
  assert.equal(await page.getByRole('dialog').count(), 0)
  assert.equal(await page.evaluate(() => document.body.classList.contains('modal-open')), false)
  pass('浏览器后退会清理未提交弹窗，避免创建类型与所在栏目错位')

  for (const width of [1024, 820, 600, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    for (const name of ['文档', '白板', '看板']) {
      await nav(name)
      await page.getByRole('heading', { level: 1, name, exact: true }).waitFor()
      if (name === '白板') await ready('board-one')
      if (name === '看板') await ready('tasks')
      assert.equal(await page.locator('.app-main').evaluate((el) => el.inert), false)
      await page.waitForFunction(
        () => innerWidth > 820 || document.querySelector('.app-sidebar').getBoundingClientRect().right <= 0,
      )
      assert.equal(await page.evaluate(() => document.body.classList.contains('modal-open')), false)
      assert.ok(
        await page.evaluate(
          () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= innerWidth + 1,
        ),
        `${width}px ${name} overflow`,
      )
      if (width === 390 || width === 320)
        await screenshot(
          `${name === '文档' ? 'documents' : name === '白板' ? 'whiteboards' : 'kanbans'}-${width}`,
        )
    }
  }
  assert.deepEqual(errors, [])
  pass('1024/820/600/390/320px 三栏目无横向溢出，手机导航关闭后解除背景锁定')
  await fs.writeFile(
    path.join(out, 'summary.json'),
    JSON.stringify({ status: 'passed', checks, errors }, null, 2),
  )
} catch (error) {
  releaseSpace?.()
  await screenshot('failure')
  await fs.writeFile(
    path.join(out, 'summary.json'),
    JSON.stringify({ status: 'failed', checks, errors, error: String(error) }, null, 2),
  )
  throw error
} finally {
  await browser.close()
}
