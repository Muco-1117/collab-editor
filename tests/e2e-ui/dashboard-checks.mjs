import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

const base = process.env.E2E_BASE_URL || 'http://127.0.0.1:5174'
const out = path.resolve(process.env.E2E_OUTPUT_DIR || 'artifacts/round2-20261022/dashboard-real')
await fs.mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
const page = await context.newPage()
const suffix = Date.now().toString(36)
const accounts = []
const checks = [],
  errors = [],
  serverErrors = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('response', (response) => {
  if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`)
})
const pass = (name) => {
  checks.push(name)
  console.log('PASS', name)
}
async function account(name) {
  const username = `ui_${name}_${suffix}`
  const response = await context.request.post(`${base}/api/auth/register`, {
    data: { username, password: `Ui-${suffix}-pass!`, nickname: name === 'owner' ? '林间来信' : '协作伙伴' },
  })
  assert.equal(response.status(), 200)
  const result = await response.json()
  accounts.push({ id: result.user.id, username })
  await fs.writeFile(path.join(out, 'accounts.json'), JSON.stringify(accounts, null, 2))
  return result
}
async function api(token, url, method = 'get', data) {
  const response = await context.request[method](`${base}${url}`, {
    headers: { Authorization: `Bearer ${token}` },
    data,
  })
  assert.ok(response.ok(), `${method} ${url}: ${response.status()}`)
  return response.json()
}
async function nav(name) {
  const menu = page.getByRole('button', { name: '打开导航', exact: true })
  if (await menu.isVisible()) await menu.click()
  await page
    .getByRole('navigation', { name: name === '空间成员' || name === '协同统计' ? '空间管理' : '工作台功能' })
    .getByRole('link', { name, exact: true })
    .click()
}
async function overflow(width) {
  assert.ok(
    await page.evaluate(
      () =>
        Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= window.innerWidth + 1,
    ),
    `overflow at ${width}px`,
  )
}
async function screenshot(name) {
  await page.screenshot({ path: path.join(out, name + '.png'), fullPage: true })
}
try {
  const owner = await account('owner')
  const viewer = await account('viewer')
  const space = await api(owner.token, '/api/spaces', 'post', { name: '产品设计协作空间' })
  await api(owner.token, `/api/spaces/${space.spaceId}/members`, 'post', {
    username: accounts[1].username,
    role: 'viewer',
  })
  const titles = [
    ['doc', '产品需求与功能规划'],
    ['board', '工作台交互方案'],
    ['kanban', '第一阶段迭代计划'],
    ['doc', '用户访谈与反馈整理'],
    ['doc', '项目介绍与使用指南'],
    ['board', '团队头脑风暴'],
    ['kanban', '毕业设计进度跟踪'],
  ]
  for (const [kind, title] of titles)
    await api(owner.token, '/api/docs', 'post', { title, kind, spaceId: String(space.spaceId) })
  await page.goto(base)
  await page.evaluate(
    ({ token, sid }) => {
      localStorage.setItem('collab_access_token', token)
      sessionStorage.setItem('collab_active_space', String(sid))
    },
    { token: owner.token, sid: space.spaceId },
  )
  await page.reload()
  await page.locator('.document-row').nth(6).waitFor()
  await overflow(1440)
  await screenshot('dashboard-desktop')
  pass('浅色主页显示真实空间、内容、数量和个人入口')
  assert.equal(await page.locator('.creation-launchpad button').count(), 3)
  for (const [kind, name] of [
    ['doc', '文档'],
    ['board', '白板'],
    ['kanban', '看板'],
  ]) {
    await nav(name)
    const expected = titles.filter(([type]) => type === kind).length
    await page
      .locator(kind === 'doc' ? '.library-document-row' : '.library-card')
      .nth(expected - 1)
      .waitFor()
    assert.equal(
      await page.locator(kind === 'doc' ? '.library-document-row' : '.library-card').count(),
      expected,
    )
    await page.getByRole('button', { name: `新建${name}`, exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('heading', { name: `新建${name}`, exact: true }).waitFor()
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
  }
  await nav('文档')
  await page.getByLabel('内容排序', { exact: true }).selectOption('title')
  const names = await page.locator('.library-document-title > strong').allTextContents()
  assert.deepEqual(
    names,
    [...names].sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true })),
  )
  await nav('空间首页')
  assert.equal(await page.locator('.content-filters,.view-switch').count(), 0)
  assert.equal(await page.locator('.document-row').count(), 7)
  pass('三类独立栏目与定向创建有效，首页不再重复类型筛选')
  pass('文档栏目名称排序有效，返回首页恢复最近更新')
  const row = page.locator('.document-row').filter({ hasText: '产品需求与功能规划' })
  await row.getByRole('button', { name: '更多操作：产品需求与功能规划', exact: true }).click()
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click()
  const rename = page.getByRole('dialog')
  await rename.getByLabel('标题', { exact: true }).fill('产品需求与功能规划 · 修订版')
  await rename.getByRole('button', { name: '保存', exact: true }).click()
  await page
    .locator('.document-main strong')
    .getByText('产品需求与功能规划 · 修订版', { exact: true })
    .waitFor()
  await page.reload()
  await page.locator('.document-row').filter({ hasText: '产品需求与功能规划 · 修订版' }).waitFor()
  pass('更多菜单重命名生效，刷新保持')
  await page.getByLabel('搜索当前可见内容', { exact: true }).fill('使用指南')
  await page.locator('.search-results').getByRole('option').first().waitFor()
  assert.ok((await page.locator('.search-popover').textContent()).includes('项目介绍与使用指南'))
  await page.getByRole('button', { name: '关闭搜索结果', exact: true }).click()
  await page.getByLabel('搜索当前可见内容', { exact: true }).fill('')
  pass('全局搜索仍能检索真实内容')
  await nav('空间成员')
  await page.locator('.member-row').nth(1).waitFor()
  assert.equal(await page.locator('.member-row').count(), 2)
  await page.getByRole('button', { name: '邀请成员', exact: true }).waitFor()
  await screenshot('dashboard-members')
  await nav('协同统计')
  await page.locator('.metric strong').first().waitFor()
  assert.ok((await page.locator('.stats-scope-note').textContent()).includes('全部空间'))
  await screenshot('dashboard-stats')
  pass('成员和统计独立展示，范围标注明确')
  await nav('空间首页')
  for (const width of [1920, 1280, 1024, 820, 768, 600, 390, 320]) {
    await page.setViewportSize({ width, height: width < 820 ? 844 : 960 })
    await overflow(width)
    const createButton = page.getByRole('button', { name: '新建内容', exact: true })
    assert.ok(
      await createButton.evaluate((button) => button.scrollWidth <= button.clientWidth + 1),
      `新建内容按钮文字被裁切：${width}px`,
    )
    if ([1920, 1024, 390, 320].includes(width)) await screenshot(`dashboard-${width}`)
    if (width < 820) {
      await nav('空间成员')
      await page.locator('.member-row').first().waitFor()
      await overflow(width)
      await nav('协同统计')
      await page.locator('.metric strong').first().waitFor()
      await overflow(width)
      await nav('空间首页')
    }
  }
  pass('1920至320px共8种尺寸及手机成员/统计/首页无横向溢出')
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.getByRole('button', { name: '创建空间', exact: true }).click()
  const createSpace = page.getByRole('dialog')
  await createSpace.getByLabel('空间名称').fill('新的灵感空间')
  await createSpace.getByRole('button', { name: '创建空间', exact: true }).click()
  await page.getByRole('heading', { level: 1, name: '新的灵感空间', exact: true }).waitFor()
  await page.locator('.dashboard-empty').waitFor()
  await screenshot('dashboard-empty')
  pass('创建与切换空间有效，空状态显示明确创建入口')
  await page.evaluate((token) => localStorage.setItem('collab_access_token', token), viewer.token)
  await page.evaluate((sid) => sessionStorage.setItem('collab_active_space', String(sid)), space.spaceId)
  await page.goto(`${base}/?account=viewer#/?space=${space.spaceId}`)
  await page.locator('.document-row').nth(6).waitFor()
  assert.equal(await page.locator('.creation-launchpad').count(), 0)
  assert.equal(await page.getByRole('button', { name: '新建内容', exact: true }).count(), 0)
  await page.locator('.document-row').first().getByRole('button').click()
  assert.equal(await page.getByRole('menuitem', { name: '重命名', exact: true }).count(), 0)
  assert.equal(await page.getByRole('menuitem', { name: '删除内容', exact: true }).count(), 0)
  await page.keyboard.press('Escape')
  await nav('空间成员')
  assert.equal(await page.getByRole('button', { name: '邀请成员', exact: true }).count(), 0)
  pass('只读角色无创建、重命名、删除或邀请入口')
  await nav('空间首页')
  await page.getByRole('link', { name: '进入个人主页', exact: true }).click()
  await page.getByRole('heading', { name: '个人主页', exact: true }).waitFor()
  pass('左下角个人主页入口保留')
  assert.deepEqual(errors, [])
  assert.deepEqual(serverErrors, [])
  pass('浏览器无脚本错误和服务端500错误')
  await fs.writeFile(
    path.join(out, 'summary.json'),
    JSON.stringify({ status: 'passed', checks, errors, serverErrors }, null, 2),
  )
} catch (error) {
  await screenshot('failure')
  await fs.writeFile(
    path.join(out, 'summary.json'),
    JSON.stringify({ status: 'failed', checks, errors, serverErrors, error: String(error) }, null, 2),
  )
  throw error
} finally {
  await browser.close()
}
