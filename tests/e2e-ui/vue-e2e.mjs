import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { imageChecks } from './image-checks.mjs'
import { applyOperation, createCollabState, loadSnapshot } from '../../frontend/src/collab/collabState.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BASE_URL = (process.env.E2E_BASE_URL || 'http://127.0.0.1:5173').replace(/\/$/, '')
const OFFLINE_MS = Number(process.env.E2E_OFFLINE_MS || 30_000)
const TIMEOUT = Number(process.env.E2E_TIMEOUT || 25_000)
const HEADLESS = process.env.E2E_HEADED !== '1'
const runSuffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(-12)
const runId = new Date().toISOString().replace(/[:.]/g, '-') + `-${runSuffix}`
const artifactDir = process.env.E2E_OUTPUT_DIR
  ? path.resolve(process.env.E2E_OUTPUT_DIR, runId)
  : path.resolve(HERE, '..', '..', 'artifacts', 'e2e-vue', runId)

const users = {
  owner: { username: `owner_${runSuffix}`, nickname: '演示所有者' },
  editor: { username: `editor_${runSuffix}`, nickname: '演示编辑者' },
  viewer: { username: `viewer_${runSuffix}`, nickname: '演示只读者' },
}
const password = `E2e-${runSuffix}-pass!`
const spaceName = `Vue三角色验收_${runSuffix}`
const titles = {
  doc: `协同文档_${runSuffix}`,
  board: `协同白板_${runSuffix}`,
  kanban: `协同看板_${runSuffix}`,
}

const results = []
const pageErrors = []
const consoleErrors = []
const httpFailures = []
const resources = { users, spaceName, titles, docKeys: {} }
let browser
const contexts = {}
const pages = {}
const clientStates = new Map()
let fatalError = null
let editorTransportOffline = false
let editorSocketRoute = null
let editorServerRoute = null

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function safeName(value) {
  return value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
}

async function writeSummary(status = fatalError ? 'failed' : 'running') {
  const summary = {
    runId,
    status,
    baseUrl: BASE_URL,
    offlineRequestedMs: OFFLINE_MS,
    startedAt: results[0]?.startedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    resources,
    results,
    pageErrors,
    consoleErrors,
    httpFailures,
    fatalError: fatalError ? { message: fatalError.message, stack: fatalError.stack } : null,
  }
  await fs.writeFile(path.join(artifactDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8')
}

async function screenshot(page, name) {
  await page.screenshot({ path: path.join(artifactDir, `${safeName(name)}.png`), fullPage: true })
}

async function assertNoViewportOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }))
  const widest = Math.max(metrics.documentWidth, metrics.bodyWidth)
  assert(
    widest <= metrics.viewportWidth + 1,
    `${label} 存在全局横向溢出: viewport=${metrics.viewportWidth}, document=${metrics.documentWidth}, body=${metrics.bodyWidth}`,
  )
  return metrics
}

async function step(name, action) {
  const record = { name, status: 'running', startedAt: new Date().toISOString() }
  results.push(record)
  await writeSummary()
  const started = Date.now()
  try {
    const details = await action()
    record.status = 'passed'
    record.durationMs = Date.now() - started
    if (details !== undefined) record.details = details
    console.log(`[PASS] ${name} (${record.durationMs} ms)`)
    await writeSummary()
    return details
  } catch (error) {
    record.status = 'failed'
    record.durationMs = Date.now() - started
    record.error = error instanceof Error ? error.message : String(error)
    console.error(`[FAIL] ${name}: ${record.error}`)
    for (const [role, page] of Object.entries(pages)) {
      if (!page || page.isClosed()) continue
      try {
        await screenshot(page, `failure-${results.length}-${role}`)
      } catch {
        /* best effort */
      }
    }
    await writeSummary('failed')
    throw error
  }
}

async function eventually(label, producer, predicate = Boolean, timeout = TIMEOUT) {
  const deadline = Date.now() + timeout
  let lastValue
  let lastError
  while (Date.now() < deadline) {
    try {
      lastValue = await producer()
      if (await predicate(lastValue)) return lastValue
      lastError = null
    } catch (error) {
      lastError = error
    }
    await delay(150)
  }
  const tail = lastError ? lastError.message : JSON.stringify(lastValue)
  throw new Error(`${label} 超时（最后状态: ${tail}）`)
}

