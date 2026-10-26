import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const base = process.env.E2E_BASE_URL || 'http://localhost:5176'
const out = path.resolve(process.env.E2E_OUTPUT_DIR || 'artifacts/round2-20261022/refresh-search')
await fs.mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' })
const page = await context.newPage()
page.setDefaultTimeout(12_000)
const checks = [],
  errors = [],
  requests = [],
  abortedSearches = [],
  heldSearches = new Map()
page.on('pageerror', (error) => errors.push(error.message))
page.on('requestfailed', (request) => {
  const url = new URL(request.url())
  if (url.pathname === '/api/docs/search')
    abortedSearches.push({ query: url.searchParams.get('q'), error: request.failure()?.errorText })
})
const pass = (label) => {
  checks.push(label)
  console.log('PASS', label)
}
const user = { id: 902051, username: 'refresh_check', nickname: '林间来信', avatarUrl: '' }
const spaces = [{ id: 501, name: '产品设计协作空间', my_role: 'owner', doc_count: 1 }]
const invitedSpace = { id: 502, name: '刚刚加入的研究空间', my_role: 'editor', doc_count: 1 }
const timestamp = '2026-10-22T10:45:00'
const docs = [
  {
    doc_key: 'current-plan',
    title: '当前空间的项目计划',
    kind: 'doc',
    space_id: 501,
    space_name: spaces[0].name,
    my_role: 'owner',
    updated_at: timestamp,
  },
  {
    doc_key: 'invited-notes',
    title: '新空间里的讨论纪要',
    kind: 'doc',
    space_id: 502,
    space_name: invitedSpace.name,
    my_role: 'editor',
    updated_at: timestamp,
  },
]
const members = [
  { ...user, role: 'owner' },
  { id: 902052, username: 'shared_member', nickname: '协作伙伴南风', role: 'editor', avatar_url: '' },
]
let spacesStatus = 200,
  docsStatus = 200,
  membersStatus = 200,
  revision = 11,
  bodyText = '刷新前的协作记录。'

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function bounded(promise, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`等待超时：${label}`)), 12_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function holdSearch(query) {
  const hold = { seen: deferred(), release: deferred(), served: deferred() }
  heldSearches.set(query, hold)
  return hold
}

function resultFor(query) {
  const titles = {
    准备: '搜索键盘操作预备结果',
    中文协作: '中文协作的最终搜索结果',
    早期: '迟到的早期搜索结果',
    最新: '应当保留的最新搜索结果',
    迟到: '关闭后不得出现的搜索结果',
  }
  return [{ ...docs[0], title: titles[query] || '长度限制后的搜索结果', hit: 'body', snippet: query }]
}

await context.addInitScript(() => localStorage.setItem('collab_access_token', 'round-two-refresh-fixture'))
await context.route('**/api/**', async (route) => {
  const request = route.request(),
    url = new URL(request.url()),
    pathname = url.pathname
  requests.push({ path: pathname, query: url.search, method: request.method() })
  const ok = (json) => route.fulfill({ json })
  const fail = (status, resource) =>
    route.fulfill({
      status,
      json: {
        msg:
          status === 403
            ? `无权访问该空间${resource}`
            : status === 404
              ? `该空间${resource}已不可见`
              : `${resource}连接暂时中断，请稍后重试`,
      },
    })
  if (pathname === '/api/auth/me') return ok({ user })
  if (pathname === '/api/spaces') return spacesStatus === 200 ? ok(spaces) : fail(spacesStatus, '空间')
  if (/^\/api\/spaces\/\d+\/members$/.test(pathname))
    return membersStatus === 200 ? ok({ members }) : fail(membersStatus, '成员')
  if (pathname === '/api/docs/search') {
    const query = url.searchParams.get('q') || ''
    const hold = heldSearches.get(query)
    if (hold) {
      hold.seen.resolve()
      await hold.release.promise
    }
    try {
      return await ok(resultFor(query))
    } finally {
      hold?.served.resolve()
    }
  }
  if (pathname === '/api/docs')
    return docsStatus === 200
      ? ok(docs.filter((doc) => doc.space_id === Number(url.searchParams.get('spaceId'))))
      : fail(docsStatus, '内容')
  const preview = pathname.match(/^\/api\/docs\/([^/]+)\/(history|replay)$/)
  if (preview) {
    if (preview[2] === 'history') return ok({ rev: revision, ops: [] })
    return ok({
      rev: Number(url.searchParams.get('rev')),
      elements: [
        { id: 'body-1', type: 'TEXT', fields: { order: { value: 100 }, text: { value: bodyText } } },
      ],
    })
  }
  if (pathname.startsWith('/api/docs/')) {
    const doc = docs.find((doc) => doc.doc_key === pathname.split('/').at(-1))
    return doc ? ok(doc) : route.fulfill({ status: 404, json: { msg: '内容不存在' } })
  }
  if (pathname === '/api/stats') return ok({ spaces: spaces.length, documents: docs.length, operations: 0 })
  return ok({})
})

