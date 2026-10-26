import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

// No real API or collaboration writes: the browser uses its actual editor while
// all metadata and websocket server events are controlled by this test.
const base = process.env.E2E_BASE_URL || 'http://localhost:5173'
const out = path.resolve(process.env.E2E_OUTPUT_DIR || 'artifacts/ui-realtime-reliability-20261022')
await fs.mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
const checks = []
const errors = []
const sockets = []
let serverRevision = 1
let joinMode = 'welcome'
let autoAcknowledge = false
let holdSync = false
let serverRole = 'owner'
const paragraphId = 'reliability-paragraph'
const seed = {
  id: paragraphId,
  type: 'TEXT',
  rootClock: 'seed:1',
  fields: {
    text: { value: '已经保存的段落', clock: 'seed:1' },
    order: { value: 1024, clock: 'seed:1' },
    '#version': { value: 'seed-version', clock: 'seed:1' },
  },
}
let snapshot = [structuredClone(seed)]
const committed = new Map()
const user = { id: 99103, username: 'reliability_check', nickname: '重连检查', avatarUrl: '' }
const documentData = {
  doc_key: 'reliability-check',
  kind: 'doc',
  title: '可靠重连检查',
  space_id: 99103,
  space_name: '检查空间',
  my_role: 'owner',
  updated_at: '2026-10-22T10:00:00',
}
const pass = (label) => {
  checks.push(label)
  console.log('PASS', label)
}
page.on('pageerror', (error) => errors.push(error.message))
await page.addInitScript(() => localStorage.setItem('collab_access_token', 'mock-reliability-check'))
await page.route('**/api/**', async (route) => {
  const request = route.request()
  const url = new URL(request.url())
  assert.equal(request.method(), 'GET', `Unexpected write: ${request.method()} ${url.pathname}`)
  let result
  if (url.pathname === '/api/auth/me') result = user
  else if (url.pathname === '/api/spaces')
    result = [{ id: 99103, name: '检查空间', my_role: 'owner', doc_count: 1 }]
  else if (url.pathname.endsWith('/members')) result = { members: [{ ...user, role: 'owner' }] }
  else if (url.pathname === '/api/stats') result = { spaces: 1, documents: 1, operations: serverRevision }
  else if (url.pathname === '/api/docs') result = [documentData]
  else if (url.pathname.endsWith('/history')) result = { rev: serverRevision, ops: [] }
  else if (url.pathname.endsWith('/replay'))
    result = { rev: Number(url.searchParams.get('rev')), elements: snapshot }
  else if (url.pathname === '/api/docs/reliability-check') result = documentData
  else throw new Error(`Unexpected API request: ${url.pathname}`)
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) })
})

function commit(operation) {
  const previous = committed.get(operation.clock)
  if (previous) {
    assert.deepEqual(previous, operation, 'Retried operation identity must retain its original payload')
    return true
  }
  committed.set(operation.clock, structuredClone(operation))
  serverRevision += 1
  const fields = Object.fromEntries(
    Object.entries(operation.value).map(([key, value]) => [key, { value, clock: operation.clock }]),
  )
  fields['#version'] = { value: operation.opId, clock: operation.clock }
  const element = { id: operation.elementId, type: operation.elementType, rootClock: operation.clock, fields }
  snapshot = snapshot.filter((item) => item.id !== operation.elementId)
  if (!operation.value['#tombstone']) snapshot.push(element)
  return false
}

function sendSync(entry) {
  const access = { role: serverRole, canWrite: serverRole !== 'viewer' }
  const message =
    joinMode === 'welcome'
      ? { type: 'welcome', rev: serverRevision, snapshot, ...access }
      : {
          type: 'incremental',
          fromRev: entry.hello.lastRev,
          toRev: serverRevision,
          ops: [...committed.values()],
          ...access,
        }
  entry.socket.send(JSON.stringify(message))
}

function acknowledge(entry, operation) {
  const duplicate = commit(operation)
  entry.socket.send(
    JSON.stringify({
      type: 'applied',
      rev: serverRevision,
      op: operation,
      ...(duplicate ? { duplicate: true } : {}),
    }),
  )
}

