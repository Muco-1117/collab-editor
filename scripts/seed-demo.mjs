#!/usr/bin/env node

import process from 'node:process'

const HELP = `
用真实 REST + WebSocket 链路创建毕业设计演示数据。

必需环境变量：
  DEMO_OWNER_PASSWORD
  DEMO_EDITOR_PASSWORD
  DEMO_VIEWER_PASSWORD

可选环境变量：
  DEMO_API_BASE          默认 http://127.0.0.1:8080
  DEMO_OWNER_USERNAME    默认 demo_owner
  DEMO_EDITOR_USERNAME   默认 demo_editor
  DEMO_VIEWER_USERNAME   默认 demo_viewer

脚本不会输出密码或 JWT。账号仅用于本地演示库，请勿复用个人密码。
`.trim()

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(HELP)
  process.exit(0)
}

if (typeof WebSocket === 'undefined') {
  throw new Error('当前 Node.js 没有原生 WebSocket，请使用 Node.js 22 或更高版本')
}

const API_BASE = normalizeBase(process.env.DEMO_API_BASE || 'http://127.0.0.1:8080')
const SPACE_NAME = '毕业设计协同演示'
const REQUEST_TIMEOUT_MS = 15_000
const WS_TIMEOUT_MS = 15_000

const accounts = {
  owner: {
    username: process.env.DEMO_OWNER_USERNAME || 'demo_owner',
    nickname: '演示所有者',
    password: requiredSecret('DEMO_OWNER_PASSWORD'),
  },
  editor: {
    username: process.env.DEMO_EDITOR_USERNAME || 'demo_editor',
    nickname: '演示编辑者',
    password: requiredSecret('DEMO_EDITOR_PASSWORD'),
  },
  viewer: {
    username: process.env.DEMO_VIEWER_USERNAME || 'demo_viewer',
    nickname: '演示只读者',
    password: requiredSecret('DEMO_VIEWER_PASSWORD'),
  },
}

for (const account of Object.values(accounts)) {
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(account.username)) {
    throw new Error(`演示用户名不合法: ${account.username}`)
  }
  if (account.password.length < 6 || account.password.length > 72) {
    throw new Error(`${account.username} 的密码长度必须为 6-72 位`)
  }
}
if (new Set(Object.values(accounts).map((account) => account.username)).size !== 3) {
  throw new Error('owner、editor、viewer 必须使用三个不同用户名')
}

