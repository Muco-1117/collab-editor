import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const base = process.env.E2E_BASE_URL || 'http://localhost:5173'
const out = path.resolve(process.env.E2E_OUTPUT_DIR || 'artifacts/two-hour-20261022/history-assets')
await fs.mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
const page = await context.newPage()
page.setDefaultTimeout(10_000)
const checks = [], errors = []
const pass = (label) => { checks.push(label); console.log('PASS', label) }
page.on('pageerror', (error) => errors.push(error.message))
const user = { id: 907001, username: 'history_quality', nickname: '版本检查', avatarUrl: '' }
const doc = { doc_key: 'history-assets', kind: 'doc', title: '项目设计与讨论记录', space_id: 501, space_name: '项目协作空间', my_role: 'owner' }
const element = (id, type, values, clock = 'seed:1') => ({ id, type, rootClock: clock, fields: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, clock }])) })
const current = [
  element('paragraph', 'TEXT', { text: '共同记录设计决定，让每一次修改都可以追溯。', order: 100 }),
  element('picture', 'IMAGE', { assetId: 'picture', name: '设计草图.png', width: 180, height: 120, order: 200 }),
]
let png, activeSocket, rev = 4, failHistory = false, failPreview = false, failAsset = true
let restoreCount = 0, failRestore = false, restoreGate, releaseRestore, restoreSeen, resolveRestoreSeen
let uploadCount = 0, uploadGate, releaseUpload, uploadSeen, resolveUploadSeen
let operations = []
await context.addInitScript(() => localStorage.setItem('collab_access_token', 'history-assets-mock'))
await context.route('**/api/**', async (route) => {
  const request = route.request(), url = new URL(request.url())
  const fail = (msg) => route.fulfill({ status: 503, json: { msg } })
  if (url.pathname === '/api/auth/me') return route.fulfill({ json: { user } })
  if (url.pathname === '/api/docs') return route.fulfill({ json: [doc] })
  if (url.pathname === '/api/docs/history-assets') return route.fulfill({ json: doc })
  if (url.pathname.startsWith('/api/assets/')) return failAsset ? fail('图片读取中断') : route.fulfill({ contentType: 'image/png', body: png })
  if (url.pathname.endsWith('/history')) return failHistory ? fail('历史记录暂时不可用') : route.fulfill({ json: {
    rev, ops: [1, 2, 3, 4].filter((seq) => seq <= rev).reverse().map((seq) => ({ seq, clock: `STATE|seed:${seq}`, element_type: 'TEXT', element_id: 'paragraph', actor_name: '林同学', value_json: JSON.stringify({ text: `第 ${seq} 次讨论记录` }), created_at: '2026-10-22T15:00:00' })),
  } })
  if (url.pathname.endsWith('/replay')) {
    const target = Number(url.searchParams.get('rev'))
    return failPreview ? fail('预览暂时无法生成') : route.fulfill({ json: { rev: target, elements: target === rev ? current : [element('paragraph', 'TEXT', { text: `第 ${target} 版讨论内容`, order: 100 })] } })
  }
  if (url.pathname.endsWith('/restore')) {
    restoreCount++
    if (restoreGate) { resolveRestoreSeen(); await restoreGate }
    return failRestore ? fail('恢复暂时未完成，请重试') : route.fulfill({ json: { rev: ++rev } })
  }
  if (url.pathname.endsWith('/images')) {
    uploadCount++
    if (uploadGate) { resolveUploadSeen(); await uploadGate }
    return route.fulfill({ json: { assetId: 'uploaded', name: 'uploaded.png', width: 180, height: 120 } })
  }
  return route.fulfill({ json: {} })
})
await context.routeWebSocket(/\/ws(?:\?|\/|$)/, (socket) => {
  activeSocket = socket
  socket.onMessage((raw) => {
    const message = JSON.parse(String(raw))
    if (message.type === 'hello') socket.send(JSON.stringify({ type: 'welcome', rev, role: 'owner', canWrite: true, snapshot: current }))
    if (message.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }))
    if (message.type === 'op') {
      operations.push(message.op)
      socket.send(JSON.stringify({ type: 'applied', rev: ++rev, op: message.op }))
    }
  })
})
const screenshot = (name) => page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true, animations: 'disabled' })
const uploadFile = { name: '草图.png', mimeType: 'image/png' }
try {
  await page.goto(`${base}/#/work/doc/history-assets`)
  await page.locator('.connection-success').waitFor()
  png = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 180; canvas.height = 120
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#edf2ff'; ctx.fillRect(0, 0, 180, 120)
    ctx.fillStyle = '#4263eb'; ctx.fillRect(24, 28, 60, 60)
    return canvas.toDataURL('image/png').split(',')[1]
  }), 'base64')
  uploadFile.buffer = png
  const assetRetry = page.getByRole('button', { name: '重新加载图片：设计草图.png', exact: true })
  await assetRetry.waitFor()
  failAsset = false
  await assetRetry.click()
  await page.waitForFunction(() => {
    const image = document.querySelector('.document-image img')
    return image?.complete && image.naturalWidth === 180
  })
  assert.equal(operations.length, 0)
  pass('图片读取失败可以独立重试，重试不产生编辑操作')

  const upload = page.getByLabel('插入图片', { exact: true })
  await upload.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not image') })
  await page.getByText('仅支持 PNG、JPEG、GIF 图片', { exact: true }).waitFor()
  await upload.setInputFiles({ name: 'empty.png', mimeType: 'image/png', buffer: Buffer.alloc(0) })
  await page.getByText('图片文件为空，请重新选择', { exact: true }).waitFor()
  await upload.setInputFiles({ name: 'large.png', mimeType: 'image/png', buffer: Buffer.alloc(8 * 1024 * 1024 + 1) })
  await page.getByText('图片大小不能超过 8MB', { exact: true }).waitFor()
  assert.equal(uploadCount, 0)
  pass('不支持的格式、空文件和超大图片在上传前给出明确提示')

  failHistory = true
  await page.getByRole('button', { name: '历史', exact: true }).click()
  let history = page.getByRole('dialog', { name: '版本历史', exact: true })
  await history.getByRole('button', { name: '重试历史记录', exact: true }).waitFor()
  failHistory = false
  await history.getByRole('button', { name: '重试历史记录', exact: true }).click()
  await history.locator('.history-entry').nth(3).waitFor()
  failPreview = true
  await history.locator('.history-entry').filter({ hasText: 'rev 2' }).click()
  await history.getByRole('button', { name: '重试版本预览', exact: true }).waitFor()
  assert.equal(await history.getByRole('button', { name: '恢复到此版本', exact: true }).isDisabled(), true)
  failPreview = false
  await history.getByRole('button', { name: '重试版本预览', exact: true }).click()
  await history.getByText('第 2 版讨论内容', { exact: true }).waitFor()
  assert.equal(await history.getByRole('button', { name: '恢复到此版本', exact: true }).isEnabled(), true)
  pass('历史列表和单个版本预览都能独立重试，预览失败时不能恢复错误内容')

  activeSocket.send(JSON.stringify({ type: 'applied', rev: ++rev, op: { type: 'STATE', elementId: 'paragraph', elementType: 'TEXT', clock: 'peer:20', value: { text: '远端新增的讨论', order: 100 } } }))
  await history.getByText('内容有新修改', { exact: true }).waitFor()
  await history.getByRole('button', { name: '刷新历史', exact: true }).click()
  await history.locator('.history-current').filter({ hasText: 'rev 5' }).waitFor()
  await history.locator('.history-entry').filter({ hasText: 'rev 2' }).click()
  await history.getByText('第 2 版讨论内容', { exact: true }).waitFor()
  await screenshot('history-desktop')
  await page.setViewportSize({ width: 320, height: 800 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
  await screenshot('history-320')
  pass('打开历史期间收到新修改时可刷新记录，桌面和320px预览可用')

  failRestore = true
  await history.getByRole('button', { name: '恢复到此版本', exact: true }).click()
  await page.getByRole('dialog', { name: '恢复历史版本', exact: true }).getByRole('button', { name: '确认恢复', exact: true }).click()
  await page.getByText('恢复暂时未完成，请重试', { exact: true }).waitFor()
  await history.getByRole('button', { name: '恢复到此版本', exact: true }).waitFor({ state: 'visible' })
  failRestore = false
  restoreGate = new Promise((resolve) => { releaseRestore = resolve })
  restoreSeen = new Promise((resolve) => { resolveRestoreSeen = resolve })
  await history.getByRole('button', { name: '恢复到此版本', exact: true }).click()
  await page.getByRole('dialog', { name: '恢复历史版本', exact: true }).getByRole('button', { name: '确认恢复', exact: true }).click()
  await restoreSeen
  await page.keyboard.press('Escape')
  assert.equal(await history.count(), 1)
  assert.equal(await history.getByRole('button', { name: '关闭', exact: true }).first().isDisabled(), true)
  assert.equal(await history.getByLabel('定位版本', { exact: true }).isDisabled(), true)
  assert.equal(restoreCount, 2)
  releaseRestore(); restoreGate = null
  await history.waitFor({ state: 'detached' })
  await page.locator('.connection-success').waitFor()
  pass('恢复失败可重试，恢复进行中不能关弹窗、切版本或重复提交')

  uploadGate = new Promise((resolve) => { releaseUpload = resolve })
  uploadSeen = new Promise((resolve) => { resolveUploadSeen = resolve })
  await upload.setInputFiles(uploadFile)
  await uploadSeen
  activeSocket.send(JSON.stringify({ type: 'access', role: 'viewer', canWrite: false, message: '当前权限已调整为只读' }))
  await page.locator('.readonly-strip').waitFor()
  releaseUpload(); uploadGate = null
  await page.waitForTimeout(120)
  assert.equal(operations.length, 0)
  assert.equal(await page.locator('.document-image').count(), 1)
  assert.equal(await page.getByRole('button', { name: '插入图片', exact: true }).count(), 0)
  pass('上传过程中失去编辑权限会取消结果，迟到上传不会插入新图片')

  assert.deepEqual(errors, [])
  await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify({ status: 'passed', checks, errors }, null, 2))
} catch (error) {
  releaseRestore?.(); releaseUpload?.()
  await screenshot('failure')
  await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify({ status: 'failed', checks, errors, error: String(error) }, null, 2))
  throw error
} finally { await browser.close() }