function attachDiagnostics(page, role) {
  const observed = { state: createCollabState(), rev: 0 }
  clientStates.set(role, observed)
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      try {
        const message = JSON.parse(String(payload))
        if (message.type === 'welcome') {
          loadSnapshot(observed.state, message.snapshot)
          observed.rev = message.rev
        }
        if (message.type === 'applied') {
          applyOperation(observed.state, message.op)
          observed.rev = message.rev
        }
        if (message.type === 'incremental') {
          message.ops.forEach((op) => applyOperation(observed.state, op))
          observed.rev = message.toRev
        }
      } catch {
        /* diagnostics only; malformed frames are handled by the page */
      }
    }),
  )
  page.on('pageerror', (error) => pageErrors.push({ role, message: error.message }))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push({ role, text: message.text() })
  })
  page.on('response', (response) => {
    if (response.status() >= 500) {
      httpFailures.push({ role, status: response.status(), url: response.url() })
    }
  })
}

async function waitDashboard(page) {
  await page.locator('.app-layout').waitFor({ state: 'visible', timeout: TIMEOUT })
  await page.locator('.sidebar-account').waitFor({ state: 'visible', timeout: TIMEOUT })
}

async function register(page, user) {
  await page.goto(`${BASE_URL}/#/login`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '注册', exact: true }).click()
  await page.locator('input[name="username"]').fill(user.username)
  await page.locator('input[name="nickname"]').fill(user.nickname)
  await page.locator('input[name="password"]').fill(password)
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await waitDashboard(page)
}

async function gotoDashboard(page) {
  const target = `${BASE_URL}/#/`
  if (page.url() === target) {
    await page.reload({ waitUntil: 'domcontentloaded' })
  } else {
    await page.goto(target, { waitUntil: 'domcontentloaded' })
  }
  await waitDashboard(page)
}

async function selectSpace(page, name = spaceName) {
  const item = page.locator('.space-nav button').filter({ hasText: name })
  await item.waitFor({ state: 'visible', timeout: TIMEOUT })
  if (!(await item.evaluate((element) => element.classList.contains('active')))) {
    const box = await item.boundingBox()
    const viewport = page.viewportSize()
    const outsideViewport = !box || !viewport || box.x + box.width <= 0 || box.x >= viewport.width
    if (outsideViewport) {
      const menu = page.getByRole('button', { name: '打开导航', exact: true })
      if (await menu.count()) await menu.click()
    }
    await item.click()
  }
  await page
    .getByRole('heading', { level: 1, name, exact: true })
    .waitFor({ state: 'visible', timeout: TIMEOUT })
  await eventually(
    '空间内容加载',
    async () => page.locator('.content-section .list-state[role="status"]').count(),
    (count) => count === 0,
  )
}

async function gotoDashboardSpace(page) {
  await gotoDashboard(page)
  // An invitation changes another session's space list. Refresh through the UI
  // even when hash navigation reuses the mounted dashboard.
  const refresh = page.getByRole('button', { name: '刷新内容', exact: true })
  await refresh.click()
  await eventually('空间列表刷新完成', async () => refresh.isEnabled(), Boolean)
  await selectSpace(page)
  const navigation = page.getByRole('button', { name: '打开导航', exact: true })
  if (
    (await navigation.isVisible()) &&
    !(await page.locator('.app-sidebar').evaluate((element) => element.classList.contains('open')))
  )
    await navigation.click()
  await page
    .getByRole('navigation', { name: '工作台功能' })
    .getByRole('link', { name: '空间首页', exact: true })
    .click()
}

async function waitSynced(page, timeout = TIMEOUT) {
  await page
    .locator('.connection-badge')
    .filter({ hasText: /已连接|已同步/ })
    .waitFor({ state: 'visible', timeout })
}

