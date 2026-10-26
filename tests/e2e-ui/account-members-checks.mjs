import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const base = process.env.E2E_BASE_URL || 'http://localhost:5173'
const out = path.resolve(process.env.E2E_OUTPUT_DIR || 'artifacts/two-hour-20261022/account-members')
await fs.mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
const page = await context.newPage()
page.setDefaultTimeout(10_000)
const checks = [], errors = []
const pass = (label) => { checks.push(label); console.log('PASS', label) }
page.on('pageerror', (error) => errors.push(error.message))
const user = { id: 906001, username: 'account_quality', nickname: '林间来信', avatarUrl: '' }
let currentRole = 'owner'
let members = [
  { ...user, role: 'owner' },
  { id: 906002, username: 'team_editor', nickname: '一起完善项目的协作伙伴', role: 'editor' },
  { id: 906003, username: 'team_viewer', nickname: '周同学', role: 'viewer' },
]
let loginCount = 0, failLogin = true, loginGate, releaseLogin, loginSeen, resolveLoginSeen
let roleCount = 0, failRole = false, mutationGate, releaseMutation, mutationSeen, resolveMutationSeen
let deleteCount = 0, failDelete = false
let failProfile = false
await context.route('**/api/**', async (route) => {
  const request = route.request(), url = new URL(request.url()), method = request.method()
  const fail = (message) => route.fulfill({ status: 503, json: { msg: message } })
  if (url.pathname === '/api/auth/login') {
    loginCount++
    if (loginGate) { resolveLoginSeen(); await loginGate }
    return failLogin
      ? route.fulfill({ status: 401, json: { msg: '用户名或密码错误' } })
      : route.fulfill({ json: { token: 'account-members-mock' } })
  }
  if (url.pathname === '/api/auth/me') return failProfile ? fail('账号资料暂时无法读取') : route.fulfill({ json: { user } })
  if (url.pathname === '/api/spaces') return route.fulfill({ json: [{ id: 501, name: '产品设计协作空间', my_role: currentRole, doc_count: 0, member_count: members.length }] })
  if (url.pathname === '/api/spaces/501/members') return route.fulfill({ json: { members } })
  if (/^\/api\/spaces\/501\/members\/\d+$/.test(url.pathname)) {
    const id = Number(url.pathname.split('/').at(-1))
    if (method === 'PUT') {
      roleCount++
      if (mutationGate) { resolveMutationSeen(); await mutationGate }
      if (failRole) return fail('权限保存失败，请重试')
      members.find((member) => member.id === id).role = request.postDataJSON().role
      return route.fulfill({ json: { ok: true } })
    }
    if (method === 'DELETE') {
      deleteCount++
      if (failDelete) return fail('成员移除失败，请重试')
      members = members.filter((member) => member.id !== id)
      return route.fulfill({ json: { ok: true } })
    }
  }
  if (url.pathname === '/api/docs') return route.fulfill({ json: [] })
  if (url.pathname === '/api/stats') return route.fulfill({ json: { spaces: 1, documents: 0, operations: 0, byApplication: [], byOperation: [], recentActivity: [], contributors: [] } })
  return route.fulfill({ json: {} })
})
async function screenshot(name) { await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true, animations: 'disabled' }) }
async function openRole() {
  await page.getByRole('button', { name: '管理成员：一起完善项目的协作伙伴', exact: true }).click()
  await page.getByRole('menuitem', { name: '修改权限', exact: true }).click()
  return page.getByRole('dialog', { name: '修改成员权限', exact: true })
}
try {
  await page.goto(`${base}/#/login?redirect=${encodeURIComponent('/library/board?space=501')}`)
  await page.getByRole('heading', { name: '登录', exact: true }).waitFor()
  await page.getByRole('button', { name: '注册', exact: true }).click()
  await page.locator('input[name="username"]').fill('a')
  await page.locator('input[name="password"]').fill('123456')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '用户名需为' }).waitFor()
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.locator('input[name="username"]').fill('account_quality')
  await page.locator('input[name="password"]').fill('wrong-password')
  await page.locator('.auth-submit').click()
  await page.getByRole('alert').filter({ hasText: '用户名或密码错误' }).waitFor()
  assert.equal(await page.locator('input[name="password"]').inputValue(), 'wrong-password')
  assert.equal(await page.locator('input[name="username"]').inputValue(), 'account_quality')
  await screenshot('login-desktop')
  await page.setViewportSize({ width: 320, height: 760 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
  await screenshot('login-320')
  pass('登录失败保留输入，注册格式校验清晰，320px认证页面无横向溢出')

  failLogin = false
  loginGate = new Promise((resolve) => { releaseLogin = resolve })
  loginSeen = new Promise((resolve) => { resolveLoginSeen = resolve })
  await page.locator('input[name="password"]').fill('correct-password')
  await page.locator('.auth-submit').click()
  await loginSeen
  assert.equal(await page.getByRole('button', { name: '注册', exact: true }).isDisabled(), true)
  assert.equal(await page.locator('input[name="username"]').isDisabled(), true)
  await page.locator('.auth-form').evaluate((form) => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  assert.equal(loginCount, 2)
  releaseLogin(); loginGate = null
  await page.waitForURL('**/#/library/board?space=501')
  await page.getByRole('heading', { level: 1, name: '白板', exact: true }).waitFor()
  pass('慢登录期间不能重复提交或切换模式，成功返回原来的具体栏目')

  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto(`${base}/#/members?space=501`)
  await page.locator('.member-row').nth(2).waitFor()
  assert.equal(await page.getByRole('button', { name: '管理成员：林间来信', exact: true }).count(), 0)
  assert.equal(await page.locator('.member-row .action-menu-trigger').count(), 2)
  let dialog = await openRole()
  assert.equal(await dialog.getByRole('button', { name: '保存权限', exact: true }).isDisabled(), true)
  await dialog.getByRole('radio', { name: /^只读者/ }).check()
  failRole = true
  await dialog.getByRole('button', { name: '保存权限', exact: true }).click()
  await dialog.getByRole('alert').filter({ hasText: '权限保存失败' }).waitFor()
  assert.equal(await dialog.getByRole('radio', { name: /^只读者/ }).isChecked(), true)
  failRole = false
  mutationGate = new Promise((resolve) => { releaseMutation = resolve })
  mutationSeen = new Promise((resolve) => { resolveMutationSeen = resolve })
  await dialog.getByRole('button', { name: '保存权限', exact: true }).click()
  await mutationSeen
  await page.keyboard.press('Escape')
  assert.equal(await dialog.count(), 1)
  assert.equal(await dialog.getByRole('button', { name: '取消', exact: true }).isDisabled(), true)
  await dialog.locator('form').evaluate((form) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  assert.equal(roleCount, 2)
  releaseMutation(); mutationGate = null
  await dialog.waitFor({ state: 'detached' })
  await page.locator('.member-row').filter({ hasText: '@team_editor' }).locator('.member-role').filter({ hasText: '只读者' }).waitFor()
  pass('所有者受保护，修改成员权限可失败重试，慢请求期间防止重复保存和意外关闭')

  await screenshot('members-desktop')
  await page.setViewportSize({ width: 320, height: 900 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
  await screenshot('members-320')
  dialog = await openRole()
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
  await screenshot('member-role-320')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  pass('320px成员列表和权限弹窗可操作、没有全页横向溢出')

  await page.getByRole('button', { name: '管理成员：一起完善项目的协作伙伴', exact: true }).click()
  await page.getByRole('menuitem', { name: '移出空间', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '移出空间', exact: true })
  assert.match(await dialog.textContent(), /已经创建的内容会保留/)
  failDelete = true
  await dialog.getByRole('button', { name: '移出空间', exact: true }).click()
  await page.getByText('成员移除失败，请重试', { exact: true }).waitFor()
  assert.equal(await dialog.count(), 1)
  failDelete = false
  await dialog.getByRole('button', { name: '移出空间', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  await page.locator('.member-row').filter({ hasText: '@team_editor' }).waitFor({ state: 'detached' })
  assert.equal(deleteCount, 2)
  assert.equal(await page.locator('.member-row').count(), 2)
  pass('移出成员有明确确认，失败后可重试，成功后刷新成员列表')

  currentRole = 'viewer'
  await page.reload()
  await page.locator('.member-row').nth(1).waitFor()
  assert.equal(await page.locator('.member-row .action-menu-trigger').count(), 0)
  assert.equal(await page.getByRole('button', { name: '邀请成员', exact: true }).count(), 0)
  pass('普通成员看不到所有者专属的成员管理操作')

  failProfile = true
  await page.reload()
  await page.getByRole('button', { name: '重试连接', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => localStorage.getItem('collab_access_token')), 'account-members-mock')
  failProfile = false
  await page.getByRole('button', { name: '重试连接', exact: true }).click()
  await page.waitForURL('**/#/members?space=501')
  await page.locator('.member-row').nth(1).waitFor()
  pass('启动时账号接口临时失败保留登录凭据，重试恢复后返回原成员页面')
  assert.deepEqual(errors, [])
  await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify({ status: 'passed', checks, errors }, null, 2))
} catch (error) {
  releaseLogin?.(); releaseMutation?.()
  await screenshot('failure')
  await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify({ status: 'failed', checks, errors, error: String(error) }, null, 2))
  throw error
} finally { await browser.close() }
