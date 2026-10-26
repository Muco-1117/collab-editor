import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

// Deterministic responses exercise slow/error interactions without changing real accounts.
const base = process.env.E2E_BASE_URL || 'http://localhost:5173'
const output = path.resolve(process.env.E2E_OUTPUT_DIR || 'artifacts/round2-20261022/dashboard-polish')
await fs.mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
const page = await context.newPage()
const checks = [],
  errors = []
const user = {
  id: 901000,
  username: 'ui_polish_preview',
  nickname: '林间来信',
  role: 'editor',
  avatarUrl: '',
}
const spaces = [{ id: 501, name: '产品设计协作空间', my_role: 'owner', doc_count: 4, member_count: 1 }]
let docs = [
  { doc_key: 'planning', title: '产品需求与功能规划', kind: 'doc', updated_at: '2026-10-22T08:00:00' },
  { doc_key: 'guide', title: '项目介绍与使用指南', kind: 'doc', updated_at: '2026-10-21T08:00:00' },
  { doc_key: 'drawing', title: '工作台交互方案', kind: 'board', updated_at: '2026-10-20T08:00:00' },
  { doc_key: 'tasks', title: '第一阶段迭代计划', kind: 'kanban', updated_at: '2026-10-19T08:00:00' },
].map((row) => ({ ...row, space_id: 501, space_name: spaces[0].name, my_role: 'owner' }))
let failSpaces = false,
  failDocs = false,
  failMembers = false,
  failStats = false,
  failSearch = false
let holdSearch = false,
  releaseSearch,
  searchSeen,
  resolveSearchSeen
let searchGate, mutationGate, releaseMutation, mutationSeen, resolveMutationSeen
let holdMutation = false,
  createdCount = 0,
  selectedDoc = null
