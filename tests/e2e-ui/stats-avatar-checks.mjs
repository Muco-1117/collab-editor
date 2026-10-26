import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const base = process.env.E2E_BASE_URL || 'http://localhost:5173'
const out = path.resolve(process.env.E2E_OUTPUT_DIR || 'artifacts/round2-20261022/stats-avatar')
await fs.mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
const page = await context.newPage()
page.setDefaultTimeout(12_000)
const checks = [],
  errors = [],
  warnings = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('console', (message) => {
  if (message.type() === 'warning') warnings.push(message.text())
})
const pass = (text) => {
  checks.push(text)
  console.log('PASS', text)
}
const user = {
  id: 902101,
  username: 'stats_avatar',
  nickname: '林间来信',
  avatarUrl: '/api/users/902101/avatar?v=1',
}
const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWQ0AAAAASUVORK5CYII=',
  'base64',
)
const token = (version) =>
  `header.${Buffer.from(JSON.stringify({ uid: user.id, sub: user.username, exp: 9999999999 })).toString('base64url')}.signature${version}`
let currentToken = token(1),
  refreshes = 0,
  avatarFailures = 0,
  statsCalls = 0,
  zero = false,
  fail = false
await context.addInitScript((value) => {
  localStorage.setItem('collab_access_token', value)
}, currentToken)
await context.route('**/api/**', async (route) => {
  const request = route.request(),
    url = new URL(request.url())
  const ok = (json) => route.fulfill({ json })
  if (url.pathname === '/api/auth/refresh') {
    refreshes++
    currentToken = token(2)
    return ok({ token: currentToken })
  }
  if (url.pathname === '/api/auth/me') return ok({ user })
  if (url.pathname === '/api/users/902101/avatar') {
    if (request.headers().authorization !== `Bearer ${token(2)}`) {
      avatarFailures++
      return route.fulfill({ status: 401, json: { msg: 'expired' } })
    }
    return route.fulfill({ contentType: 'image/png', body: image })
  }
  if (url.pathname === '/api/spaces')
    return ok([{ id: 501, name: '产品设计协作空间', my_role: 'owner', doc_count: 2 }])
  if (url.pathname.endsWith('/members')) return ok({ members: [{ ...user, role: 'owner' }] })
  if (url.pathname === '/api/docs') return ok([])
  if (url.pathname === '/api/stats') {
    statsCalls++
    if (fail) return route.fulfill({ status: 503, json: { msg: '模拟统计暂不可用' } })
    return ok({
      spaces: 1,
      documents: zero ? 0 : 2,
      operations: zero ? 0 : 34567,
      ownOperations: zero ? 0 : 12345,
      byApplication: zero
        ? []
        : [
            { kind: 'doc', operation_count: 0 },
            { kind: 'board', operation_count: 125 },
            { kind: 'kanban', operation_count: 24 },
          ],
      byOperation: zero
        ? []
        : [
            { operation_type: 'STATE', operation_count: 125 },
            { operation_type: 'DELETE', operation_count: 24 },
          ],
      recentActivity: Array.from({ length: 7 }, (_, index) => ({
        activity_date: `2026-10-${index + 16}`,
        operation_count: zero ? 0 : [0, 4, 0, 20, 5, 0, 12][index],
      })),
      contributors: zero
        ? []
        : [
            { actor_id: 1, actor_name: '同名协作成员', operation_count: 125 },
            { actor_id: 2, actor_name: '同名协作成员', operation_count: 24 },
          ],
    })
  }
  return ok({})
})
async function nav(name) {
  const menu = page.getByRole('button', { name: '打开导航', exact: true })
  if (await menu.isVisible()) await menu.click()
  await page.locator('.workbench-nav').getByRole('link', { name, exact: true }).click()
}
async function shot(name) {
  await page.screenshot({ path: path.join(out, name + '.png'), fullPage: true, animations: 'disabled' })
}
try {
  await page.goto(`${base}/#/?space=501`)
  await page.locator('.topbar-user .user-avatar img').waitFor()
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.user-avatar img')].every(
      (image) => image.complete && image.naturalWidth > 0,
    ),
  )
  assert.ok(avatarFailures >= 1)
  assert.equal(refreshes, 1)
  assert.equal(await page.evaluate(() => localStorage.getItem('collab_access_token')), token(2))
  assert.equal(statsCalls, 0)
  pass('头像遇到过期凭据共用一次登录续期并恢复显示，首页不额外请求统计')

  await nav('协同统计')
  await page.locator('.activity-day').nth(6).waitFor()
  assert.equal(statsCalls, 1)
  const heights = await page
    .locator('.activity-day i')
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height))
  assert.equal(heights[0], 0)
  assert.equal(heights[2], 0)
  assert.equal(heights[5], 0)
  assert.ok(heights[3] > heights[1])
  assert.equal(
    await page
      .locator('.bar-group')
      .first()
      .locator('.bar-track i')
      .first()
      .evaluate((element) => element.getBoundingClientRect().width),
    0,
  )
  assert.deepEqual(await page.locator('.contributor-list strong').allTextContents(), [
    '同名协作成员',
    '同名协作成员',
  ])
  assert.deepEqual(await page.locator('.contributor-list em').allTextContents(), ['125 次', '24 次'])
  await shot('stats-desktop')
  pass('完整七天按真实数值绘图，零值没有假柱，同名成员分别显示且无重复key')

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    assert.ok(
      await page.evaluate(
        () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= innerWidth + 1,
      ),
      `${width}px overflow`,
    )
    assert.ok(
      await page
        .locator('.metric strong')
        .evaluateAll((elements) =>
          elements.every((element) => element.scrollWidth <= element.clientWidth + 1),
        ),
      `${width}px metric text clipped`,
    )
    await shot(`stats-${width}`)
  }
  pass('390/320px大数值指标不裁切，图表与贡献者列表无横向溢出')

  zero = true
  await page.reload()
  await page.locator('.activity-day').nth(6).waitFor()
  assert.deepEqual(
    await page
      .locator('.activity-day i')
      .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height)),
    [0, 0, 0, 0, 0, 0, 0],
  )
  await shot('stats-empty-320')
  fail = true
  await page.reload()
  await page.getByRole('button', { name: '重新加载统计' }).waitFor()
  fail = false
  await page.getByRole('button', { name: '重新加载统计' }).click()
  await page.locator('.activity-day').nth(6).waitFor()
  pass('零活动日期仍可读，统计失败可单独重试')
  assert.deepEqual(errors, [])
  assert.equal(
    warnings.some((message) => /duplicate keys/i.test(message)),
    false,
  )
  await fs.writeFile(
    path.join(out, 'summary.json'),
    JSON.stringify({ status: 'passed', checks, errors, warnings }, null, 2),
  )
} catch (error) {
  await shot('failure')
  await fs.writeFile(
    path.join(out, 'summary.json'),
    JSON.stringify({ status: 'failed', checks, errors, warnings, error: String(error) }, null, 2),
  )
  throw error
} finally {
  await browser.close()
}
