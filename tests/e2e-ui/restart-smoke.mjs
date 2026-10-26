import { spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = path.resolve(process.env.E2E_OUTPUT_DIR || path.join(root, 'artifacts/runtime/restart-smoke'))
const base = 'http://127.0.0.1:8082'
const env = {
  ...process.env,
  JWT_SECRET: randomBytes(48).toString('base64'),
  UPLOAD_DIR: path.join(output, 'uploads'),
}
const jdbc =
  'jdbc:mysql://localhost:3306/collab_editor_test?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Shanghai'
let server
let generation = 0
let log
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}
async function start() {
  generation++
  log = await fs.open(path.join(output, `server-${generation}.log`), 'w')
  server = spawn(
    'java',
    [
      '-jar',
      path.join(root, 'server/target/server-0.1.0.jar'),
      '--server.port=8082',
      `--spring.datasource.url=${jdbc}`,
    ],
    { cwd: root, env, windowsHide: true, stdio: ['ignore', log.fd, log.fd] },
  )
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    if (server.exitCode != null) throw new Error('重启测试服务启动失败，见日志')
    try {
      if ((await fetch(`${base}/api/health`)).ok) return
    } catch {
      /* startup */
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('重启测试服务启动超时')
}
async function stop() {
  if (!server) return
  const process = server
  server = null
  const closed = new Promise((resolve) => process.once('close', resolve))
  process.kill()
  let timer
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('关闭测试服务超时')), 10000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
  await log.close()
}
async function call(route, token, options = {}) {
  const response = await fetch(base + route, {
    ...options,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
  })
  assert(response.ok, `${route} 返回 ${response.status}`)
  return response
}
const post = (route, token, value) =>
  call(route, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  }).then((r) => r.json())