const pass = (name) => {
  checks.push(name)
  console.log('PASS', name)
}
page.on('pageerror', (error) => errors.push(error.message))
await context.addInitScript(() => localStorage.setItem('collab_access_token', 'ui-polish-preview'))
await context.route('**/api/**', async (route) => {
  const request = route.request(),
    url = new URL(request.url()),
    method = request.method()
  const fail = () => route.fulfill({ status: 503, json: { msg: '连接暂时中断，请稍后重试' } })
  if (url.pathname === '/api/auth/me') return route.fulfill({ json: { user } })
  if (url.pathname === '/api/spaces') {
    if (method === 'POST') {
      createdCount++
      if (holdMutation) {
        resolveMutationSeen()
        await mutationGate
      }
      // Return an error after the controlled delay; form must retain input and allow a retry.
      return fail()
    }
    return failSpaces ? fail() : route.fulfill({ json: spaces })
  }
  if (url.pathname === '/api/spaces/501/members')
    return failMembers ? fail() : route.fulfill({ json: { members: [{ ...user, role: 'owner' }] } })
  if (url.pathname === '/api/stats')
    return failStats
      ? fail()
      : route.fulfill({
          json: {
            spaces: 1,
            documents: docs.length,
            operations: 12,
            ownOperations: 8,
            byApplication: [],
            byOperation: [],
            recentActivity: [],
            contributors: [],
          },
        })
  if (url.pathname === '/api/docs/search') {
    if (holdSearch) {
      resolveSearchSeen()
      await searchGate
    }
    return failSearch
      ? fail()
      : route.fulfill({ json: docs.slice(0, 2).map((row) => ({ ...row, hit: 'title' })) })
  }
  if (url.pathname === '/api/docs') return failDocs ? fail() : route.fulfill({ json: docs })
  if (url.pathname.startsWith('/api/docs/')) {
    selectedDoc = url.pathname.split('/').at(-1)
    return route.fulfill({ status: 404, json: { msg: '仅验证打开目标' } })
  }
  return route.fulfill({ json: {} })
})
async function home() {
  await page.goto(`${base}/#/`)
  await page.getByRole('heading', { level: 1, name: spaces[0].name }).waitFor()
}
async function section(name) {
  await page
    .getByRole('navigation', { name: name === '空间成员' || name === '协同统计' ? '空间管理' : '工作台功能' })
    .getByRole('link', { name, exact: true })
    .click()
}
try {
  await home()
  await page.locator('.document-row').nth(3).waitFor()
  assert.equal(await page.locator('.content-filters,.view-switch').count(), 0)
  assert.equal(await page.locator('.workbench-breadcrumb strong').textContent(), '空间首页')
  assert.equal(
    await page
      .getByRole('navigation', { name: '工作台功能' })
      .getByRole('link', { name: '空间首页', exact: true })
      .getAttribute('aria-current'),
    'page',
  )
  await page.reload()
  await page.locator('.document-row').nth(3).waitFor()
  assert.equal(await page.locator('.document-row').count(), 4)
  assert.match(await page.locator('.document-row').first().textContent(), /产品需求与功能规划/)
  await section('文档')
  await page.getByLabel('内容排序').selectOption('title')
  await page.getByRole('link', { name: '进入个人主页', exact: true }).click()
  await page.getByRole('link', { name: '返回工作台', exact: true }).click()
  await page.locator('.library-document-row').nth(1).waitFor()
  assert.equal(await page.getByLabel('内容排序').inputValue(), 'title')
  pass('首页为跨类型最近更新，栏目排序和返回位置保留，不重复提供类型筛选')

  await section('空间首页')
  const input = page.getByRole('combobox', { name: '搜索当前可见内容' })
  await page.keyboard.press('Control+k')
  assert.equal(await input.evaluate((el) => el === document.activeElement), true)
  await input.fill('项目')
  await page.locator('.search-results').getByRole('option').nth(1).waitFor()
  await input.press('ArrowDown')
  await input.press('ArrowDown')
  assert.equal(
    await page.locator('.search-results').getByRole('option').nth(1).getAttribute('aria-selected'),
    'true',
  )
  await page.screenshot({ path: path.join(output, 'keyboard-search.png'), fullPage: true })
  await input.press('Enter')
  await page.waitForURL('**/#/work/doc/guide')
  await page.getByRole('heading', { name: '无法打开内容' }).waitFor()
  assert.equal(selectedDoc, 'guide')
  await page.getByRole('button', { name: '返回工作台' }).click()
  pass('Ctrl K、方向键与Enter选择并打开正确搜索结果')

  await input.fill('项目')
  await page.locator('.search-results').getByRole('option').first().waitFor()
  await page.locator('h1').click()
  assert.equal(await page.locator('.search-popover').count(), 0)
  await input.focus()
  await page.locator('.search-results').getByRole('option').first().waitFor()
  await page.getByRole('button', { name: '清空搜索' }).click()
  assert.equal(await input.inputValue(), '')
  assert.equal(await page.locator('.search-popover').count(), 0)
  pass('搜索支持点击外部关闭和一键清空')

  holdSearch = true
  searchGate = new Promise((resolve) => {
    releaseSearch = resolve
  })
  searchSeen = new Promise((resolve) => {
    resolveSearchSeen = resolve
  })
  await input.fill('迟到结果')
  await searchSeen
  await input.press('Escape')
  releaseSearch()
  holdSearch = false
  await page.waitForTimeout(150)
  assert.equal(await page.locator('.search-popover').count(), 0)
  await input.focus()
  await input.fill('新结果')
  await page.locator('.search-results').getByRole('option').first().waitFor()
  holdSearch = true
  searchGate = new Promise((resolve) => {
    releaseSearch = resolve
  })
  searchSeen = new Promise((resolve) => {
    resolveSearchSeen = resolve
  })
  await input.fill('其他结果')
  assert.equal(await page.locator('.search-results').getByRole('option').count(), 0)
  await searchSeen
  await page.getByRole('button', { name: '关闭搜索结果' }).click()
  releaseSearch()
  holdSearch = false
  await page.waitForTimeout(150)
  assert.equal(await page.locator('.search-popover').count(), 0)
  pass('待完成搜索关闭后不会重新展开，输入新关键词不显示旧结果')

  failSearch = true
  await input.focus()
  await input.fill('错误搜索')
  await page.getByRole('button', { name: '重新搜索' }).waitFor()
  failSearch = false
  await page.getByRole('button', { name: '重新搜索' }).click()
  await page.locator('.search-results').getByRole('option').first().waitFor()
  await input.press('Escape')
  failDocs = true
  failMembers = true
  failStats = true
  await page.reload()
  await page.getByRole('button', { name: '重新加载内容' }).waitFor()
  assert.equal(await page.locator('.dashboard-empty').count(), 0)
  await page.screenshot({ path: path.join(output, 'content-retry.png'), fullPage: true })
  failDocs = false
  await page.getByRole('button', { name: '重新加载内容' }).click()
  await page.locator('.document-row').nth(3).waitFor()
  await section('空间成员')
  await page.getByRole('button', { name: '重新加载成员' }).waitFor()
  failMembers = false
  await page.getByRole('button', { name: '重新加载成员' }).click()
  await page.locator('.member-row').waitFor()
  await section('协同统计')
  await page.getByRole('button', { name: '重新加载统计' }).waitFor()
  failStats = false
  await page.getByRole('button', { name: '重新加载统计' }).click()
  await page.locator('.metric strong').first().waitFor()
  failSpaces = true
  await page.reload()
  await page.getByRole('button', { name: '重新加载空间' }).waitFor()
  assert.equal(await page.locator('.first-space-state').count(), 0)
  failSpaces = false
  await page.getByRole('button', { name: '重新加载空间' }).click()
  await page.locator('.space-nav button').waitFor()
  pass('搜索、空间、内容、成员与统计加载失败可重试，不误报空数据')

  await section('空间首页')
  await page.getByRole('button', { name: '创建空间', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '创建空间', exact: true })
  await dialog.getByLabel('空间名称').fill('只创建一次')
  holdMutation = true
  mutationGate = new Promise((resolve) => {
    releaseMutation = resolve
  })
  mutationSeen = new Promise((resolve) => {
    resolveMutationSeen = resolve
  })
  await dialog.getByRole('button', { name: '创建空间', exact: true }).click()
  await mutationSeen
  await page.locator('#space-form').evaluate((form) => {
    form.requestSubmit()
    form.requestSubmit()
  })
  await page.keyboard.press('Escape')
  assert.equal(await dialog.isVisible(), true)
  assert.equal(await dialog.getByRole('button', { name: '关闭', exact: true }).isDisabled(), true)
  assert.equal(createdCount, 1)
  releaseMutation()
  holdMutation = false
  await dialog.getByRole('button', { name: '创建空间', exact: true }).waitFor()
  await page.waitForFunction(() => !document.querySelector('#space-form input').disabled)
  assert.equal(await dialog.getByLabel('空间名称').inputValue(), '只创建一次')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  pass('连续提交只发送一次请求，保存期间不可误关，失败保留输入')

  await page.screenshot({ path: path.join(output, 'dashboard-desktop.png'), fullPage: true })
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    await input.fill('项目')
    await page.locator('.search-results').getByRole('option').nth(1).waitFor()
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.screenshot({ path: path.join(output, `search-${width}.png`), fullPage: true })
    await input.press('Escape')
  }
  assert.deepEqual(errors, [])
  pass('手机搜索布局无横向溢出，浏览器无脚本错误')
  await fs.writeFile(
    path.join(output, 'summary.json'),
    JSON.stringify({ status: 'passed', checks, errors }, null, 2),
  )
} catch (error) {
  releaseSearch?.()
  releaseMutation?.()
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true })
  await fs.writeFile(
    path.join(output, 'summary.json'),
    JSON.stringify({ status: 'failed', checks, errors, error: String(error) }, null, 2),
  )
  throw error
} finally {
  await browser.close()
}
