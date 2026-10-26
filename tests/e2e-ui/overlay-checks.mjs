import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

// All API and websocket traffic is mocked. This suite never changes local user data.
const base = process.env.E2E_BASE_URL || 'http://localhost:5173'
const out = path.resolve(process.env.E2E_OUTPUT_DIR || 'artifacts/ui-overlay-polish-20261022')
await fs.mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
const checks = []
const errors = []
const apiRequests = []
page.on('pageerror', error => errors.push(error.message))
const pass = label => { checks.push(label); console.log('PASS', label) }
const user = { id: 99001, username: 'overlay_check', nickname: '交互检查', avatarUrl: '' }
const documentData = {
  doc_key: 'overlay-check', kind: 'doc', title: '交互检查文档',
  space_id: 99001, space_name: '交互检查空间', my_role: 'owner', updated_at: '2026-10-22T10:00:00',
}

await page.addInitScript(() => localStorage.setItem('collab_access_token', 'mock-overlay-check'))
await page.route('**/api/**', async route => {
  const request = route.request()
  const url = new URL(request.url())
  apiRequests.push(`${request.method()} ${url.pathname}`)
  let result
  if (url.pathname === '/api/auth/me') result = user
  else if (url.pathname === '/api/spaces') result = [{ id: 99001, name: '交互检查空间', my_role: 'owner', doc_count: 1 }]
  else if (url.pathname.endsWith('/members')) result = { members: [{ ...user, role: 'owner' }] }
  else if (url.pathname === '/api/stats') result = { spaces: 1, documents: 1, operations: 2 }
  else if (url.pathname === '/api/docs') result = [documentData]
  else if (url.pathname.endsWith('/history')) result = { rev: 2, ops: [] }
  else if (url.pathname.endsWith('/replay')) result = { rev: Number(url.searchParams.get('rev')), elements: [] }
  else if (url.pathname === '/api/docs/overlay-check') result = documentData
  else if (url.pathname === '/api/docs/search') result = [documentData]
  else throw new Error(`Unexpected mocked API request: ${request.method()} ${url.pathname}`)
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) })
})
await page.routeWebSocket(/\/ws(?:\?|\/|$)/, socket => {
  socket.onMessage(raw => {
    const message = JSON.parse(String(raw))
    if (message.type === 'hello') socket.send(JSON.stringify({ type: 'welcome', snapshot: [], rev: 2, role: 'owner', canWrite: true }))
    if (message.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }))
  })
})

async function locked() {
  return page.evaluate(() => document.body.classList.contains('modal-open'))
}

async function focused(locator) {
  await locator.waitFor()
  await page.waitForFunction(element => document.activeElement === element, await locator.elementHandle())
}

