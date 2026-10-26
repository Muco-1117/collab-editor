import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const base = process.env.E2E_BASE_URL || 'http://localhost:5175'
const out = path.resolve(process.env.E2E_OUTPUT_DIR || 'artifacts/round2-20261022/live-members')
await fs.mkdir(out, { recursive: true })
const suffix = randomBytes(5).toString('hex')
const password = randomBytes(15).toString('base64')
async function api(route, token, method = 'GET', body) {
  const response = await fetch(base + route, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  assert.ok(response.ok, `${method} ${route}: ${response.status}`)
  return response.json()
}
const owner = await api('/api/auth/register', null, 'POST', { username: `live_owner_${suffix}`, password, nickname: '空间所有者' })
const editor = await api('/api/auth/register', null, 'POST', { username: `live_editor_${suffix}`, password, nickname: '协作同学' })
const space = await api('/api/spaces', owner.token, 'POST', { name: `协作验证_${suffix}` })
await api(`/api/spaces/${space.spaceId}/members`, owner.token, 'POST', { username: `live_editor_${suffix}`, role: 'editor' })
const docs = []
for (const kind of ['doc', 'board', 'kanban']) docs.push(await api('/api/docs', owner.token, 'POST', { spaceId: space.spaceId, kind, title: `${kind} 原始名称` }))
const browser = await chromium.launch({ headless: true })
const checks = [], errors = []
const pass = (label) => { checks.push(label); console.log('PASS', label) }
async function newAccountPage(token) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
  await context.addInitScript((value) => localStorage.setItem('collab_access_token', value), token)
  const page = await context.newPage()
  page.setDefaultTimeout(12_000)
  page.on('pageerror', (error) => errors.push(error.message))
  return page
}
const ownerPage = await newAccountPage(owner.token), peer = await newAccountPage(editor.token)
try {
  for (const doc of docs) {
    await peer.goto(`${base}/#/work/${doc.kind}/${doc.docKey}`)
    await peer.locator('.connection-success').waitFor()
    const title = `${doc.kind} 最新协作名称`
    await api(`/api/docs/${doc.docKey}`, owner.token, 'PUT', { title })
    await peer.locator('.workspace-title').filter({ hasText: title }).waitFor()
    await peer.locator('.workspace-sidebar .document-row.active strong').filter({ hasText: title }).waitFor()
    await peer.reload()
    await peer.locator('.workspace-title').filter({ hasText: title }).waitFor()
    await peer.locator('.connection-success').waitFor()
  }
  pass('三种内容的真实REST改名立即同步在线标题与列表，刷新后仍保留')

  const doc = docs[0]
  await peer.goto(`${base}/#/work/doc/${doc.docKey}`)
  await peer.locator('.connection-success').waitFor()
  await ownerPage.goto(`${base}/#/members?space=${space.spaceId}`)
  const member = ownerPage.locator('.member-row').filter({ hasText: `@live_editor_${suffix}` })
  await member.getByRole('button', { name: '管理成员：协作同学', exact: true }).click()
  await ownerPage.getByRole('menuitem', { name: '修改权限', exact: true }).click()
  let dialog = ownerPage.getByRole('dialog', { name: '修改成员权限', exact: true })
  await dialog.getByRole('radio', { name: /^只读者/ }).check()
  await dialog.getByRole('button', { name: '保存权限', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  await peer.locator('.readonly-strip').waitFor()
  assert.equal(await peer.getByRole('button', { name: '添加段落', exact: true }).count(), 0)
  assert.equal(await peer.locator('.paragraph-row textarea').first().isEditable(), false)
  pass('所有者在成员页面修改权限后，正在编辑的成员立即变为只读')

  await member.getByRole('button', { name: '管理成员：协作同学', exact: true }).click()
  await ownerPage.getByRole('menuitem', { name: '修改权限', exact: true }).click()
  dialog = ownerPage.getByRole('dialog', { name: '修改成员权限', exact: true })
  await dialog.getByRole('radio', { name: /^编辑者/ }).check()
  await dialog.getByRole('button', { name: '保存权限', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  await peer.getByRole('button', { name: '添加段落', exact: true }).waitFor()
  await peer.locator('.paragraph-row textarea').first().fill('恢复权限后的真实修改')
  await peer.locator('.connection-success').waitFor()
  const history = await api(`/api/docs/${doc.docKey}/history`, owner.token)
  const replay = await api(`/api/docs/${doc.docKey}/replay?rev=${history.rev}`, owner.token)
  assert.ok(replay.elements.some((element) => element.fields?.text?.value === '恢复权限后的真实修改'))
  pass('恢复编辑权限无需刷新，新增修改实际写入MySQL并可回放')

  await member.getByRole('button', { name: '管理成员：协作同学', exact: true }).click()
  await ownerPage.getByRole('menuitem', { name: '移出空间', exact: true }).click()
  dialog = ownerPage.getByRole('dialog', { name: '移出空间', exact: true })
  await dialog.getByRole('button', { name: '移出空间', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  await peer.getByRole('heading', { name: '当前内容已无法访问', exact: true }).waitFor()
  assert.equal(await peer.locator('.document-editor').count(), 0)
  assert.equal(await peer.getByRole('button', { name: '重新连接', exact: true }).count(), 0)
  await peer.screenshot({ path: path.join(out, 'member-removed.png'), fullPage: true })
  pass('成员页面移除后，在线页面退出编辑状态并提供清晰的返回入口')

  assert.deepEqual(errors, [])
  await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify({ status: 'passed', checks, errors, database: 'collab_editor_test' }, null, 2))
} catch (error) {
  await peer.screenshot({ path: path.join(out, 'failure-peer.png'), fullPage: true })
  await ownerPage.screenshot({ path: path.join(out, 'failure-owner.png'), fullPage: true })
  await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify({ status: 'failed', checks, errors, error: String(error) }, null, 2))
  throw error
} finally { await browser.close() }