const definitions = [
  {
    kind: 'doc',
    title: '需求评审纪要',
    clientId: 'demo-seed-doc-v1',
    operations: buildOperations('doc', 'demo-seed-doc-v1', [
      ['DELETE', 'seg-root-01', 'TEXT'],
      ['ADD', 'demo-doc-paragraph-1', 'TEXT'],
      ['PUT', 'demo-doc-paragraph-1', 'TEXT', 'order', 1024],
      ['PUT', 'demo-doc-paragraph-1', 'TEXT', 'text', '系统以 Element + Op 统一建模，文档按段落粒度协同。'],
      ['ADD', 'demo-doc-paragraph-2', 'TEXT'],
      ['PUT', 'demo-doc-paragraph-2', 'TEXT', 'order', 2048],
      ['PUT', 'demo-doc-paragraph-2', 'TEXT', 'text', 'WebSocket 负责实时同步，Lamport 时钟与 LWW 保证最终收敛。'],
    ]),
    expected: {
      'demo-doc-paragraph-1': { type: 'TEXT', fields: { order: 1024, text: '系统以 Element + Op 统一建模，文档按段落粒度协同。' } },
      'demo-doc-paragraph-2': { type: 'TEXT', fields: { order: 2048, text: 'WebSocket 负责实时同步，Lamport 时钟与 LWW 保证最终收敛。' } },
    },
  },
  {
    kind: 'board',
    title: '模块关系梳理',
    clientId: 'demo-seed-board-v1',
    operations: buildOperations('board', 'demo-seed-board-v1', [
      ['ADD', 'demo-board-card-websocket', 'CARD'],
      ['PUT', 'demo-board-card-websocket', 'CARD', 'x', 96],
      ['PUT', 'demo-board-card-websocket', 'CARD', 'y', 88],
      ['PUT', 'demo-board-card-websocket', 'CARD', 'w', 260],
      ['PUT', 'demo-board-card-websocket', 'CARD', 'h', 160],
      ['PUT', 'demo-board-card-websocket', 'CARD', 'z', 1],
      ['PUT', 'demo-board-card-websocket', 'CARD', 'text', 'WebSocket 实时层'],
      ['PUT', 'demo-board-card-websocket', 'CARD', 'color', '#dcecff'],
    ]),
    expected: {
      'demo-board-card-websocket': {
        type: 'CARD',
        fields: { x: 96, y: 88, w: 260, h: 160, z: 1, text: 'WebSocket 实时层', color: '#dcecff' },
      },
    },
  },
  {
    kind: 'kanban',
    title: '答辩准备计划',
    clientId: 'demo-seed-kanban-v1',
    operations: buildOperations('kanban', 'demo-seed-kanban-v1', [
      ['ADD', 'demo-kanban-todo', 'COLUMN'],
      ['PUT', 'demo-kanban-todo', 'COLUMN', 'title', '待处理'],
      ['PUT', 'demo-kanban-todo', 'COLUMN', 'order', 1024],
      ['ADD', 'demo-kanban-doing', 'COLUMN'],
      ['PUT', 'demo-kanban-doing', 'COLUMN', 'title', '进行中'],
      ['PUT', 'demo-kanban-doing', 'COLUMN', 'order', 2048],
      ['ADD', 'demo-kanban-done', 'COLUMN'],
      ['PUT', 'demo-kanban-done', 'COLUMN', 'title', '已完成'],
      ['PUT', 'demo-kanban-done', 'COLUMN', 'order', 3072],
      ['ADD', 'demo-kanban-card-data', 'CARD'],
      ['PUT', 'demo-kanban-card-data', 'CARD', 'column', 'demo-kanban-todo'],
      ['PUT', 'demo-kanban-card-data', 'CARD', 'order', 1024],
      ['PUT', 'demo-kanban-card-data', 'CARD', 'text', '准备演示数据'],
      ['PUT', 'demo-kanban-card-data', 'CARD', 'color', '#fff1c9'],
      ['ADD', 'demo-kanban-card-reconnect', 'CARD'],
      ['PUT', 'demo-kanban-card-reconnect', 'CARD', 'column', 'demo-kanban-doing'],
      ['PUT', 'demo-kanban-card-reconnect', 'CARD', 'order', 1024],
      ['PUT', 'demo-kanban-card-reconnect', 'CARD', 'text', '验证断线恢复'],
      ['PUT', 'demo-kanban-card-reconnect', 'CARD', 'color', '#e2edff'],
      ['ADD', 'demo-kanban-card-report', 'CARD'],
      ['PUT', 'demo-kanban-card-report', 'CARD', 'column', 'demo-kanban-done'],
      ['PUT', 'demo-kanban-card-report', 'CARD', 'order', 1024],
      ['PUT', 'demo-kanban-card-report', 'CARD', 'text', '归档测试报告'],
      ['PUT', 'demo-kanban-card-report', 'CARD', 'color', '#dff3e5'],
    ]),
    expected: {
      'demo-kanban-todo': { type: 'COLUMN', fields: { title: '待处理', order: 1024 } },
      'demo-kanban-doing': { type: 'COLUMN', fields: { title: '进行中', order: 2048 } },
      'demo-kanban-done': { type: 'COLUMN', fields: { title: '已完成', order: 3072 } },
      'demo-kanban-card-data': { type: 'CARD', fields: { column: 'demo-kanban-todo', order: 1024, text: '准备演示数据', color: '#fff1c9' } },
      'demo-kanban-card-reconnect': { type: 'CARD', fields: { column: 'demo-kanban-doing', order: 1024, text: '验证断线恢复', color: '#e2edff' } },
      'demo-kanban-card-report': { type: 'CARD', fields: { column: 'demo-kanban-done', order: 1024, text: '归档测试报告', color: '#dff3e5' } },
    },
  },
]