try {
  await page.goto(base)
  await page.locator('.document-row').waitFor()
  const createTrigger = page.getByRole('button', { name: '新建内容', exact: true })
  await createTrigger.click()
  let dialog = page.getByRole('dialog', { name: '新建文档', exact: true })
  await focused(dialog.getByLabel('标题', { exact: true }))
  assert.equal(await locked(), true)
  await dialog.getByRole('button', { name: '创建并打开', exact: true }).focus()
  await page.keyboard.press('Tab')
  await focused(dialog.getByRole('button', { name: '关闭', exact: true }))
  await page.keyboard.press('Shift+Tab')
  await focused(dialog.getByRole('button', { name: '创建并打开', exact: true }))
  await createTrigger.evaluate(element => element.focus())
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('[role="dialog"]')), true)
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  await focused(createTrigger)
  assert.equal(await locked(), false)
  pass('创建弹窗自动聚焦、双向 Tab 循环、阻止背景抢焦点、Esc 返回触发按钮')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForFunction(() => document.querySelector('.app-sidebar').inert)
  await page.evaluate(() => document.activeElement.blur())
  await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('.app-sidebar')), false)
  const menu = page.getByRole('button', { name: '打开导航', exact: true })
  await menu.click()
  const drawer = page.getByRole('dialog', { name: '工作台导航', exact: true })
  await focused(drawer.getByRole('button', { name: '关闭导航', exact: true }))
  assert.equal(await page.locator('.app-main').evaluate(element => element.inert), true)
  assert.equal(await locked(), true)
  await drawer.getByRole('button', { name: '退出登录', exact: true }).focus()
  await page.keyboard.press('Tab')
  await focused(drawer.getByRole('button', { name: '关闭导航', exact: true }))
  await page.keyboard.press('Escape')
  await focused(menu)
  assert.equal(await page.locator('.app-main').evaluate(element => element.inert), false)
  assert.equal(await locked(), false)
  pass('手机导航关闭时不可聚焦，打开后锁定背景并循环焦点，关闭恢复菜单按钮')

  await menu.click()
  await drawer.getByRole('button', { name: '创建空间', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '创建空间', exact: true })
  await focused(dialog.getByLabel('空间名称', { exact: true }))
  assert.equal(await page.locator('.app-sidebar').evaluate(element => element.inert), true)
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  await focused(drawer.getByRole('button', { name: '创建空间', exact: true }))
  assert.equal(await locked(), true)
  assert.equal(await page.locator('.app-main').evaluate(element => element.inert), true)
  await page.keyboard.press('Escape')
  await focused(menu)
  assert.equal(await locked(), false)
  pass('导航上打开创建弹窗时只关闭最上层，导航焦点与滚动锁保持正确')

  await menu.click()
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.waitForFunction(() => !document.querySelector('.app-main').inert && !document.body.classList.contains('modal-open'))
  assert.equal(await page.locator('.app-sidebar').evaluate(element => element.inert), false)
  assert.equal(await page.locator('.mobile-overlay').count(), 0)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForFunction(() => document.querySelector('.app-sidebar').inert)
  assert.equal(await page.locator('.app-main').evaluate(element => element.inert), false)
  pass('导航打开时切换桌面宽度恢复正常，切回手机导航保持收起')

  await page.setViewportSize({ width: 1440, height: 960 })
  await page.locator('.document-row').click()
  const historyTrigger = page.getByRole('button', { name: '历史', exact: true })
  await historyTrigger.click()
  const history = page.getByRole('dialog', { name: '版本历史', exact: true })
  await history.getByLabel('定位版本', { exact: true }).fill('1')
  await history.getByRole('button', { name: '查看', exact: true }).click()
  const restore = history.getByRole('button', { name: '恢复到此版本', exact: true })
  await page.waitForFunction(element => !element.disabled, await restore.elementHandle())
  await restore.click()
  const confirm = page.getByRole('dialog', { name: '恢复历史版本', exact: true })
  await focused(confirm.getByRole('button', { name: '关闭', exact: true }))
  assert.equal(await page.locator('.modal-backdrop[inert]').count(), 1)
  await confirm.getByRole('button', { name: '确认恢复', exact: true }).focus()
  await page.keyboard.press('Tab')
  await focused(confirm.getByRole('button', { name: '关闭', exact: true }))
  await page.keyboard.press('Escape')
  await confirm.waitFor({ state: 'detached' })
  await focused(restore)
  assert.equal(await locked(), true)
  assert.equal(await page.locator('.modal-backdrop[inert]').count(), 0)
  assert.equal(await history.count(), 1)
  await page.keyboard.press('Escape')
  await history.waitFor({ state: 'detached' })
  await focused(historyTrigger)
  assert.equal(await locked(), false)
  pass('历史嵌套确认框按层关闭，底层历史保留，最终恢复历史入口焦点和页面滚动')

  await page.goto(`${base}/#/profile`)
  const nickname = page.getByLabel('昵称', { exact: true })
  await page.waitForFunction(element => !element.disabled, await nickname.elementHandle())
  await nickname.fill('尚未保存的名字')
  const back = page.getByRole('link', { name: '返回工作台', exact: true })
  await back.click()
  dialog = page.getByRole('dialog', { name: '昵称还没有保存', exact: true })
  await focused(dialog.getByRole('button', { name: '关闭', exact: true }))
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  await focused(back)
  assert.ok(page.url().endsWith('#/profile'))
  assert.equal(await nickname.inputValue(), '尚未保存的名字')
  assert.equal(await locked(), false)
  await back.click()
  await page.getByRole('button', { name: '放弃修改并离开', exact: true }).click()
  await page.locator('.document-row').waitFor()
  assert.equal(await locked(), false)
  pass('个人资料离开确认支持 Esc 取消且保留输入，确认跳转后清理焦点与滚动锁')

  assert.deepEqual(errors, [])
  assert.ok(apiRequests.every(request => request.startsWith('GET ')), 'No mutation API should be called')
  pass('浏览器无脚本错误，所有数据与连接均模拟且没有写请求')
  await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify({ status: 'passed', checks, errors }, null, 2))
} catch (error) {
  await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true })
  await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify({ status: 'failed', checks, errors, error: String(error) }, null, 2))
  throw error
} finally {
  await browser.close()
}
