import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

const base = process.env.E2E_BASE_URL || 'http://127.0.0.1:5174'
const output = path.resolve('artifacts/ui-profile-20261022')
await fs.mkdir(output, { recursive: true })
const account = { username: `profile_ui_${Date.now().toString(36)}`, nickname: '林间来信', password: 'Profile-ui-pass-123!' }
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
const checks = []
const check = (name) => { checks.push(name); console.log('PASS', name) }
const avatarLoaded = () => page.waitForFunction(() => {
  const img = document.querySelector('.profile-avatar img')
  return img?.complete && img.naturalWidth === 256 && img.naturalHeight === 256
})
try {
  await page.goto(`${base}/#/profile`)
  await page.waitForURL(url => url.hash.startsWith('#/login?redirect='))
  check('个人主页要求登录')
  await page.getByRole('button', { name: '注册', exact: true }).click()
  await page.locator('input[name=username]').fill(account.username)
  await page.locator('input[name=nickname]').fill(account.nickname)
  await page.locator('input[name=password]').fill(account.password)
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await page.waitForURL('**/#/profile')
  const token = await page.evaluate(() => localStorage.getItem('collab_access_token'))
  const headers = { Authorization: `Bearer ${token}` }
  const response = await context.request.get(`${base}/api/auth/me`, { headers })
  const { user } = await response.json()
  await fs.writeFile(path.join(output, 'account.json'), JSON.stringify({ id: user.id, username: account.username }))
  await page.getByRole('link', { name: '返回工作台' }).click()
  await page.locator('.sidebar-profile-link .user-avatar').click()
  await page.waitForURL('**/#/profile')
  assert.equal(await page.locator('#profile-username').getAttribute('readonly'), '')
  check('左下角头像可进入个人主页，登录名只读')
  await page.getByLabel('昵称', { exact: true }).fill('  青山来客  ')
  await page.getByRole('button', { name: '保存昵称' }).click()
  await page.getByText('昵称已更新', { exact: true }).waitFor()
  assert.equal(await page.locator('#profile-nickname').inputValue(), '青山来客')
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 400
    const g = canvas.getContext('2d'); g.fillStyle = '#dfebd9'; g.fillRect(0, 0, 600, 400)
    g.fillStyle = '#24745a'; g.beginPath(); g.arc(300, 160, 65, 0, 2 * Math.PI); g.fill()
    g.beginPath(); g.ellipse(300, 340, 140, 95, 0, 0, 2 * Math.PI); g.fill()
    return canvas.toDataURL('image/png').split(',')[1]
  })
  await page.locator('input[type=file]').setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })
  await avatarLoaded()
  check('头像上传后裁剪为256×256，昵称去除首尾空格保存')
  await page.reload()
  await avatarLoaded()
  assert.equal(await page.locator('#profile-nickname').inputValue(), '青山来客')
  const persisted = await (await context.request.get(`${base}/api/auth/me`, { headers })).json()
  assert.equal(persisted.user.nickname, '青山来客'); assert.ok(persisted.user.avatarUrl)
  check('刷新后头像与昵称保持，接口返回持久化资料')
  await page.screenshot({ path: path.join(output, 'profile-desktop.png'), fullPage: true })
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${width}px页面横向溢出`)
    await page.screenshot({ path: path.join(output, `profile-mobile-${width}.png`), fullPage: true })
  }
  check('1440、390、320px布局无横向溢出')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('link', { name: '返回工作台' }).click()
  await page.locator('.sidebar-profile-link img').waitFor()
  assert.equal(await page.locator('.sidebar-profile-link strong').textContent(), '青山来客')
  await page.screenshot({ path: path.join(output, 'dashboard-profile.png'), fullPage: true })
  await page.locator('.sidebar-profile-link strong').click()
  await avatarLoaded()
  check('左下角名字可进入个人主页，工作台同步显示头像和昵称')
  await page.locator('input[type=file]').setInputFiles({ name: 'fake.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') })
  await page.getByText('头像仅支持 PNG、JPEG 图片', { exact: true }).waitFor()
  await avatarLoaded()
  const afterInvalid = await (await context.request.get(`${base}/api/auth/me`, { headers })).json()
  assert.equal(afterInvalid.user.avatarUrl, persisted.user.avatarUrl)
  check('拒绝不支持的头像格式并保留原头像')
  await page.getByRole('link', { name: '返回工作台' }).click()
  await page.getByRole('button', { name: '退出登录' }).click()
  await page.waitForURL('**/#/login')
  await page.locator('input[name=username]').fill(account.username)
  await page.locator('input[name=password]').fill(account.password)
  await page.locator('button[type=submit]').click()
  await page.getByRole('link', { name: '进入个人主页' }).click()
  await avatarLoaded()
  assert.equal(await page.locator('#profile-nickname').inputValue(), '青山来客')
  check('退出后使用原用户名重新登录，资料仍保留')
  await page.getByRole('button', { name: '恢复默认', exact: true }).click()
  await page.getByText('已恢复默认头像', { exact: true }).waitFor()
  assert.equal(await page.locator('.profile-avatar img').count(), 0)
  assert.equal(await page.locator('.profile-avatar').textContent(), '青')
  await page.reload()
  await page.locator('.profile-avatar').waitFor()
  assert.equal(await page.locator('.profile-avatar img').count(), 0)
  check('恢复默认头像后显示昵称首字，刷新保持')
  assert.deepEqual(errors, [])
  check('浏览器无脚本错误')
  await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify({ status: 'passed', checks, errors }, null, 2))
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true })
  await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify({ status: 'failed', checks, errors, error: String(error) }, null, 2))
  throw error
} finally { await browser.close() }