function normalizeBase(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('DEMO_API_BASE 只允许 http/https')
  url.pathname = url.pathname.replace(/\/$/, '') || '/'
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function requiredSecret(name) {
  const value = process.env[name]
  if (!value) throw new Error(`缺少环境变量 ${name}；脚本不会提供或保存默认密码`)
  return value
}

function buildOperations(prefix, clientId, rows) {
  return rows.map((row, index) => {
    const [type, elementId, elementType, field, value] = row
    const sequence = index + 1
    const operation = {
      type,
      elementId,
      elementType,
      clock: `${clientId}:${1000 + sequence}`,
    }
    if (type === 'PUT') {
      operation.field = field
      operation.value = value
    }
    return {
      opId: `demo.seed.${prefix}.${String(sequence).padStart(3, '0')}`,
      op: operation,
    }
  })
}

async function request(path, { method = 'GET', token, body, accepted = null } = {}) {
  const url = new URL(path, `${API_BASE}/`)
  const headers = { Accept: 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let response
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(`请求 ${method} ${url} 失败: ${error.message}`)
  }

  const text = await response.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }

  const allowed = accepted || ((status) => status >= 200 && status < 300)
  const ok = typeof allowed === 'function' ? allowed(response.status) : allowed.includes(response.status)
  if (!ok) {
    const detail = typeof data === 'object' && data?.msg ? data.msg : String(data || response.statusText)
    throw new Error(`${method} ${url.pathname} 返回 HTTP ${response.status}: ${detail}`)
  }
  return { status: response.status, data }
}

async function ensureAccount(account) {
  const registration = await request('/api/auth/register', {
    method: 'POST',
    body: { username: account.username, password: account.password, nickname: account.nickname },
    accepted: [200, 409],
  })
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { username: account.username, password: account.password },
  })
  if (!login.data?.token) throw new Error(`${account.username} 登录成功但响应中没有 token`)
  const me = await request('/api/auth/me', { token: login.data.token })
  if (!me.data?.user?.id) throw new Error(`${account.username} 的 /api/auth/me 响应不完整`)
  return {
    token: login.data.token,
    user: me.data.user,
    created: registration.status === 200,
  }
}

async function ensureSpace(owner) {
  const listed = await request('/api/spaces', { token: owner.token })
  const matches = (listed.data || []).filter((space) =>
    space.name === SPACE_NAME && Number(space.owner_id) === Number(owner.user.id))
  if (matches.length > 1) {
    throw new Error(`发现 ${matches.length} 个同名且同所有者的“${SPACE_NAME}”，请先人工消除歧义`)
  }
  if (matches.length === 1) return { id: Number(matches[0].id), created: false }

  const created = await request('/api/spaces', {
    method: 'POST',
    token: owner.token,
    body: { name: SPACE_NAME },
  })
  return { id: Number(created.data.spaceId), created: true }
}

async function ensureMember(ownerToken, spaceId, username, role) {
  await request(`/api/spaces/${spaceId}/members`, {
    method: 'POST',
    token: ownerToken,
    body: { username, role },
  })
}

async function verifyMembers(ownerToken, spaceId) {
  const response = await request(`/api/spaces/${spaceId}/members`, { token: ownerToken })
  const members = response.data?.members || []
  const expected = new Map([
    [accounts.owner.username, 'owner'],
    [accounts.editor.username, 'editor'],
    [accounts.viewer.username, 'viewer'],
  ])
  for (const [username, role] of expected) {
    const member = members.find((item) => item.username === username)
    if (!member || member.role !== role) {
      throw new Error(`空间成员校验失败: ${username} 应为 ${role}`)
    }
  }
}

