import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

// Two real Vue pages share browser storage; all APIs and collaboration frames
// are test fixtures, so no real accounts or project data are changed.
const base = process.env.E2E_BASE_URL || 'http://localhost:5173'
const out = path.resolve(process.env.E2E_OUTPUT_DIR || 'artifacts/round2-20261022/cross-tab-auth')
await fs.mkdir(out, { recursive: true })
const tokenFor = (id, generation = 1) =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(
    JSON.stringify({
      uid: id,
      sub: `cross_tab_${id}`,
      iat: generation,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url')}.mock-signature`
const users = new Map([
  [99601, { id: 99601, username: 'cross_tab_99601', nickname: '第一位协作者', avatarUrl: '' }],
  [99602, { id: 99602, username: 'cross_tab_99602', nickname: '第二位协作者', avatarUrl: '' }],
  [99603, { id: 99603, username: 'cross_tab_99603', nickname: '第三位协作者', avatarUrl: '' }],
])
const documentFor = (id) => ({
  doc_key: `cross-tab-document-${id}`,
  title: `${users.get(id).nickname}的专属文档`,
  kind: 'doc',
  space_id: id,
  space_name: `${users.get(id).nickname}的空间`,
  my_role: 'owner',
  updated_at: '2026-10-22T10:00:00',
})
const identity = (token) => {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).uid
  } catch {
    return null
  }
}
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 1440, height: 960 },
  storageState: {
    cookies: [],
    origins: [
      {
        origin: new URL(base).origin,
        localStorage: [{ name: 'collab_access_token', value: tokenFor(99601) }],
      },
    ],
  },
})
const first = await context.newPage()
const second = await context.newPage()
for (const page of [first, second]) page.setDefaultTimeout(12_000)
const checks = []
const errors = []
const requests = []
const sockets = []
const unexpected = []
let failProfile = null
let holdProfile = null
let heldProfile = null
let refreshCount = 0
let forceRefresh = false
const pass = (label) => {
  checks.push(label)
  console.log('PASS', label)
}
for (const page of [first, second]) page.on('pageerror', (error) => errors.push(error.message))

await context.route('**/api/**', async (route) => {
  const request = route.request()
  const url = new URL(request.url())
  const method = request.method()
  const id = identity((request.headers().authorization || '').replace(/^Bearer /, ''))
  requests.push({ path: url.pathname, method, id })
  if (url.pathname === '/api/auth/login') {
    const user = [...users.values()].find((item) => item.username === request.postDataJSON().username)
    return route.fulfill({ json: { token: tokenFor(user.id), user } })
  }
  if (url.pathname === '/api/auth/refresh') {
    refreshCount += 1
    forceRefresh = false
    return route.fulfill({ json: { token: tokenFor(id, refreshCount + 10) } })
  }
  if (!users.has(id)) return route.fulfill({ status: 401, json: { msg: '需要登录' } })
  if (url.pathname === '/api/auth/me') {
    if (method === 'PUT') {
      const user = { ...users.get(id), nickname: request.postDataJSON().nickname }
      users.set(id, user)
      return route.fulfill({ json: { user } })
    }
    if (request.frame().page() === first && id === holdProfile) {
      heldProfile = { id, route, user: structuredClone(users.get(id)) }
      return
    }
    if (request.frame().page() === first && id === failProfile) {
      return route.fulfill({ status: 503, json: { msg: '模拟资料服务暂时不可用' } })
    }
    return route.fulfill({ json: { user: users.get(id) } })
  }
  if (url.pathname === '/api/cross-tab-refresh-check') {
    return route.fulfill({ status: forceRefresh ? 401 : 200, json: { ok: !forceRefresh } })
  }
  if (url.pathname === '/api/spaces') {
    return route.fulfill({
      json: [{ id, name: `${users.get(id).nickname}的空间`, my_role: 'owner', doc_count: 1 }],
    })
  }
  if (url.pathname.endsWith('/members')) {
    return route.fulfill({ json: { members: [{ ...users.get(id), role: 'owner' }] } })
  }
  if (url.pathname === '/api/stats')
    return route.fulfill({ json: { spaces: 1, documents: 1, operations: 1 } })
  if (url.pathname === '/api/docs' || url.pathname === '/api/docs/search') {
    return route.fulfill({ json: [documentFor(id)] })
  }
  if (url.pathname === '/api/docs/trash') return route.fulfill({ json: [] })
  if (url.pathname === `/api/docs/cross-tab-document-${id}`) return route.fulfill({ json: documentFor(id) })
  if (url.pathname.startsWith('/api/docs/cross-tab-document-')) {
    unexpected.push({ path: url.pathname, id })
    return route.fulfill({ status: 403, json: { msg: '不可读取另一账号文档' } })
  }
  unexpected.push({ path: url.pathname, method, id })
  return route.fulfill({ status: 404, json: { msg: '未配置的模拟请求' } })
})