await page.routeWebSocket(/\/ws\/collab/, (socket) => {
  const entry = { socket, operations: [], hello: null }
  sockets.push(entry)
  socket.onMessage((raw) => {
    const message = JSON.parse(String(raw))
    if (message.type === 'hello') {
      entry.hello = message
      if (!holdSync) sendSync(entry)
    } else if (message.type === 'op') {
      entry.operations.push(message.op)
      if (autoAcknowledge) acknowledge(entry, message.op)
    } else if (message.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }))
  })
})

async function until(check, message) {
  const deadline = Date.now() + 10000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timeout: ${message}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function waitEditable(editable = true) {
  await page.waitForFunction(
    ({ paragraphId, editable }) => {
      const input = document.querySelector(`[data-paragraph-id="${paragraphId}"]`)
      return input && input.readOnly === !editable
    },
    { paragraphId, editable },
  )
}

try {
  await page.goto(`${base}/#/work/doc/reliability-check`)
  const paragraph = page.locator(`[data-paragraph-id="${paragraphId}"]`)
  await waitEditable()
  await paragraph.fill('先发送但还没到达服务器')
  await until(() => sockets[0].operations.length === 1, 'first operation')
  const first = structuredClone(sockets[0].operations[0])
  assert.equal(await paragraph.inputValue(), '先发送但还没到达服务器')
  assert.equal(await page.getByRole('button', { name: '导出', exact: true }).isDisabled(), true)
  await page.screenshot({ path: path.join(out, 'pending-desktop.png'), fullPage: true })
  pass('实际编辑器立即显示输入，未确认时同步状态可见且禁用导出')

  holdSync = true
  sockets[0].socket.close({ code: 1001, reason: 'simulated network loss before receive' })
  await page.locator('.offline-strip').waitFor()
  await waitEditable(false)
  assert.equal(await paragraph.inputValue(), '先发送但还没到达服务器')
  assert.match(await page.locator('.offline-strip').innerText(), /1 项修改等待同步/)
  await until(() => sockets.length === 2 && sockets[1].hello, 'reconnected hello')
  assert.deepEqual(sockets[1].operations, [])
  assert.equal(sockets[1].hello.clientId, sockets[0].hello.clientId)
  assert.equal(sockets[1].hello.lastRev, 1)
  sendSync(sockets[1])
  holdSync = false
  await until(() => sockets[1].operations.length === 1, 'replay after welcome')
  assert.deepEqual(sockets[1].operations[0], first)
  await waitEditable()
  assert.equal(await paragraph.inputValue(), '先发送但还没到达服务器')
  acknowledge(sockets[1], first)
  await page.waitForFunction(() =>
    document.querySelector('.connection-badge')?.textContent.includes('已连接'),
  )
  assert.equal(serverRevision, 2)
  pass('发送后断线保留内容并禁编辑，合法欢迎后按原 clientId/clock/opId 重发且确认后恢复')

  await paragraph.fill('服务端已保存但确认丢失')
  await until(() => sockets[1].operations.length === 2, 'second edit')
  const second = structuredClone(sockets[1].operations[1])
  commit(second)
  const revBeforeReconnect = serverRevision
  joinMode = 'incremental'
  autoAcknowledge = true
  sockets[1].socket.close({ code: 1001, reason: 'simulated acknowledgement loss' })
  await until(() => sockets.length === 3 && sockets[2].operations.length === 1, 'replay committed operation')
  await waitEditable()
  await page.waitForFunction(() =>
    document.querySelector('.connection-badge')?.textContent.includes('已连接'),
  )
  assert.deepEqual(sockets[2].operations[0], second)
  assert.equal(serverRevision, revBeforeReconnect, 'Duplicate replay must not create another revision')
  assert.equal(await paragraph.inputValue(), '服务端已保存但确认丢失')
  pass('服务端已经保存但确认丢失时走增量补偿与幂等确认，不产生重复版本')

  autoAcknowledge = false
  await paragraph.fill('未保存时尝试离开')
  await until(() => sockets[2].operations.length === 2, 'pending navigation edit')
  await page.getByRole('button', { name: '返回工作台', exact: true }).click()
  const leaveDialog = page.getByRole('dialog', { name: '修改还没有同步完成', exact: true })
  await leaveDialog.waitFor()
  await page.keyboard.press('Escape')
  await leaveDialog.waitFor({ state: 'detached' })
  assert.ok(page.url().includes('/work/doc/reliability-check'))
  assert.equal(await paragraph.inputValue(), '未保存时尝试离开')
  acknowledge(sockets[2], sockets[2].operations[1])
  await page.waitForFunction(() =>
    document.querySelector('.connection-badge')?.textContent.includes('已连接'),
  )
  pass('同步未完成时离开有确认，Esc 取消保留输入与当前编辑页')

  await paragraph.fill('会被拒绝的修改')
  await until(() => sockets[2].operations.length === 3, 'rejected edit')
  joinMode = 'welcome'
  sockets[2].socket.send(
    JSON.stringify({ type: 'error', code: 'INVALID_OP', message: '模拟：本次修改未通过校验', fatal: false }),
  )
  await until(() => sockets.length === 4 && sockets[3].hello, 'rejection sync')
  await waitEditable()
  assert.deepEqual(sockets[3].operations, [])
  assert.equal(await paragraph.inputValue(), '未保存时尝试离开')
  assert.match(await page.locator('.connection-alert').innerText(), /本次修改未通过校验/)
  pass('明确拒绝时恢复已确认内容，保留拒绝原因并避免自动循环重发')

  sockets[3].socket.send(
    JSON.stringify({ type: 'access', role: 'viewer', canWrite: false, message: '你的角色已变更为只读者' }),
  )
  await waitEditable(false)
  assert.match(await page.locator('.role-badge').innerText(), /只读者/)
  assert.equal(await page.getByRole('button', { name: '添加段落', exact: true }).count(), 0)
  sockets[3].socket.send(
    JSON.stringify({ type: 'access', role: 'editor', canWrite: true, message: '你的角色已变更为编辑者' }),
  )
  await waitEditable()
  assert.equal(await page.getByRole('button', { name: '添加段落', exact: true }).count(), 1)
  pass('成员角色实时降级立即只读，重新授权恢复编辑入口，无需刷新')

  await page.setViewportSize({ width: 390, height: 844 })
  await paragraph.fill('手机上保持未确认输入')
  await until(() => sockets[3].operations.length === 1, 'mobile pending edit')
  holdSync = true
  sockets[3].socket.close({ code: 1001, reason: 'mobile offline simulation' })
  await page.locator('.offline-strip').waitFor()
  await waitEditable(false)
  assert.equal(await paragraph.inputValue(), '手机上保持未确认输入')
  await page.waitForFunction(
    () => document.querySelector('.workspace-sidebar')?.getBoundingClientRect().right <= 0,
  )
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  await page.screenshot({ path: path.join(out, 'pending-mobile.png'), fullPage: true })
  await until(() => sockets.length === 5 && sockets[4].hello, 'mobile reconnect')
  autoAcknowledge = true
  holdSync = false
  sendSync(sockets[4])
  await page.waitForFunction(() =>
    document.querySelector('.connection-badge')?.textContent.includes('已连接'),
  )
  pass('手机断线保留未确认输入与等待提示，布局无横向溢出，恢复后自动完成同步')

  sockets[4].socket.send(
    JSON.stringify({ type: 'error', code: 'DOCUMENT_DELETED', message: '此内容已被删除', fatal: true }),
  )
  await page.waitForFunction(() =>
    document.querySelector('.connection-badge')?.textContent.includes('已离线'),
  )
  assert.equal(await paragraph.count(), 0)
  assert.equal(await page.getByRole('button', { name: '重新连接', exact: true }).count(), 0)
  assert.match(await page.locator('.workspace-unavailable').innerText(), /已被删除/)
  assert.equal(await page.getByRole('button', { name: '历史', exact: true }).isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: '导出', exact: true }).isDisabled(), true)
  pass('内容删除的 fatal 通知清空编辑内容并禁止重新连接到已删除房间')

  assert.deepEqual(errors, [])
  await fs.writeFile(
    path.join(out, 'summary.json'),
    JSON.stringify({ status: 'passed', checks, errors, mockOnly: true }, null, 2),
  )
} catch (error) {
  await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true })
  await fs.writeFile(
    path.join(out, 'summary.json'),
    JSON.stringify({ status: 'failed', checks, errors, error: String(error) }, null, 2),
  )
  throw error
} finally {
  await browser.close()
}