async function showNav() {
  const button = page.getByRole('button', { name: '打开导航', exact: true })
  if (
    (await button.isVisible()) &&
    !(await page.locator('.app-sidebar').evaluate((element) => element.classList.contains('open')))
  )
    await button.click()
}

async function nav(name) {
  await showNav()
  await page.locator('.workbench-nav').getByRole('link', { name, exact: true }).click()
}

async function selectSpace(name) {
  await showNav()
  await page
    .getByRole('navigation', { name: '空间列表' })
    .getByRole('button', { name: new RegExp(name) })
    .click()
}

async function shot(name) {
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true, animations: 'disabled' })
}

async function refresh() {
  const button = page.getByRole('button', { name: '刷新内容', exact: true })
  const response = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/docs')
  await button.click()
  await response
  await page.waitForFunction(() => !document.querySelector('[aria-label="刷新内容"]')?.disabled)
}

async function readyPreview() {
  await page.locator('[data-preview-key="current-plan"][data-preview-status="ready"]').waitFor()
}

async function flushUI() {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )
}

const searchRequests = () => requests.filter((request) => request.path === '/api/docs/search')
const aborted = (query) =>
  page.waitForEvent('requestfailed', {
    predicate: (request) => {
      const url = new URL(request.url())
      return url.pathname === '/api/docs/search' && url.searchParams.get('q') === query
    },
  })