async function ensureDocument(ownerToken, spaceId, definition) {
  const query = new URLSearchParams({ spaceId: String(spaceId), kind: definition.kind })
  const listed = await request(`/api/docs?${query}`, { token: ownerToken })
  const matches = (listed.data || []).filter((item) => item.title === definition.title)
  if (matches.length > 1) {
    throw new Error(`空间内存在 ${matches.length} 个同类型同标题内容“${definition.title}”，请先人工消除歧义`)
  }
  if (matches.length === 1) return { docKey: matches[0].doc_key, created: false }

  const created = await request('/api/docs', {
    method: 'POST',
    token: ownerToken,
    body: { title: definition.title, kind: definition.kind, spaceId },
  })
  return { docKey: created.data.docKey, created: true }
}

function isServerBootstrap(row, docKey) {
  return String(row.operation_id || '').startsWith(`server:${docKey}:`)
    || String(row.clock || '').includes(`|server:${docKey}:`)
}

async function inspectExistingDocument(ownerToken, document, definition) {
  const response = await request(`/api/docs/${document.docKey}/history?limit=200`, { token: ownerToken })
  const operations = response.data?.ops || []
  const marker = definition.operations[0].opId
  const seeded = operations.some((row) => row.operation_id === marker)
  const foreign = operations.filter((row) =>
    !isServerBootstrap(row, document.docKey)
      && !String(row.operation_id || '').startsWith(`demo.seed.${definition.kind}.`))

  if (!document.created && !seeded && foreign.length) {
    throw new Error(`同名内容“${definition.title}”已有非 seed 操作，拒绝自动接管`)
  }
  return { seeded }
}

function websocketAddress(token) {
  const url = new URL('/ws/collab', `${API_BASE}/`)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('token', token)
  return url
}

async function applySeedOperations(ownerToken, docKey, definition) {
  const socket = new WebSocket(websocketAddress(ownerToken))
  const queue = []
  const waiters = []
  let closedError = null

  function deliver(message) {
    const index = waiters.findIndex((waiter) => waiter.predicate(message))
    if (index < 0) {
      queue.push(message)
      return
    }
    const waiter = waiters.splice(index, 1)[0]
    clearTimeout(waiter.timer)
    waiter.resolve(message)
  }

  function rejectWaiters(error) {
    closedError = error
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  }

  function waitFor(predicate, label) {
    const index = queue.findIndex(predicate)
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0])
    if (closedError) return Promise.reject(closedError)
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null }
      waiter.timer = setTimeout(() => {
        const current = waiters.indexOf(waiter)
        if (current >= 0) waiters.splice(current, 1)
        reject(new Error(`${label} 等待 WebSocket 响应超时`))
      }, WS_TIMEOUT_MS)
      waiters.push(waiter)
    })
  }

  socket.addEventListener('message', (event) => {
    try {
      deliver(JSON.parse(String(event.data)))
    } catch {
      rejectWaiters(new Error('服务端返回了无法解析的 WebSocket 消息'))
    }
  })
  socket.addEventListener('close', (event) => {
    if (event.code !== 1000) {
      rejectWaiters(new Error(`WebSocket 提前关闭 code=${event.code} reason=${event.reason || 'unknown'}`))
    }
  })

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket 握手超时')), WS_TIMEOUT_MS)
      const onOpen = () => {
        clearTimeout(timer)
        socket.removeEventListener('error', onError)
        resolve()
      }
      const onError = () => {
        clearTimeout(timer)
        socket.removeEventListener('open', onOpen)
        reject(new Error('WebSocket 握手失败'))
      }
      socket.addEventListener('open', onOpen, { once: true })
      socket.addEventListener('error', onError, { once: true })
    })

    socket.send(JSON.stringify({
      type: 'hello',
      docId: docKey,
      clientId: definition.clientId,
      hostname: 'demo-seed',
      lastRev: 0,
    }))
    const joined = await waitFor(
      (message) => ['welcome', 'incremental', 'error'].includes(message.type),
      `${definition.title} 加入`,
    )
    if (joined.type === 'error') throw new Error(`${definition.title} 加入失败: ${joined.code} ${joined.message}`)

    let revision = Number(joined.rev ?? joined.toRev ?? 0)
    for (const item of definition.operations) {
      socket.send(JSON.stringify({
        type: 'op',
        docId: docKey,
        clientId: definition.clientId,
        baseRev: revision,
        opId: item.opId,
        op: item.op,
      }))
      const reply = await waitFor(
        (message) => message.type === 'error'
          || (message.type === 'applied'
            && (message.opId === item.opId || message.op?.clock === item.op.clock)),
        `${definition.title} ${item.opId}`,
      )
      if (reply.type === 'error') {
        throw new Error(`${definition.title} 写入失败: ${reply.code} ${reply.message}`)
      }
      revision = Number(reply.rev ?? revision)
    }

    return revision
  } finally {
    if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'seed complete')
  }
}

