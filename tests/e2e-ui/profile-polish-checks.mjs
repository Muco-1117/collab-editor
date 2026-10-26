import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

// UI-only checks use deterministic API responses, leaving existing accounts untouched.
const base = process.env.E2E_BASE_URL || 'http://localhost:5173'
const output = path.resolve(process.env.E2E_OUTPUT_DIR || 'artifacts/ui-profile-polish-20261022')
await fs.mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
const page = await context.newPage()
const checks = [], errors = []
let user = { id: 900001, username: 'profile_ui_preview', nickname: '林间来信', role: 'user', avatarUrl: '' }
let holdProfile = false, holdSave = false, avatarRequests = 0, avatar = null
let releaseProfile, releaseSave
const profileGate = new Promise(resolve => { releaseProfile = resolve })
const saveGate = new Promise(resolve => { releaseSave = resolve })
page.on('pageerror', error => errors.push(error.message))
const pass = name => { checks.push(name); console.log('PASS', name) }
await context.addInitScript(() => localStorage.setItem('collab_access_token', 'profile-ui-preview'))
await context.route('**/api/**', async route => {
  const request = route.request()
  const url = new URL(request.url())
  const method = request.method()
  if (url.pathname === '/api/auth/me') {
    if (method === 'PUT') {
      if (holdSave) await saveGate
      user = { ...user, nickname: request.postDataJSON().nickname.trim() }
    } else if (holdProfile) await profileGate
    return route.fulfill({ json: { user } })
  }
  if (url.pathname === '/api/auth/me/avatar') {
    avatarRequests += 1
    user = { ...user, avatarUrl: method === 'DELETE' ? '' : '/api/users/900001/avatar?v=preview' }
    return route.fulfill({ json: { user } })
  }
  if (url.pathname === '/api/users/900001/avatar') return route.fulfill({ contentType: 'image/png', body: avatar })
  if (url.pathname === '/api/spaces') return route.fulfill({ json: [] })
  return route.fulfill({ json: {} })
})
try {
  await page.goto(`${base}/#/profile`)
  await page.getByRole('heading', { name: '个人主页', exact: true }).waitFor()
  await page.getByText('资料已保存', { exact: true }).waitFor()
  const name = page.getByLabel('昵称', { exact: true })
  const save = page.getByRole('button', { name: '保存昵称', exact: true })
  assert.equal(await name.inputValue(), user.nickname)
  assert.equal(await save.isDisabled(), true)
  await name.fill('  青山来客  ')
  await page.getByText('昵称尚未保存', { exact: true }).waitFor()
  assert.equal(await save.isEnabled(), true)
  await page.getByRole('button', { name: '取消修改', exact: true }).click()
  assert.equal(await name.inputValue(), '林间来信')
  assert.equal(await save.isDisabled(), true)
  pass('未保存状态、字数与取消修改正常')

  await name.fill('临时昵称')
  await page.getByRole('link', { name: '返回工作台' }).click()
  const leaveDialog = page.getByRole('dialog', { name: '昵称还没有保存' })
  await leaveDialog.waitFor()
  await leaveDialog.getByRole('button', { name: '取消', exact: true }).click()
  assert.ok(page.url().endsWith('#/profile'))
  assert.equal(await name.inputValue(), '临时昵称')
  await page.getByRole('link', { name: '返回工作台' }).click()
  await leaveDialog.getByRole('button', { name: '放弃修改并离开' }).click()
  await page.waitForURL((url) => /^#\/(?:\?|$)/.test(url.hash))
  assert.equal(user.nickname, '林间来信')
  pass('未保存离开确认支持取消和放弃，资料不被意外覆盖')

  holdProfile = true
  await page.getByRole('link', { name: '进入个人主页', exact: true }).click()
  await page.getByText('正在加载资料', { exact: true }).waitFor()
  assert.equal(await name.isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: '更换头像', exact: true }).isDisabled(), true)
  releaseProfile(); holdProfile = false
  await page.waitForFunction(() => !document.querySelector('#profile-nickname').disabled)
  pass('资料刷新期间禁用提交，避免迟到响应覆盖新修改')

  await name.fill('  青山来客  ')
  holdSave = true
  await save.click()
  await page.getByText('正在保存修改', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '更换头像', exact: true }).isDisabled(), true)
  await page.getByRole('link', { name: '返回工作台' }).click()
  await page.getByText('正在保存，请稍候再离开', { exact: true }).waitFor()
  assert.ok(page.url().endsWith('#/profile'))
  releaseSave(); holdSave = false
  await page.getByText('昵称已更新', { exact: true }).waitFor()
  assert.equal(await name.inputValue(), '青山来客')
  assert.equal(user.nickname, '青山来客')
  pass('保存中阻止冲突操作，完成后同步昵称和状态')

  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256
    const paint = canvas.getContext('2d'); paint.fillStyle = '#e7edff'; paint.fillRect(0, 0, 256, 256)
    paint.fillStyle = '#4263eb'; paint.beginPath(); paint.arc(128, 98, 46, 0, Math.PI * 2); paint.fill()
    paint.beginPath(); paint.ellipse(128, 238, 92, 72, 0, 0, Math.PI * 2); paint.fill()
    return canvas.toDataURL('image/png').split(',')[1]
  })
  avatar = Buffer.from(png, 'base64')
  await page.locator('input[type=file]').setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: avatar })
  await page.locator('.profile-avatar img').waitFor()
  await page.waitForFunction(() => document.querySelector('.profile-avatar img')?.naturalWidth === 256)
  assert.equal(avatarRequests, 1)
  while (await page.getByRole('button', { name: '关闭提示', exact: true }).count()) {
    await page.getByRole('button', { name: '关闭提示', exact: true }).first().click()
  }
  await page.screenshot({ path: path.join(output, 'profile-desktop.png'), fullPage: true })
  for (const width of [768, 600, 390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${width}px horizontal overflow`)
    await page.screenshot({ path: path.join(output, `profile-${width}.png`), fullPage: true })
  }
  pass('桌面及768、600、390、320px布局无横向溢出')
  await page.getByRole('button', { name: '恢复默认', exact: true }).click()
  await page.getByText('已恢复默认头像', { exact: true }).waitFor()
  assert.equal(avatarRequests, 2)
  assert.equal(await page.locator('.profile-avatar img').count(), 0)
  await page.getByRole('link', { name: '返回工作台' }).click()
  await page.waitForURL((url) => /^#\/(?:\?|$)/.test(url.hash))
  pass('头像上传、恢复默认与已保存返回工作台正常')
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.getByRole('link', { name: '进入个人主页', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('#profile-nickname')?.disabled)
  await name.fill('还未保存的昵称')
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('collab:unauthorized')))
  await page.waitForURL(url => url.hash.startsWith('#/login?redirect='))
  assert.equal(await page.getByRole('dialog').count(), 0)
  pass('登录失效时允许重新登录，不被未保存提醒阻拦')
  assert.deepEqual(errors, [])
  await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify({ status: 'passed', checks, errors }, null, 2))
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true })
  await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify({ status: 'failed', checks, errors, error: String(error) }, null, 2))
  throw error
} finally { await browser.close() }
