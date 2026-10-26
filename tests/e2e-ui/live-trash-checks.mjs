import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const base = process.env.E2E_BASE_URL || 'http://localhost:5175'
const out = path.resolve(process.env.E2E_OUTPUT_DIR || 'artifacts/round2-20261022/live-trash')
await fs.mkdir(out, { recursive: true })
const suffix = randomBytes(5).toString('hex'),
  password = randomBytes(16).toString('base64')
const checks = [],
  errors = []
const pass = (label) => {
  checks.push(label)
  console.log('PASS', label)
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
async function request(route, token, method = 'GET', body) {
  return fetch(base + route, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
}
async function api(route, token, method, body) {
  const response = await request(route, token, method, body)
  assert.ok(response.ok, `${method || 'GET'} ${route}: ${response.status}`)
  return response.json()
}
async function exportHash(key, kind, token) {
  const response = await request(
    `/api/docs/${key}/export?format=${kind === 'doc' ? 'html' : kind === 'board' ? 'svg' : 'csv'}`,
    token,
  )
  assert.ok(response.ok)
  return sha(Buffer.from(await response.arrayBuffer()))
}
const owner = await api('/api/auth/register', null, 'POST', {
  username: `trash_owner_${suffix}`,
  nickname: '内容所有者',
  password,
})
const editor = await api('/api/auth/register', null, 'POST', {
  username: `trash_editor_${suffix}`,
  nickname: '协作同学',
  password,
})
const viewer = await api('/api/auth/register', null, 'POST', {
  username: `trash_viewer_${suffix}`,
  nickname: '只读同学',
  password,
})
const space = await api('/api/spaces', owner.token, 'POST', { name: `可恢复内容验证_${suffix}` })
for (const [member, role] of [
  [editor, 'editor'],
  [viewer, 'viewer'],
])
  await api(`/api/spaces/${space.spaceId}/members`, owner.token, 'POST', {
    username: member.user.username,
    role,
  })
const docs = []
for (const kind of ['doc', 'board', 'kanban'])
  docs.push(
    await api('/api/docs', owner.token, 'POST', { kind, title: `可恢复${kind}`, spaceId: space.spaceId }),
  )
const browser = await chromium.launch({ headless: true })
async function accountPage(token) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
  await context.addInitScript((value) => localStorage.setItem('collab_access_token', value), token)
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', (error) => errors.push(error.message))
  return page
}
const ownerPage = await accountPage(owner.token),
  peer = await accountPage(editor.token)
const evidence = []
async function waitSaved(page) {
  await page.locator('.connection-success').waitFor()
  await page.waitForFunction(() => !document.querySelector('.connection-pending'))
}
try {
  for (const doc of docs) {
    await ownerPage.goto(`${base}/#/work/${doc.kind}/${doc.docKey}`)
    await waitSaved(ownerPage)
    if (doc.kind === 'board') await ownerPage.getByRole('button', { name: '添加卡片', exact: true }).click()
    if (doc.kind === 'kanban') {
      await ownerPage.locator('.kanban-tools').getByRole('button', { name: '添加列表', exact: true }).click()
      await ownerPage.getByRole('button', { name: '添加卡片', exact: true }).first().click()
    }
    const field = ownerPage
      .locator(
        doc.kind === 'doc'
          ? '.paragraph-row textarea'
          : doc.kind === 'board'
            ? '.board-card textarea'
            : '.kanban-card textarea',
      )
      .first()
    await field.fill(`${doc.kind} 恢复前保留的正文`)
    await waitSaved(ownerPage)
    const beforeHistory = await api(`/api/docs/${doc.docKey}/history`, owner.token)
    const before = await api(`/api/docs/${doc.docKey}/replay?rev=${beforeHistory.rev}`, owner.token)
    const beforeHash = await exportHash(doc.docKey, doc.kind, owner.token)
    await peer.goto(`${base}/#/work/${doc.kind}/${doc.docKey}`)
    await waitSaved(peer)
    const peerField = peer
      .locator(
        doc.kind === 'doc'
          ? '.paragraph-row textarea'
          : doc.kind === 'board'
            ? '.board-card textarea'
            : '.kanban-card textarea',
      )
      .first()
    assert.equal(await peerField.inputValue(), `${doc.kind} 恢复前保留的正文`)

    await ownerPage.goto(`${base}/#/library/${doc.kind}?space=${space.spaceId}`)
    // Hash navigation may resolve while the old editor sidebar is still mounted.
    // Target the loaded library, where this deletion is being exercised.
    const library = ownerPage.locator('.content-library')
    await library.waitFor()
    await library.getByRole('button', { name: `更多操作：${doc.title}`, exact: true }).click()
    await ownerPage.getByRole('menuitem', { name: '删除内容', exact: true }).click()
    const dialog = ownerPage.getByRole('dialog', { name: '删除内容', exact: true })
    assert.match(await dialog.textContent(), /回收站.*恢复/)
    await dialog.getByRole('button', { name: '删除', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    await peer.getByRole('heading', { name: '当前内容已无法访问', exact: true }).waitFor()
    assert.equal(await peer.locator('.document-editor,.board-editor,.kanban-editor').count(), 0)
    assert.equal((await request(`/api/spaces/${space.spaceId}/trash`, viewer.token)).status, 403)
    assert.equal((await request(`/api/docs/${doc.docKey}/restore-deleted`, editor.token, 'POST')).status, 403)
    await ownerPage
      .getByRole('navigation', { name: '空间管理' })
      .getByRole('link', { name: '回收站', exact: true })
      .click()
    const deleted = ownerPage.locator(`[data-trash-key="${doc.docKey}"]`)
    await deleted.waitFor()
    await deleted.getByRole('button', { name: `恢复${doc.title}`, exact: true }).click()
    await ownerPage.locator('.trash-restored').waitFor()
    await ownerPage.locator('.trash-restored').getByRole('button', { name: '打开内容', exact: true }).click()
    await waitSaved(ownerPage)
    const afterHistory = await api(`/api/docs/${doc.docKey}/history`, owner.token)
    const after = await api(`/api/docs/${doc.docKey}/replay?rev=${afterHistory.rev}`, owner.token)
    assert.equal(afterHistory.rev, beforeHistory.rev)
    assert.deepEqual(after.elements, before.elements)
    const afterHash = await exportHash(doc.docKey, doc.kind, owner.token)
    assert.equal(afterHash, beforeHash)

    await peer.reload()
    await waitSaved(peer)
    await peerField.fill(`${doc.kind} 恢复后继续协作`)
    await waitSaved(peer)
    await ownerPage.waitForFunction(
      ({ kind, text }) =>
        [
          ...document.querySelectorAll(
            kind === 'doc'
              ? '.paragraph-row textarea'
              : kind === 'board'
                ? '.board-card textarea'
                : '.kanban-card textarea',
          ),
        ].some((element) => element.value === text),
      { kind: doc.kind, text: `${doc.kind} 恢复后继续协作` },
    )
    const persisted = await api(`/api/docs/${doc.docKey}/history`, owner.token)
    const replay = await api(`/api/docs/${doc.docKey}/replay?rev=${persisted.rev}`, owner.token)
    assert.ok(replay.elements.some((element) => element.fields?.text?.value === `${doc.kind} 恢复后继续协作`))
    await ownerPage.screenshot({ path: path.join(out, `restored-${doc.kind}.png`), fullPage: true })
    evidence.push({
      kind: doc.kind,
      docKey: doc.docKey,
      beforeRevision: beforeHistory.rev,
      afterRestoreRevision: afterHistory.rev,
      editedRevision: persisted.rev,
      exportSha256: beforeHash,
    })
    pass(`${doc.kind}：真实页面删除同步退出在线编辑，权限保护正确，恢复正文/历史/导出一致并继续双人协作`)
  }
  await ownerPage.goto(`${base}/#/trash?space=${space.spaceId}`)
  await ownerPage.getByRole('heading', { name: '回收站是空的', exact: true }).waitFor()
  const stats = await api('/api/stats', owner.token)
  assert.equal(stats.recentActivity.length, 7)
  assert.ok(stats.contributors.every((person) => person.actor_id != null))
  pass('恢复全部内容后回收站为空，真实统计返回连续七天与稳定成员标识')
  assert.deepEqual(errors, [])
  await fs.writeFile(
    path.join(out, 'summary.json'),
    JSON.stringify({ status: 'passed', database: 'collab_editor_test', checks, errors, evidence }, null, 2),
  )
} catch (error) {
  await ownerPage.screenshot({ path: path.join(out, 'failure-owner.png'), fullPage: true })
  await peer.screenshot({ path: path.join(out, 'failure-peer.png'), fullPage: true })
  await fs.writeFile(
    path.join(out, 'summary.json'),
    JSON.stringify({ status: 'failed', checks, errors, evidence, error: String(error) }, null, 2),
  )
  throw error
} finally {
  await browser.close()
}