await context.routeWebSocket(/\/ws\/collab/, (socket) => {
  const id = identity(new URL(socket.url()).searchParams.get('token'))
  const entry = { id, socket, operations: [], closed: false }
  sockets.push(entry)
  socket.onClose(() => {
    entry.closed = true
  })
  socket.onMessage((raw) => {
    const frame = JSON.parse(String(raw))
    if (frame.type === 'hello') {
      const clock = 'seed:1'
      socket.send(
        JSON.stringify({
          type: 'welcome',
          rev: 1,
          role: 'owner',
          canWrite: true,
          snapshot: [
            {
              id: `paragraph-${id}`,
              type: 'TEXT',
              rootClock: clock,
              fields: {
                text: { value: `${users.get(id).nickname}的正文`, clock },
                order: { value: 1024, clock },
                '#version': { value: 'seed', clock },
              },
            },
          ],
        }),
      )
    } else if (frame.type === 'op') entry.operations.push(frame.op)
    else if (frame.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }))
  })
})

async function moduleAction(page, pathname, action, input) {
  return page.evaluate(
    async ({ pathname, action, input }) => {
      const moduleUrl =
        performance.getEntriesByType('resource').find((entry) => new URL(entry.name).pathname === pathname)
          ?.name || pathname
      const module = await import(moduleUrl)
      if (action === 'refresh') return module.api('/api/cross-tab-refresh-check')
      if (action === 'login') return module.authStore.login({ username: input, password: 'mock-password' })
      if (action === 'logout') return module.authStore.logout()
      if (action === 'state') {
        const { state } = module.authStore
        return {
          token: Boolean(state.token),
          userId: state.user?.id,
          epoch: state.sessionEpoch,
          changing: state.sessionChanging,
        }
      }
    },
    { pathname, action, input },
  )
}
async function login(page, id) {
  await page.locator('input[name="username"]').fill(users.get(id).username)
  await page.locator('input[name="password"]').fill('mock-password')
  await page.locator('.auth-submit').click()
}
async function readyHome(page, id) {
  await page
    .locator('.sidebar-profile-link strong')
    .filter({ hasText: users.get(id).nickname })
    .waitFor()
  await page
    .getByRole('heading', { level: 1, name: `${users.get(id).nickname}的空间`, exact: true })
    .waitFor()
}
async function openEditor(page, id) {
  await page.evaluate((id) => {
    location.hash = `/work/doc/cross-tab-document-${id}`
  }, id)
  const paragraph = page.locator(`[data-paragraph-id="paragraph-${id}"]`)
  await paragraph.waitFor()
  await page.waitForFunction((id) => {
    const paragraph = document.querySelector(`[data-paragraph-id="paragraph-${id}"]`)
    return paragraph && !paragraph.readOnly
  }, id)
  return paragraph
}
async function until(predicate, label) {
  const deadline = Date.now() + 10_000
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timeout: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

try {
  await Promise.all([first.goto(`${base}/#/work/doc/cross-tab-document-99601`), second.goto(`${base}/#/`)])
  await readyHome(second, 99601)
  const firstParagraph = first.locator('[data-paragraph-id="paragraph-99601"]')
  await first.waitForFunction(
    () => !document.querySelector('[data-paragraph-id="paragraph-99601"]')?.readOnly,
  )
  await firstParagraph.fill('第一位协作者尚未确认的修改')
  await until(() => sockets[0]?.operations.length === 1, 'initial pending edit')
  await second.getByRole('button', { name: '退出登录', exact: true }).click()
  await first.waitForURL((url) => url.hash.startsWith('#/login'))
  await until(() => sockets[0].closed, 'old socket close on logout')
  assert.equal(await first.locator('.workspace-layout').count(), 0)
  assert.equal(await first.getByRole('dialog').count(), 0)
  assert.equal(await first.evaluate(() => localStorage.getItem('collab_access_token')), null)
  await first.screenshot({ path: path.join(out, 'logout-clears-editor.png'), fullPage: true })
  pass('另一标签页退出后立即关闭旧编辑器和连接，未确认修改提示不阻止登录失效交接')

  await login(second, 99602)
  await Promise.all([readyHome(first, 99602), readyHome(second, 99602)])
  assert.ok(!first.url().includes('/work/'))
  assert.ok(!(await first.locator('body').innerText()).includes('第一位协作者'))
  await first.screenshot({ path: path.join(out, 'new-account-home.png'), fullPage: true })
  pass('另一标签页登录新账号后同步进入新账号工作台，旧内容与旧资料全部卸载')

  const secondParagraph = await openEditor(first, 99602)
  await secondParagraph.fill('同一账号刷新 token 时保留此处的修改')
  const activeSocket = sockets.at(-1)
  await until(() => activeSocket.operations.length === 1, 'pending edit before rotation')
  const previousState = await moduleAction(first, '/src/stores/auth.js', 'state')
  const socketCount = sockets.length
  const currentUrl = first.url()
  forceRefresh = true
  await moduleAction(second, '/src/lib/apiClient.js', 'refresh')
  await until(async () => {
    const token = await first.evaluate(async () => {
      const { authStore } = await import('/src/stores/auth.js')
      return authStore.state.token
    })
    return token === (await second.evaluate(() => localStorage.getItem('collab_access_token')))
  }, 'same-account refresh propagation')
  assert.equal(first.url(), currentUrl)
  assert.equal(await secondParagraph.inputValue(), '同一账号刷新 token 时保留此处的修改')
  assert.equal(sockets.length, socketCount)
  assert.equal(activeSocket.closed, false)
  assert.equal((await moduleAction(first, '/src/stores/auth.js', 'state')).epoch, previousState.epoch)
  assert.equal(refreshCount, 1)
  pass('同账号正常刷新 token 保持文档位置、草稿和原协作连接，不重复载入工作区')

  // A second account can also be selected without a separate logout event.
  holdProfile = 99603
  await moduleAction(second, '/src/stores/auth.js', 'login', users.get(99603).username)
  await until(() => heldProfile?.id === 99603, 'held new account profile')
  await first.getByRole('status').filter({ hasText: '正在同步登录状态' }).waitFor()
  assert.equal(await first.locator('.workspace-layout').count(), 0)
  await until(() => activeSocket.closed, 'old socket close before new me returns')
  await first.screenshot({ path: path.join(out, 'switching-account.png'), fullPage: true })
  pass('直接换账号时先关旧连接、移除旧正文，加载新资料期间不会展示旧工作区')

  holdProfile = null
  const delayed = heldProfile
  heldProfile = null
  await moduleAction(second, '/src/stores/auth.js', 'login', users.get(99602).username)
  await readyHome(first, 99602)
  await delayed.route.fulfill({ json: { user: delayed.user } })
  await first.waitForTimeout(150)
  assert.equal((await moduleAction(first, '/src/stores/auth.js', 'state')).userId, 99602)
  assert.ok(!(await first.locator('body').innerText()).includes('第三位协作者'))
  pass('快速连续切换账号时忽略迟到的旧资料响应，只显示最后选择的账号')

  failProfile = 99603
  await moduleAction(second, '/src/stores/auth.js', 'login', users.get(99603).username)
  await first.waitForURL((url) => url.hash.startsWith('#/login'))
  await first.getByRole('alert').filter({ hasText: '暂时无法恢复登录状态' }).waitFor()
  assert.equal((await moduleAction(first, '/src/stores/auth.js', 'state')).token, true)
  failProfile = null
  await first.getByRole('button', { name: '重试连接', exact: true }).click()
  await readyHome(first, 99603)
  pass('新账号资料暂时失败保留有效 token、提供原地重试，恢复后进入正确工作台')

  await first.getByRole('link', { name: '进入个人主页', exact: true }).click()
  await first.getByRole('textbox', { name: '昵称', exact: true }).fill('尚未保存的昵称')
  await moduleAction(second, '/src/stores/auth.js', 'logout')
  await first.waitForURL((url) => url.hash.startsWith('#/login'))
  assert.equal(await first.getByRole('dialog').count(), 0)
  assert.equal(await first.locator('.profile-page').count(), 0)
  pass('个人页尚未保存的昵称不会阻止另一标签页退出，旧资料与弹窗同步清除')

  assert.deepEqual(unexpected, [])
  assert.deepEqual(errors, [])
  pass('双标签全过程无脚本错误、无新账号请求旧文档、未触碰真实后端')
  await fs.writeFile(
    path.join(out, 'summary.json'),
    JSON.stringify({ status: 'passed', checks, errors, requests }, null, 2),
  )
} catch (error) {
  await first.screenshot({ path: path.join(out, 'failure-first.png'), fullPage: true })
  await second.screenshot({ path: path.join(out, 'failure-second.png'), fullPage: true })
  await fs.writeFile(
    path.join(out, 'summary.json'),
    JSON.stringify({ status: 'failed', checks, errors, unexpected, error: String(error), requests }, null, 2),
  )
  throw error
} finally {
  if (heldProfile) await heldProfile.route.abort().catch(() => {})
  await browser.close()
}