async function gotoWorkspace(page, kind, docKey) {
  await page.goto(`${BASE_URL}/#/work/${kind}/${encodeURIComponent(docKey)}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.locator('.workspace-layout').waitFor({ state: 'visible', timeout: TIMEOUT })
  await waitSynced(page)
}

async function createContent(page, kind, title) {
  const names = { doc: '文档', board: '白板', kanban: '看板' }
  await page.getByRole('button', { name: `新建${names[kind]}`, exact: true }).click()
  const dialog = page.getByRole('dialog').filter({ hasText: `新建${names[kind]}` })
  await dialog.waitFor({ state: 'visible', timeout: TIMEOUT })
  await dialog.locator('input[maxlength="256"]').fill(title)
  await dialog.getByRole('button', { name: '创建并打开', exact: true }).click()
  await page.locator('.workspace-layout').waitFor({ state: 'visible', timeout: TIMEOUT })
  await waitSynced(page)
  const match = decodeURIComponent(new URL(page.url()).hash).match(/^#\/work\/(doc|board|kanban)\/([^/?]+)/)
  assert(match?.[1] === kind && match?.[2], `创建${names[kind]}后 URL 未包含 docKey: ${page.url()}`)
  return match[2]
}

async function invite(page, username, role) {
  await page
    .getByRole('navigation', { name: '空间管理' })
    .getByRole('link', { name: '空间成员', exact: true })
    .click()
  await page.getByRole('button', { name: '邀请成员', exact: true }).click()
  const dialog = page.getByRole('dialog').filter({ hasText: '邀请成员' })
  await dialog.waitFor({ state: 'visible', timeout: TIMEOUT })
  await dialog.locator('input[placeholder="输入已注册用户名"]').fill(username)
  await dialog.locator(`input[type="radio"][value="${role}"]`).check()
  await dialog.getByRole('button', { name: '邀请成员', exact: true }).click()
  await dialog.waitFor({ state: 'hidden', timeout: TIMEOUT })
}

async function pageApi(page, url, options = {}) {
  return page.evaluate(
    async ({ url, options }) => {
      const token = localStorage.getItem('collab_access_token') || ''
      const response = await fetch(url, {
        ...options,
        headers: {
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(options.headers || {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      })
      const type = response.headers.get('content-type') || ''
      const body = type.includes('application/json') ? await response.json() : await response.text()
      return { status: response.status, body }
    },
    { url, options },
  )
}

async function assertReadonlyWorkspace(page, kind) {
  await page.locator('.readonly-strip').waitFor({ state: 'visible', timeout: TIMEOUT })
  await page.getByRole('heading', { name: '内容标题', exact: true }).waitFor()
  assert((await page.locator('.workspace-title-field input').count()) === 0, `${kind} 顶部仍有标题输入框`)
  if (kind === 'doc') {
    assert(
      (await page.getByRole('button', { name: '添加段落', exact: true }).count()) === 0,
      'viewer 仍有添加段落按钮',
    )
    assert(
      (await page.locator('.paragraph-row textarea').first().isEditable()) === false,
      'viewer 文档正文仍可编辑',
    )
  } else if (kind === 'board') {
    assert(
      (await page.getByRole('button', { name: '添加卡片', exact: true }).count()) === 0,
      'viewer 仍有白板添加按钮',
    )
    assert(
      (await page.locator('.board-card textarea').first().isEditable()) === false,
      'viewer 白板卡片仍可编辑',
    )
  } else {
    assert(
      (await page.getByRole('button', { name: '添加列表', exact: true }).count()) === 0,
      'viewer 仍有看板添加按钮',
    )
    assert(
      (await page.getByRole('button', { name: '拖动卡片', exact: true }).count()) === 0,
      'viewer 仍有看板拖拽按钮',
    )
    assert(
      (await page.locator('.kanban-card textarea').first().isEditable()) === false,
      'viewer 看板卡片仍可编辑',
    )
  }
}

async function createContexts() {
  browser = await chromium.launch({ headless: HEADLESS })
  for (const role of ['owner', 'editor', 'viewer']) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      acceptDownloads: true,
      locale: 'zh-CN',
    })
    contexts[role] = context
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
    const page = await context.newPage()
    if (role === 'editor') {
      await page.routeWebSocket(/\/ws\/collab(?:\?|$)/, (webSocket) => {
        editorSocketRoute = webSocket
        editorServerRoute = null
        if (!editorTransportOffline) editorServerRoute = webSocket.connectToServer()
      })
    }
    page.setDefaultTimeout(TIMEOUT)
    pages[role] = page
    attachDiagnostics(page, role)
  }
}

async function stopTraces() {
  for (const [role, context] of Object.entries(contexts)) {
    try {
      await context.tracing.stop({ path: path.join(artifactDir, `trace-${role}.zip`) })
    } catch {
      /* best effort */
    }
  }
}

await fs.mkdir(artifactDir, { recursive: true })

try {
  await step('服务可用性检查', async () => {
    const response = await fetch(`${BASE_URL}/api/health`)
    const body = await response.json()
    assert(response.ok && body.status === 'UP', `健康检查失败: ${response.status}`)
    return { health: body.status, engine: body.engine }
  })

  await createContexts()
  const ownerPage = pages.owner
  const editorPage = pages.editor
  const viewerPage = pages.viewer

  await step('三个独立 context 注册并登录', async () => {
    await register(ownerPage, users.owner)
    await register(editorPage, users.editor)
    await register(viewerPage, users.viewer)
    await screenshot(ownerPage, '01-owner-default-space')
    return { contexts: 3, usernames: Object.values(users).map((user) => user.username) }
  })

  await step('owner 创建空间并邀请 editor/viewer', async () => {
    await ownerPage.getByRole('button', { name: '创建空间', exact: true }).click()
    const dialog = ownerPage.getByRole('dialog').filter({ hasText: '创建空间' })
    await dialog.locator('input[maxlength="128"]').fill(spaceName)
    await dialog.getByRole('button', { name: '创建空间', exact: true }).click()
    await dialog.waitFor({ state: 'hidden', timeout: TIMEOUT })
    await ownerPage.getByRole('heading', { level: 1, name: spaceName, exact: true }).waitFor()
    await invite(ownerPage, users.editor.username, 'editor')
    await invite(ownerPage, users.viewer.username, 'viewer')
    await eventually(
      '三名空间成员可见',
      async () => ownerPage.locator('.member-row').count(),
      (count) => count === 3,
    )

    await gotoDashboardSpace(editorPage)
    await gotoDashboardSpace(viewerPage)
    assert(
      (await editorPage.locator('.role-badge').filter({ hasText: '编辑者' }).count()) === 1,
      'editor 角色未显示',
    )
    assert(
      (await viewerPage.locator('.role-badge').filter({ hasText: '只读者' }).count()) === 1,
      'viewer 角色未显示',
    )
    assert(
      (await editorPage.getByRole('button', { name: '邀请成员', exact: true }).count()) === 0,
      'editor 不应有邀请入口',
    )
    assert(
      (await viewerPage.getByRole('button', { name: '新建内容', exact: true }).count()) === 0,
      'viewer 不应有新建入口',
    )
    await screenshot(ownerPage, '02-owner-members')
    return { owner: 'owner', editor: 'editor', viewer: 'viewer' }
  })

  await step('创建协同文档并完成三端实时同步', async () => {
    await gotoDashboardSpace(ownerPage)
    const docKey = await createContent(ownerPage, 'doc', titles.doc)
    resources.docKeys.doc = docKey
    await gotoWorkspace(editorPage, 'doc', docKey)
    await gotoWorkspace(viewerPage, 'doc', docKey)

    const firstOwner = ownerPage.locator('.paragraph-row textarea').first()
    const firstEditor = editorPage.locator('.paragraph-row textarea').first()
    const firstViewer = viewerPage.locator('.paragraph-row textarea').first()
    const ownerText = `owner初稿_${runSuffix}`
    await firstOwner.fill(ownerText)
    await eventually(
      'owner 文本同步到 editor',
      () => firstEditor.inputValue(),
      (value) => value === ownerText,
    )
    await eventually(
      'owner 文本同步到 viewer',
      () => firstViewer.inputValue(),
      (value) => value === ownerText,
    )

    await editorPage.getByRole('button', { name: '添加段落', exact: true }).click()
    await eventually(
      'owner 收到 editor 新段落',
      () => ownerPage.locator('.paragraph-row textarea').count(),
      (count) => count === 2,
    )
    const editorSecondText = `editor补充_${runSuffix}`
    await editorPage.locator('.paragraph-row textarea').nth(1).fill(editorSecondText)
    await eventually(
      'editor 新段落文本同步到 owner',
      () => ownerPage.locator('.paragraph-row textarea').nth(1).inputValue(),
      (value) => value === editorSecondText,
    )
    await eventually(
      'editor 新段落文本同步到 viewer',
      () => viewerPage.locator('.paragraph-row textarea').nth(1).inputValue(),
      (value) => value === editorSecondText,
    )
    await screenshot(ownerPage, '03-document-owner-editor-sync')
    return { docKey, paragraphs: 2, viewport: await assertNoViewportOverflow(ownerPage, '桌面文档') }
  })

  await step('同段并发修改按 LWW 收敛', async () => {
    const ownerValue = `冲突A_${runSuffix}`
    const editorValue = `冲突B_${runSuffix}`
    const ownerField = ownerPage.locator('.paragraph-row textarea').first()
    const editorField = editorPage.locator('.paragraph-row textarea').first()
    await Promise.all([ownerField.fill(ownerValue), editorField.fill(editorValue)])
    const converged = await eventually(
      'owner/editor 同段收敛',
      async () => {
        const values = [await ownerField.inputValue(), await editorField.inputValue()]
        return values
      },
      ([left, right]) => left === right && [ownerValue, editorValue].includes(left),
    )
    await delay(500)
    assert((await ownerField.inputValue()) === (await editorField.inputValue()), '收敛结果随后发生反转')
    await eventually(
      'viewer 收敛到相同结果',
      () => viewerPage.locator('.paragraph-row textarea').first().inputValue(),
      (value) => value === converged[0],
    )
    return { winner: converged[0] }
  })

  const historyTarget = `历史目标_${runSuffix}`
  const historyLatest = `历史最新_${runSuffix}`
  await step('历史预览并恢复，三端同步恢复结果', async () => {
    const ownerField = ownerPage.locator('.paragraph-row textarea').first()
    const editorField = editorPage.locator('.paragraph-row textarea').first()
    const viewerField = viewerPage.locator('.paragraph-row textarea').first()
    await ownerField.fill(historyTarget)
    await eventually(
      '历史目标同步',
      () => editorField.inputValue(),
      (value) => value === historyTarget,
    )
    await editorField.fill(historyLatest)
    await eventually(
      '历史最新同步',
      () => ownerField.inputValue(),
      (value) => value === historyLatest,
    )

    await ownerPage.getByRole('button', { name: '历史', exact: true }).click()
    const historyDialog = ownerPage.getByRole('dialog').filter({ hasText: '版本历史' })
    await historyDialog.waitFor({ state: 'visible', timeout: TIMEOUT })
    const targetEntry = historyDialog.locator('.history-entry').filter({ hasText: historyTarget }).first()
    await targetEntry.waitFor({ state: 'visible', timeout: TIMEOUT })
    await targetEntry.click()
    await historyDialog
      .locator('.history-preview')
      .filter({ hasText: historyTarget })
      .waitFor({ state: 'visible', timeout: TIMEOUT })
    await historyDialog.getByRole('button', { name: '恢复到此版本', exact: true }).click()
    const confirm = ownerPage.getByRole('dialog').filter({ hasText: '恢复历史版本' })
    await confirm.getByRole('button', { name: '确认恢复', exact: true }).click()
    await historyDialog.waitFor({ state: 'hidden', timeout: TIMEOUT })
    await waitSynced(ownerPage, 35_000)
    await eventually(
      'owner 恢复到目标文本',
      () => ownerField.inputValue(),
      (value) => value === historyTarget,
      35_000,
    )
    await eventually(
      'editor 收到历史恢复',
      () => editorField.inputValue(),
      (value) => value === historyTarget,
      35_000,
    )
    await eventually(
      'viewer 收到历史恢复',
      () => viewerField.inputValue(),
      (value) => value === historyTarget,
      35_000,
    )
    await screenshot(ownerPage, '04-history-restored')
    return { restoredText: historyTarget }
  })

  await step('viewer 文档只读且服务端拒绝写入', async () => {
    await assertReadonlyWorkspace(viewerPage, 'doc')
    await viewerPage.getByRole('button', { name: '历史', exact: true }).click()
    const dialog = viewerPage.getByRole('dialog').filter({ hasText: '版本历史' })
    await dialog.waitFor({ state: 'visible' })
    const restore = dialog.getByRole('button', { name: '恢复到此版本', exact: true })
    assert(await restore.isDisabled(), 'viewer 的历史恢复按钮未禁用')
    await dialog.getByRole('button', { name: '关闭', exact: true }).last().click()
    const viewerToken = await viewerPage.evaluate(() => localStorage.getItem('collab_access_token') || '')
    const response = await contexts.viewer.request.put(`${BASE_URL}/api/docs/${resources.docKeys.doc}`, {
      headers: { Authorization: `Bearer ${viewerToken}` },
      data: { title: 'viewer 不应改名' },
    })
    assert(response.status() === 403, `viewer REST 写入应为 403，实际 ${response.status()}`)
    await screenshot(viewerPage, '05-viewer-document-readonly')
    return { restStatus: response.status() }
  })

  await step('Markdown 导出包含当前标题与正文', async () => {
    const [download] = await Promise.all([
      ownerPage.waitForEvent('download', { timeout: TIMEOUT }),
      ownerPage.getByRole('button', { name: '导出', exact: true }).click(),
    ])
    const output = path.join(artifactDir, `export-${runSuffix}.md`)
    await download.saveAs(output)
    const markdown = await fs.readFile(output, 'utf8')
    assert(markdown.includes(`# ${titles.doc}`), 'Markdown 缺少文档标题')
    assert(markdown.includes(historyTarget), 'Markdown 缺少恢复后的正文')
    return { filename: download.suggestedFilename(), bytes: Buffer.byteLength(markdown) }
  })

  await step('协同白板卡片文本、位置和颜色双端同步', async () => {
    await gotoDashboardSpace(ownerPage)
    const boardKey = await createContent(ownerPage, 'board', titles.board)
    resources.docKeys.board = boardKey
    await gotoWorkspace(editorPage, 'board', boardKey)
    await ownerPage.getByRole('button', { name: '添加卡片', exact: true }).click()
    await ownerPage.locator('.board-card').first().waitFor({ state: 'visible' })
    const text = `白板卡片_${runSuffix}`
    await ownerPage.locator('.board-card textarea').first().fill(text)
    await eventually(
      '白板卡片同步到 editor',
      () => editorPage.locator('.board-card textarea').first().inputValue(),
      (value) => value === text,
    )

    const editorCard = editorPage.locator('.board-card').first()
    const beforeTransform = await editorCard.evaluate((element) => element.style.transform)
    const ownerCard = ownerPage.locator('.board-card').first()
    await ownerCard.focus()
    await ownerCard.press('Shift+ArrowRight')
    await ownerCard.press('Shift+ArrowDown')
    const movedTransform = await eventually(
      '白板位置同步',
      () => editorCard.evaluate((element) => element.style.transform),
      (value) => value !== beforeTransform,
    )
    await ownerCard.click({ position: { x: 20, y: 20 } })
    await ownerPage.locator('.color-swatch').nth(2).click()
    const ownerColor = await ownerCard.evaluate((element) => getComputedStyle(element).backgroundColor)
    await eventually(
      '白板颜色同步',
      () => editorCard.evaluate((element) => getComputedStyle(element).backgroundColor),
      (value) => value === ownerColor,
    )
    await gotoWorkspace(viewerPage, 'board', boardKey)
    await assertReadonlyWorkspace(viewerPage, 'board')
    await eventually(
      'viewer 看到白板卡片',
      () => viewerPage.locator('.board-card textarea').first().inputValue(),
      (value) => value === text,
    )
    await screenshot(ownerPage, '06-board-synced')
    return {
      boardKey,
      movedTransform,
      color: ownerColor,
      viewport: await assertNoViewportOverflow(ownerPage, '桌面白板'),
    }
  })

  await step('协同看板创建卡片并拖拽跨列同步', async () => {
    await gotoDashboardSpace(ownerPage)
    const kanbanKey = await createContent(ownerPage, 'kanban', titles.kanban)
    resources.docKeys.kanban = kanbanKey
    await gotoWorkspace(editorPage, 'kanban', kanbanKey)

    await ownerPage.locator('.kanban-tools').getByRole('button', { name: '添加列表', exact: true }).click()
    await ownerPage.locator('.kanban-column').first().waitFor({ state: 'visible' })
    await ownerPage.locator('.kanban-tools').getByRole('button', { name: '添加列表', exact: true }).click()
    await eventually(
      'owner 看板出现两列',
      () => ownerPage.locator('.kanban-column').count(),
      (count) => count === 2,
    )
    const ownerColumns = ownerPage.locator('.kanban-column')
    await ownerColumns.nth(0).getByLabel('列表标题').fill('待处理')
    await ownerColumns.nth(0).getByLabel('列表标题').press('Tab')
    await ownerColumns.nth(1).getByLabel('列表标题').fill('已完成')
    await ownerColumns.nth(1).getByLabel('列表标题').press('Tab')
    await ownerColumns.nth(0).getByRole('button', { name: '添加卡片', exact: true }).click()
    const cardText = `看板任务_${runSuffix}`
    await ownerColumns.nth(0).locator('.kanban-card textarea').fill(cardText)

    await eventually(
      'editor 看板出现两列',
      () => editorPage.locator('.kanban-column').count(),
      (count) => count === 2,
    )
    await eventually(
      '看板卡片同步到 editor',
      () => editorPage.locator('.kanban-card textarea').first().inputValue(),
      (value) => value === cardText,
    )
    const grip = ownerPage.getByRole('button', { name: '拖动卡片', exact: true }).first()
    const targetColumn = ownerColumns.nth(1)
    await targetColumn.scrollIntoViewIfNeeded()
    const gripBox = await grip.boundingBox()
    const targetBox = await targetColumn.boundingBox()
    assert(gripBox && targetBox, '无法取得看板拖拽坐标')
    await ownerPage.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2)
    await ownerPage.mouse.down()
    await ownerPage.mouse.move(
      targetBox.x + targetBox.width / 2,
      targetBox.y + Math.min(180, targetBox.height / 2),
      { steps: 14 },
    )
    await ownerPage.mouse.up()
    await eventually(
      'owner 卡片拖到第二列',
      () => ownerColumns.nth(1).locator('.kanban-card').count(),
      (count) => count === 1,
    )
    await eventually(
      'editor 收到跨列拖拽',
      () => editorPage.locator('.kanban-column').nth(1).locator('.kanban-card').count(),
      (count) => count === 1,
    )

    await gotoWorkspace(viewerPage, 'kanban', kanbanKey)
    await assertReadonlyWorkspace(viewerPage, 'kanban')
    await eventually(
      'viewer 看到第二列卡片',
      () => viewerPage.locator('.kanban-column').nth(1).locator('.kanban-card textarea').inputValue(),
      (value) => value === cardText,
    )
    await screenshot(ownerPage, '07-kanban-drag-synced')
    return {
      kanbanKey,
      cardText,
      targetColumn: 2,
      viewport: await assertNoViewportOverflow(ownerPage, '桌面看板'),
    }
  })

  const offlineMarker = `断线补齐_${runSuffix}`
  await step('editor 离线约 30 秒后自动重连并补齐', async () => {
    await gotoWorkspace(ownerPage, 'doc', resources.docKeys.doc)
    await gotoWorkspace(editorPage, 'doc', resources.docKeys.doc)
    assert(editorServerRoute, '未捕获 editor 的真实 WebSocket 连接')
    const offlineStarted = Date.now()
    editorTransportOffline = true
    await editorSocketRoute.close({ code: 1012, reason: 'e2e transport offline' })
    await eventually(
      'editor 进入重连/离线状态',
      async () => {
        const badge = await editorPage
          .locator('.connection-badge')
          .textContent()
          .catch(() => '')
        const strip = await editorPage.locator('.offline-strip').count()
        return { badge, strip }
      },
      (state) => state.strip > 0 || /重新连接|已离线|连接异常/.test(state.badge || ''),
      12_000,
    )
    await ownerPage.locator('.paragraph-row textarea').first().fill(offlineMarker)
    const remaining = OFFLINE_MS - (Date.now() - offlineStarted)
    if (remaining > 0) await delay(remaining)
    const actualOfflineMs = Date.now() - offlineStarted
    editorTransportOffline = false
    assert(editorSocketRoute, '未捕获 editor 的离线 WebSocket 重连')
    await editorSocketRoute.close({ code: 1012, reason: 'e2e transport restored' })
    await waitSynced(editorPage, 45_000)
    await eventually(
      '断线期间操作补齐到 editor',
      () => editorPage.locator('.paragraph-row textarea').first().inputValue(),
      (value) => value === offlineMarker,
      45_000,
    )
    await editorPage.reload({ waitUntil: 'domcontentloaded' })
    await waitSynced(editorPage, 35_000)
    assert(
      (await editorPage.locator('.paragraph-row textarea').first().inputValue()) === offlineMarker,
      '刷新后断线补齐内容未持久化',
    )
    await screenshot(editorPage, '08-editor-reconnected-after-30s')
    return {
      requestedMs: OFFLINE_MS,
      actualOfflineMs,
      recoveredText: offlineMarker,
      fault: 'websocket-transport',
    }
  })

  await step('正文搜索命中、统计增长并保存服务端证据', async () => {
    await gotoDashboardSpace(ownerPage)
    const search = ownerPage.getByLabel('搜索当前可见内容')
    await search.fill(offlineMarker)
    const result = ownerPage.getByRole('option').filter({ hasText: titles.doc })
    await result.waitFor({ state: 'visible', timeout: TIMEOUT })
    assert((await result.textContent()).includes('正文命中'), '搜索结果不是正文命中')
    await screenshot(ownerPage, '09-search-result')

    await ownerPage
      .getByRole('navigation', { name: '空间管理' })
      .getByRole('link', { name: '协同统计', exact: true })
      .click()
    const operationMetric = ownerPage.locator('.metric').filter({ hasText: '协作操作' })
    await operationMetric.waitFor({ state: 'visible', timeout: TIMEOUT })
    const operations = Number(await operationMetric.locator('strong').textContent())
    assert(Number.isFinite(operations) && operations > 0, `操作统计无效: ${operations}`)
    const stats = await pageApi(ownerPage, '/api/stats')
    assert(stats.status === 200 && Number(stats.body.operations) === operations, 'UI 统计与 API 不一致')
    await fs.writeFile(path.join(artifactDir, 'stats.json'), JSON.stringify(stats.body, null, 2), 'utf8')
    await screenshot(ownerPage, '10-collaboration-stats')
    return {
      operations,
      documents: stats.body.documents,
      spaces: stats.body.spaces,
      viewport: await assertNoViewportOverflow(ownerPage, '桌面仪表盘'),
    }
  })

  await imageChecks({
    pages,
    resources,
    step,
    gotoWorkspace,
    waitSynced,
    eventually,
    screenshot,
    pageApi,
    assert,
    artifactDir,
    assertConverged: async (roles) => {
      const canonical = (observed) =>
        JSON.stringify({
          rev: observed.rev,
          elements: [...observed.state.elements.values()]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((el) => ({
              ...el,
              fields: Object.fromEntries(Object.entries(el.fields).sort(([a], [b]) => a.localeCompare(b))),
            })),
        })
      const states = await eventually(
        '三端规范化业务状态及版本一致',
        () => roles.map((role) => canonical(clientStates.get(role))),
        (values) => values.every((value) => value === values[0]),
      )
      await fs.writeFile(path.join(artifactDir, 'latest-converged-business-state.json'), states[0], 'utf8')
    },
  })

  await step('三用户环境中文本从输入到其他页面应用完成的延迟测量', async () => {
    for (const page of [ownerPage, editorPage, viewerPage])
      await gotoWorkspace(page, 'doc', resources.docKeys.doc)
    const samples = []
    for (let index = 0; index < 20; index++) {
      const expected = `latency-${index}-` + 'x'.repeat(256)
      await ownerPage.evaluate(() => {
        document.querySelector('.paragraph-row textarea').addEventListener(
          'input',
          () => {
            window.__sampleSentAt = Date.now()
          },
          { once: true },
        )
      })
      const rendered = editorPage.evaluate(
        (expected) =>
          new Promise((resolve, reject) => {
            const deadline = Date.now() + 15000
            function check() {
              if (document.querySelector('.paragraph-row textarea')?.value === expected)
                return resolve(Date.now())
              if (Date.now() > deadline) return reject(new Error('远端应用超时'))
              requestAnimationFrame(check)
            }
            check()
          }),
        expected,
      )
      await ownerPage.locator('.paragraph-row textarea').first().fill(expected)
      const receivedAt = await rendered
      const sentAt = await ownerPage.evaluate(() => window.__sampleSentAt)
      samples.push(receivedAt - sentAt)
    }
    const ordered = [...samples].sort((a, b) => a - b)
    const report = {
      measuredAt: new Date().toISOString(),
      protocol: 'STATE',
      sampleCount: samples.length,
      clients: 3,
      writers: 1,
      textPayloadCharacters: 'latency-00-'.length + 256,
      measurement:
        'owner DOM input event to editor textarea value applied on next animation frame; same machine clock',
      p50Ms: ordered[Math.ceil(ordered.length * 0.5) - 1],
      p95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1],
      maxMs: ordered.at(-1),
      errors: 0,
      samplesMs: samples,
      environment: {
        os: `${os.type()} ${os.release()} ${os.arch()}`,
        cpu: os.cpus()[0].model,
        logicalCpus: os.cpus().length,
        memoryGiB: Math.round(os.totalmem() / 2 ** 30),
        node: process.version,
      },
    }
    await fs.writeFile(path.join(artifactDir, 'browser-latency.json'), JSON.stringify(report, null, 2))
    return report
  })

  await step('320/390/414/768/1440px 五档布局无横向溢出且关键内容可见', async () => {
    const layoutPage = await contexts.owner.newPage()
    layoutPage.setDefaultTimeout(TIMEOUT)
    attachDiagnostics(layoutPage, 'owner-layout-audit')
    pages.ownerLayoutAudit = layoutPage

    const audits = {}
    const widths = [320, 390, 414, 768, 1440]
    const kinds = [
      ['doc', 'document'],
      ['board', 'board'],
      ['kanban', 'kanban'],
    ]
    for (const width of widths) {
      const height = width >= 1024 ? 900 : 844
      await layoutPage.setViewportSize({ width, height })
      const suffix = `${width}x${height}`
      await gotoDashboardSpace(layoutPage)
      await layoutPage.locator('.content-section').waitFor({ state: 'visible' })
      const dashboardMetrics = await assertNoViewportOverflow(layoutPage, `仪表盘 ${suffix}`)
      await screenshot(layoutPage, `11-dashboard-${suffix}`)
      audits[width] = { dashboard: dashboardMetrics }

      for (const [kind, name] of kinds) {
        await gotoWorkspace(layoutPage, kind, resources.docKeys[kind])
        const editorSelector =
          kind === 'doc' ? '.document-editor' : kind === 'board' ? '.board-editor' : '.kanban-editor'
        await layoutPage.locator(editorSelector).waitFor({ state: 'visible' })
        const workspaceMetrics = await assertNoViewportOverflow(layoutPage, `${kind} ${suffix}`)
        audits[width][kind] = workspaceMetrics
        await screenshot(layoutPage, `12-${name}-${suffix}`)
      }
    }
    return { widths, audits }
  })

  await step('页面运行期无 console/pageerror 或 HTTP 5xx', async () => {
    assert(pageErrors.length === 0, `检测到 pageerror: ${JSON.stringify(pageErrors)}`)
    assert(consoleErrors.length === 0, `检测到 console error: ${JSON.stringify(consoleErrors)}`)
    assert(httpFailures.length === 0, `检测到 HTTP 5xx: ${JSON.stringify(httpFailures)}`)
    return { pageErrors: 0, consoleErrors: 0, http5xx: 0 }
  })
} catch (error) {
  fatalError = error instanceof Error ? error : new Error(String(error))
  process.exitCode = 1
} finally {
  await writeSummary(fatalError ? 'failed' : 'passed').catch(() => {})
  await stopTraces()
  for (const context of Object.values(contexts)) {
    try {
      await context.close()
    } catch {
      /* best effort */
    }
  }
  if (browser) await browser.close().catch(() => {})
}

if (fatalError) {
  console.error(`\nVue E2E FAILED: ${fatalError.message}`)
  console.error(`Artifacts: ${artifactDir}`)
} else {
  console.log(`\nVue E2E PASSED: ${results.length}/${results.length} steps`)
  console.log(`Artifacts: ${artifactDir}`)
}