function fieldValue(element, name) {
  return element?.fields?.[name]?.value
}

async function verifyBaseline(ownerToken, docKey, definition) {
  const history = await request(`/api/docs/${docKey}/history?limit=200`, { token: ownerToken })
  const rows = history.data?.ops || []
  const seedRows = rows.filter((row) =>
    String(row.operation_id || '').startsWith(`demo.seed.${definition.kind}.`))
  const ids = new Set(seedRows.map((row) => row.operation_id))
  const missing = definition.operations.filter((item) => !ids.has(item.opId))
  if (missing.length) {
    throw new Error(`${definition.title} 缺少 seed 操作: ${missing.map((item) => item.opId).join(', ')}`)
  }

  const baselineRev = Math.max(...seedRows.map((row) => Number(row.seq)))
  const replay = await request(`/api/docs/${docKey}/replay?rev=${baselineRev}`, { token: ownerToken })
  const elements = new Map((replay.data?.elements || []).map((element) => [element.id, element]))
  for (const [elementId, expected] of Object.entries(definition.expected)) {
    const actual = elements.get(elementId)
    if (!actual || actual.type !== expected.type || fieldValue(actual, '#tombstone') === true) {
      throw new Error(`${definition.title} 基线元素校验失败: ${elementId}`)
    }
    for (const [field, value] of Object.entries(expected.fields)) {
      if (fieldValue(actual, field) !== value) {
        throw new Error(`${definition.title} 基线字段校验失败: ${elementId}.${field}`)
      }
    }
  }
  return baselineRev
}

async function main() {
  const health = await request('/api/health')
  if (health.data?.status !== 'UP') throw new Error('/api/health 未返回 UP')
  console.log(`[1/5] 后端健康检查通过: ${API_BASE}`)

  const owner = await ensureAccount(accounts.owner)
  const editor = await ensureAccount(accounts.editor)
  const viewer = await ensureAccount(accounts.viewer)
  console.log(`[2/5] 三个演示账号就绪: ${owner.created || editor.created || viewer.created ? '包含新建账号' : '全部复用'}`)

  const space = await ensureSpace(owner)
  await ensureMember(owner.token, space.id, editor.user.username, 'editor')
  await ensureMember(owner.token, space.id, viewer.user.username, 'viewer')
  await verifyMembers(owner.token, space.id)
  console.log(`[3/5] 空间与 owner/editor/viewer 角色就绪: spaceId=${space.id}`)

  const resources = []
  for (const definition of definitions) {
    const document = await ensureDocument(owner.token, space.id, definition)
    const before = await inspectExistingDocument(owner.token, document, definition)
    await applySeedOperations(owner.token, document.docKey, definition)
    const baselineRev = await verifyBaseline(owner.token, document.docKey, definition)
    resources.push({
      kind: definition.kind,
      title: definition.title,
      docKey: document.docKey,
      baselineRev,
      reused: !document.created,
      alreadySeeded: before.seeded,
    })
  }
  console.log('[4/5] 文档、白板、看板基线已通过日志回放校验')

  const stats = await request('/api/stats', { token: owner.token })
  console.log(`[5/5] 演示数据准备完成，当前可见操作数: ${stats.data?.operations ?? 'unknown'}`)
  console.log(JSON.stringify({
    space: { id: space.id, name: SPACE_NAME },
    accounts: {
      owner: owner.user.username,
      editor: editor.user.username,
      viewer: viewer.user.username,
    },
    resources,
  }, null, 2))
}

main().catch((error) => {
  console.error(`演示数据准备失败: ${error.message}`)
  process.exitCode = 1
})