try {
  await page.goto(`${base}/#/?space=501`)
  await page.locator('.document-row').filter({ hasText: docs[0].title }).waitFor()
  assert.equal(await page.locator('.space-nav button').count(), 1)
  spaces.push(invitedSpace)
  await refresh()
  await page.locator('.space-nav button').filter({ hasText: invitedSpace.name }).waitFor()
  await selectSpace(invitedSpace.name)
  await page.locator('.document-row').filter({ hasText: docs[1].title }).waitFor()
  assert.equal(await page.locator('.document-row').filter({ hasText: docs[0].title }).count(), 0)
  assert.equal(new URL(page.url().split('#')[1], base).searchParams.get('space'), '502')
  await shot('invited-space-desktop')
  pass('停留首页时点击刷新即可发现新邀请空间，切换后只显示该空间内容')

  await selectSpace(spaces[0].name)
  await page.locator('.document-row').filter({ hasText: docs[0].title }).waitFor()
  await nav('文档')
  await readyPreview()
  assert.match(await page.locator('.library-document-excerpt').textContent(), /刷新前的协作记录/)
  const historyBefore = requests.filter((request) => request.path.endsWith('/history')).length
  revision = 12
  bodyText = '同一秒内新增的正文也应该在刷新后立即出现。'
  await refresh()
  await readyPreview()
  await page.locator('.library-document-excerpt').filter({ hasText: bodyText }).waitFor()
  assert.equal(docs[0].updated_at, timestamp)
  assert.equal(requests.filter((request) => request.path.endsWith('/history')).length, historyBefore + 1)
  assert.ok(requests.some((request) => request.path.endsWith('/replay') && request.query === '?rev=12'))
  await shot('preview-refreshed-desktop')
  pass('updated_at 未改变时手动刷新仍重新读取版本和正文，不保留同秒旧摘要')

  await nav('空间首页')
  spacesStatus = 503
  docsStatus = 503
  membersStatus = 503
  await refresh()
  await page.getByText('暂时无法加载内容', { exact: true }).waitFor()
  await page.getByText('暂时无法加载空间', { exact: true }).waitFor()
  assert.equal(await page.locator('.document-row').filter({ hasText: docs[0].title }).count(), 1)
  await nav('空间成员')
  await page.getByText('暂时无法加载成员', { exact: true }).waitFor()
  assert.equal(await page.locator('.member-row').count(), 2)
  assert.match(await page.locator('.member-list').textContent(), /协作伙伴南风/)
  pass('普通 503 网络中断显示重试提示，同时保留当前空间已加载的内容和成员')

  docsStatus = 403
  membersStatus = 403
  await page.getByRole('button', { name: '重新加载成员', exact: true }).click()
  await page.getByText('无权访问该空间成员', { exact: true }).waitFor()
  assert.equal(await page.locator('.member-row').count(), 0)
  assert.doesNotMatch(await page.locator('.dashboard-content').textContent(), /协作伙伴南风/)
  await nav('空间首页')
  await page.getByText('无权访问该空间内容', { exact: true }).waitFor()
  assert.equal(await page.locator('.document-row,.recent-work-item').count(), 0)
  assert.doesNotMatch(await page.locator('.dashboard-content').textContent(), /当前空间的项目计划/)
  pass('成员重试确认 403 后清除缓存名单和文档标题，空间列表失联也不继续展示旧内容')

  for (const status of [403, 404]) {
    docsStatus = 200
    membersStatus = 200
    await page.getByRole('button', { name: '重新加载内容', exact: true }).click()
    await page.locator('.document-row').filter({ hasText: docs[0].title }).waitFor()
    docsStatus = status
    membersStatus = status
    await refresh()
    await page
      .getByText(status === 403 ? '无权访问该空间内容' : '该空间内容已不可见', { exact: true })
      .waitFor()
    assert.equal(await page.locator('.document-row,.recent-work-item').count(), 0)
    await nav('空间成员')
    await page
      .getByText(status === 403 ? '无权访问该空间成员' : '该空间成员已不可见', { exact: true })
      .waitFor()
    assert.equal(await page.locator('.member-row').count(), 0)
    if (status === 403) await shot('access-removed-desktop')
    await nav('空间首页')
  }
  pass('完整刷新收到 403 或 404 时均清空失去权限的文档与成员，明确显示错误')

  spacesStatus = 200
  docsStatus = 200
  membersStatus = 200
  await page.reload()
  await page.locator('.document-row').filter({ hasText: docs[0].title }).waitFor()
  await page.clock.install()
  const search = page.getByRole('combobox', { name: '搜索当前可见内容' })
  const routeBeforeSearch = page.url()
  await search.fill('准备')
  await page.clock.fastForward(350)
  await page.getByRole('option').filter({ hasText: '搜索键盘操作预备结果' }).waitFor()
  await search.press('ArrowDown')
  assert.equal(await page.getByRole('option').getAttribute('aria-selected'), 'true')
  for (const code of ['isComposing', 'keyCode229']) {
    await search.evaluate((element, code) => {
      for (const key of ['Enter', 'Escape'])
        element.dispatchEvent(
          new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key,
            ...(code === 'isComposing' ? { isComposing: true } : { keyCode: 229 }),
          }),
        )
    }, code)
    assert.equal(page.url(), routeBeforeSearch)
    assert.equal(await search.getAttribute('aria-expanded'), 'true')
    assert.equal(await page.getByRole('option').getAttribute('aria-selected'), 'true')
  }
  pass('搜索结果已有选中项时，IME Enter/Escape 与 keyCode 229 均不会误打开或关闭')

  const countBeforeComposition = searchRequests().length
  await search.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    element.value = 'zhongwen'
    element.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: 'zhongwen' }))
    for (const key of ['Enter', 'Escape'])
      element.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key, isComposing: true, cancelable: true }),
      )
  })
  await page.clock.fastForward(700)
  assert.equal(searchRequests().length, countBeforeComposition)
  assert.equal(await search.getAttribute('aria-expanded'), 'false')
  assert.equal(page.url(), routeBeforeSearch)
  await search.evaluate((element) => {
    element.value = '中文协作'
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文协作' }))
    element.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: false, data: '中文协作' }))
  })
  await page.clock.fastForward(350)
  await page.getByRole('option').filter({ hasText: '中文协作的最终搜索结果' }).waitFor()
  const composedQueries = searchRequests()
    .slice(countBeforeComposition)
    .map((request) => new URLSearchParams(request.query).get('q'))
  assert.deepEqual(composedQueries, ['中文协作'])
  pass('中文组合输入超过防抖周期也不发送中间词，compositionend 后只查询最终中文词')

  assert.equal(await search.getAttribute('maxlength'), '100')
  await search.fill('')
  await page.keyboard.insertText('界'.repeat(120))
  assert.equal((await search.inputValue()).length, 100)
  await page.clock.fastForward(350)
  await page.getByRole('option').filter({ hasText: '长度限制后的搜索结果' }).waitFor()
  assert.equal(new URLSearchParams(searchRequests().at(-1).query).get('q').length, 100)
  pass('搜索输入限制 100 字，粘贴超长内容也不会向接口发送超限查询')

  const early = holdSearch('早期')
  await search.fill('早期')
  await page.clock.fastForward(350)
  await bounded(early.seen.promise, '早期搜索已发出')
  const earlyAborted = aborted('早期')
  await search.fill('最新')
  await page.clock.fastForward(350)
  await earlyAborted
  await page.getByRole('option').filter({ hasText: '应当保留的最新搜索结果' }).waitFor()
  early.release.resolve()
  await bounded(early.served.promise, '早期搜索已释放')
  await flushUI()
  assert.equal(await page.getByRole('option').count(), 1)
  assert.match(await page.getByRole('option').textContent(), /应当保留的最新搜索结果/)
  assert.doesNotMatch(await page.locator('.search-popover').textContent(), /迟到的早期搜索结果/)
  pass('更换搜索词会取消上一请求，迟到旧响应无法覆盖最新结果')

  const late = holdSearch('迟到')
  await search.fill('迟到')
  await page.clock.fastForward(350)
  await bounded(late.seen.promise, '待关闭搜索已发出')
  const lateAborted = aborted('迟到')
  await page.getByRole('button', { name: '关闭搜索结果', exact: true }).click()
  await lateAborted
  late.release.resolve()
  await bounded(late.served.promise, '已关闭搜索已释放')
  await flushUI()
  assert.equal(await search.getAttribute('aria-expanded'), 'false')
  assert.equal(await page.locator('.search-popover').count(), 0)
  assert.equal(page.url(), routeBeforeSearch)
  assert.equal(abortedSearches.filter((request) => request.query === '早期').length, 1)
  assert.equal(abortedSearches.filter((request) => request.query === '迟到').length, 1)
  pass('关闭搜索结果会取消请求，迟到响应不会重新打开结果弹层')

  await search.fill('中文协作')
  await page.clock.fastForward(350)
  await page.getByRole('option').filter({ hasText: '中文协作的最终搜索结果' }).waitFor()
  await shot('search-desktop')
  await page.setViewportSize({ width: 320, height: 900 })
  await page.getByRole('option').filter({ hasText: '中文协作的最终搜索结果' }).waitFor()
  await shot('search-320')
  assert.ok(
    await page.evaluate(
      () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= innerWidth + 1,
    ),
    '320px 搜索结果横向溢出',
  )
  await page.getByRole('button', { name: '关闭搜索结果', exact: true }).click()
  await nav('文档')
  await readyPreview()
  await page.waitForFunction(() => document.querySelector('.app-sidebar').getBoundingClientRect().right <= 0)
  await shot('preview-refreshed-320')
  assert.ok(
    await page.evaluate(
      () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= innerWidth + 1,
    ),
    '320px 文档栏目横向溢出',
  )
  pass('桌面与 320px 搜索弹层和刷新后的文档摘要布局完整，无页面横向溢出')
  assert.deepEqual(errors, [])
  await fs.writeFile(
    path.join(out, 'summary.json'),
    JSON.stringify({ status: 'passed', checks, errors, abortedSearches, requests }, null, 2),
  )
} catch (error) {
  for (const hold of heldSearches.values()) hold.release.resolve()
  await shot('failure')
  await fs.writeFile(
    path.join(out, 'summary.json'),
    JSON.stringify(
      { status: 'failed', checks, errors, error: String(error), abortedSearches, requests },
      null,
      2,
    ),
  )
  throw error
} finally {
  await browser.close()
}