async function socket(token, docId) {
  const ws = new WebSocket(base.replace('http:', 'ws:') + `/ws/collab?token=${encodeURIComponent(token)}`)
  const inbox = [],
    waiters = []
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.type === 'error') {
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error(message.message))
      }
      return
    }
    const index = waiters.findIndex((waiter) => waiter.type === message.type)
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1)
      clearTimeout(waiter.timer)
      waiter.resolve(message)
    } else inbox.push(message)
  }
  const next = (type) => {
    const index = inbox.findIndex((message) => message.type === type)
    if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0])
    return new Promise((resolve, reject) => {
      const waiter = {
        type,
        resolve,
        reject,
        timer: setTimeout(() => reject(new Error(`等待 ${type} 超时`)), 10000),
      }
      waiters.push(waiter)
    })
  }
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  ws.send(JSON.stringify({ type: 'hello', docId, clientId: 'restart-test', lastRev: 0 }))
  return { ws, next, welcome: await next('welcome') }
}
function canonical(elements) {
  return JSON.stringify(
    elements
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((element) => ({
        ...element,
        fields: Object.fromEntries(Object.entries(element.fields).sort(([a], [b]) => a.localeCompare(b))),
      })),
  )
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
await fs.mkdir(output, { recursive: true })
const report = {
  startedAt: new Date().toISOString(),
  database: 'collab_editor_test',
  processRestart: true,
  status: 'running',
}
try {
  await start()
  const suffix = randomBytes(6).toString('hex')
  const user = {
    username: `restart_${suffix}`,
    nickname: '重启验证用户',
    password: randomBytes(12).toString('base64'),
  }
  await post('/api/auth/register', null, user)
  const { token } = await post('/api/auth/login', null, user)
  const { docKey } = await post('/api/docs', token, { title: '重启含图验证', kind: 'doc' })
  const fixture = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAIAAACDRijCAAAAGUlEQVR4XmNgGAUkgf8m6ehCo2AUjALqAABp/wGbuotOowAAAABJRU5ErkJggg==',
    'base64',
  )
  const body = new FormData()
  body.append('file', new Blob([fixture], { type: 'image/png' }), 'restart-image.png')
  const asset = await (await call(`/api/docs/${docKey}/images`, token, { method: 'POST', body })).json()
  const first = await socket(token, docKey)
  const op = {
    type: 'STATE',
    elementId: 'persisted-image',
    elementType: 'IMAGE',
    opId: 'restart-image-op',
    clock: 'restart-test:100',
    value: { ...asset, order: 1024 },
  }
  first.ws.send(JSON.stringify({ type: 'op', op }))
  const applied = await first.next('applied')
  const rev = applied.rev
  const before = await (await call(`/api/docs/${docKey}/replay?rev=${rev}`, token)).json()
  const htmlBefore = Buffer.from(
    await (await call(`/api/docs/${docKey}/export?format=html`, token)).arrayBuffer(),
  )
  first.ws.close()
  await stop()
  await start()
  const second = await socket(token, docKey)
  assert(second.welcome.rev === rev, '服务重启后版本号改变')
  assert(canonical(second.welcome.snapshot) === canonical(before.elements), '服务重启后含图业务状态不一致')
  second.ws.send(JSON.stringify({ type: 'op', op }))
  const duplicate = await second.next('applied')
  assert(duplicate.duplicate === true && duplicate.rev === rev, '服务重启后重传未正确去重')
  const restoredImage = Buffer.from(await (await call(asset.url, token)).arrayBuffer())
  assert(sha(restoredImage) === sha(fixture), '服务重启后图片二进制改变')
  const htmlAfter = Buffer.from(
    await (await call(`/api/docs/${docKey}/export?format=html`, token)).arrayBuffer(),
  )
  assert(sha(htmlAfter) === sha(htmlBefore), '服务重启后导出内容改变')
  second.ws.close()
  const metadata = await (await call(`/api/docs/${docKey}`, token)).json()
  const spaceId = metadata.space_id ?? metadata.spaceId
  assert(spaceId != null, '文档缺少所属空间')
  await call(`/api/docs/${docKey}`, token, { method: 'DELETE' })
  await stop()
  await start()
  const deleted = await (await call(`/api/spaces/${spaceId}/trash`, token)).json()
  assert(
    deleted.documents.some((document) => document.doc_key === docKey),
    '删除后重启，回收站没有保留内容',
  )
  await post(`/api/docs/${docKey}/restore-deleted`, token, {})
  await stop()
  await start()
  const third = await socket(token, docKey)
  assert(third.welcome.rev === rev, '恢复后重启，内容版本号改变')
  assert(canonical(third.welcome.snapshot) === canonical(before.elements), '恢复后重启，正文与图片字段不一致')
  const trashAfter = await (await call(`/api/spaces/${spaceId}/trash`, token)).json()
  assert(!trashAfter.documents.some((document) => document.doc_key === docKey), '恢复状态未持久化')
  const restoredImageAfterTrash = Buffer.from(await (await call(asset.url, token)).arrayBuffer())
  const restoredHtmlAfterTrash = Buffer.from(
    await (await call(`/api/docs/${docKey}/export?format=html`, token)).arrayBuffer(),
  )
  assert(sha(restoredImageAfterTrash) === sha(fixture), '恢复后重启，图片二进制改变')
  assert(sha(restoredHtmlAfterTrash) === sha(htmlBefore), '恢复后重启，导出内容改变')
  third.ws.close()
  Object.assign(report, {
    status: 'passed',
    docKey,
    revision: rev,
    assetId: asset.assetId,
    imageSha256: sha(fixture),
    htmlSha256: sha(htmlAfter),
    duplicateAcknowledged: true,
    trashPersistedAcrossRestart: true,
    restoredContentPersistedAcrossRestart: true,
    generations: generation,
  })
} catch (error) {
  report.status = 'failed'
  report.error = error.message
  process.exitCode = 1
} finally {
  await stop().catch((error) => {
    report.shutdownError = error.message
    process.exitCode = 1
  })
  report.finishedAt = new Date().toISOString()
  await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
