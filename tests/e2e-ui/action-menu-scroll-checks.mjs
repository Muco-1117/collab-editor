import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const base = process.env.E2E_BASE_URL || 'http://localhost:5176'
const out = path.resolve(process.env.E2E_OUTPUT_DIR || 'artifacts/round2-20261022/action-menu-scroll')
await fs.mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
const page = await context.newPage()
page.setDefaultTimeout(8_000)
const checks = [],
  errors = [],
  requests = []
page.on('pageerror', (error) => errors.push(error.message))
const pass = (name) => {
  checks.push(name)
  console.log('PASS', name)
}
const user = { id: 902043, username: 'menu_fixture', nickname: '菜单验证', avatarUrl: '' }
const space = { id: 601, name: '交互验证空间', my_role: 'owner', doc_count: 7 }
const docs = [
  '毕业设计进度跟踪',
  '团队头脑风暴',
  '项目介绍与使用指南',
  '用户访谈与反馈整理',
  '第一阶段迭代计划',
  '工作台交互方案',
  '产品需求与功能规划',
].map((title, index) => ({
  doc_key: `menu-${index}`,
  title,
  kind: 'doc',
  space_id: space.id,
  space_name: space.name,
  my_role: 'owner',
  updated_at: `2026-10-${String(22 - index).padStart(2, '0')}T08:00:00`,
}))
await context.addInitScript(() => {
  localStorage.setItem('collab_access_token', 'action-menu-mock')
  window.__menuEvents = []
  for (const type of ['scroll', 'focusin', 'pointerdown', 'click']) {
    window.addEventListener(
      type,
      (event) => {
        const active = document.querySelector('.action-menu-trigger[aria-expanded="true"]')
        const anchor = active?.getBoundingClientRect()
        window.__menuEvents.push({
          type,
          target: event.target?.className || event.target?.nodeName,
          opened: !!active,
          anchorTop: anchor?.top,
          anchorBottom: anchor?.bottom,
          menu: !!document.querySelector('.action-menu'),
        })
        if (window.__menuEvents.length > 150) window.__menuEvents.shift()
      },
      true,
    )
  }
})
await context.route('**/api/**', async (route) => {
  const url = new URL(route.request().url()),
    method = route.request().method()
  requests.push({ path: url.pathname, method })
  const ok = (json) => route.fulfill({ json })
  if (url.pathname === '/api/auth/me') return ok({ user })
  if (url.pathname === '/api/spaces') return ok([space])
  if (url.pathname.endsWith('/members')) return ok({ members: [{ ...user, role: 'owner' }] })
  if (url.pathname === '/api/docs') return ok(docs)
  if (url.pathname.endsWith('/history')) return ok({ rev: 1, ops: [] })
  if (url.pathname.endsWith('/replay')) return ok({ rev: 1, elements: [] })
  const doc = docs.find((item) => url.pathname === `/api/docs/${item.doc_key}`)
  if (doc && method === 'PUT') {
    doc.title = route.request().postDataJSON().title
    return ok({ title: doc.title, docKey: doc.doc_key })
  }
  if (doc && method === 'GET') return ok(doc)
  return route.fulfill({ status: 404, json: { msg: 'mock 不允许此请求' } })
})
await context.routeWebSocket(/\/ws(?:\?|\/|$)/, (socket) => socket.close())

const target = () => page.getByRole('button', { name: '更多操作：产品需求与功能规划', exact: true })
const menu = () => page.getByRole('menu', { name: '更多操作：产品需求与功能规划', exact: true })
const activeText = () => page.evaluate(() => document.activeElement?.textContent?.trim())
async function frames(count = 2) {
  await page.evaluate(
    (count) =>
      new Promise((resolve) => {
        const step = () => (count-- > 0 ? requestAnimationFrame(step) : resolve())
        requestAnimationFrame(step)
      }),
    count,
  )
}
async function resetScroll() {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('*')) if (element.scrollTop) element.scrollTop = 0
    window.scrollTo(0, 0)
  })
  await frames()
}
async function assertMenu() {
  await menu().waitFor({ state: 'visible' })
  await frames()
  assert.equal(await menu().isVisible(), true, '刚打开的菜单被迟到 scroll 事件关闭')
  assert.equal(new URL(page.url()).hash, '#/?space=601', '点击菜单触发了内容行导航')
}
async function snapshot(name) {
  await page.screenshot({ path: path.join(out, `${name}.png`), animations: 'disabled' })
}
async function checkViewport(width, height) {
  await page.setViewportSize({ width, height })
  await resetScroll()
  await target().click()
  await assertMenu()
  pass(`${width}px：点击视口外末行菜单自动滚动后保持打开，未误开内容`)
  const bounds = await menu().boundingBox()
  const anchor = await target().boundingBox()
  assert.ok(
    bounds.x >= 7 &&
      bounds.y >= 7 &&
      bounds.x + bounds.width <= width - 7 &&
      bounds.y + bounds.height <= height - 7,
  )
  assert.ok(anchor.y + anchor.height + 6 + bounds.height > height - 8, '测试按钮应位于无法向下容纳菜单的位置')
  assert.ok(bounds.y + bounds.height <= anchor.y - 5, '底部菜单应完整翻转到按钮上方')
  pass(`${width}px：菜单底部翻转且保持8px视口边界`)
  await snapshot(`menu-${width}`)
  await page.keyboard.press('ArrowDown')
  assert.equal(await activeText(), '复制链接')
  await page.keyboard.press('End')
  assert.equal(await activeText(), '删除内容')
  await page.keyboard.press('ArrowDown')
  assert.equal(await activeText(), '打开内容')
  await page.keyboard.press('ArrowUp')
  assert.equal(await activeText(), '删除内容')
  await page.keyboard.press('Home')
  assert.equal(await activeText(), '打开内容')
  await page.keyboard.press('Escape')
  assert.equal(await menu().count(), 0)
  assert.equal(await target().evaluate((element) => element === document.activeElement), true)
  await page.keyboard.press('ArrowUp')
  await assertMenu()
  assert.equal(await activeText(), '删除内容')
  await page.keyboard.press('Escape')
  await page.keyboard.press('ArrowDown')
  await assertMenu()
  assert.equal(await activeText(), '打开内容')
  await page.keyboard.press('Tab')
  assert.equal(await menu().count(), 0)
  assert.equal(new URL(page.url()).hash, '#/?space=601')
  pass(`${width}px：上下键、Home/End循环、Escape焦点返回与键盘打开正常`)

  await target().click()
  await assertMenu()
  await menu().getByRole('menuitem', { name: '重命名', exact: true }).click()
  await page.getByRole('dialog', { name: '重命名内容' }).waitFor()
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(new URL(page.url()).hash, '#/?space=601')
  pass(`${width}px：鼠标菜单项打开重命名对话框，不触发内容行`)

  await target().click()
  await assertMenu()
  await page.mouse.click(8, 8)
  assert.equal(await menu().count(), 0)
  await target().click()
  await assertMenu()
  const rect = await target().boundingBox()
  await page.mouse.move(rect.x - 50, rect.y + 10)
  await page.mouse.wheel(0, -180)
  await menu().waitFor({ state: 'hidden' })
  pass(`${width}px：外部点击和真实外部滚动关闭菜单`)
}

async function checkNestedScroll() {
  await page.setViewportSize({ width: 1440, height: 960 })
  await resetScroll()
  await page.locator('.document-list').evaluate((element) => {
    element.style.maxHeight = '280px'
    element.style.overflowY = 'auto'
  })
  await target().click()
  await assertMenu()
  const rect = await target().boundingBox()
  await page.mouse.move(rect.x - 50, rect.y + 10)
  await page.mouse.wheel(0, -100)
  await menu().waitFor({ state: 'hidden' })
  pass('嵌套滚动容器：自动滚入后的迟到事件不误关，随后实际滚动会关闭')
  await page.locator('.document-list').evaluate((element) => element.removeAttribute('style'))
  await resetScroll()
  await target().click()
  await assertMenu()
  await menu().evaluate((element) => {
    element.style.maxHeight = '88px'
  })
  await page.keyboard.press('End')
  await frames()
  assert.equal(await activeText(), '删除内容')
  assert.equal(await menu().isVisible(), true)
  assert.ok(await menu().evaluate((element) => element.scrollTop > 0))
  pass('菜单内部滚动保持打开，键盘末项仍可见')
  await page.keyboard.press('Escape')
}

try {
  await page.goto(`${base}/#/?space=601`)
  await page.locator('.document-row').nth(6).waitFor()
  await checkViewport(1440, 960)
  await checkViewport(320, 700)
  await checkNestedScroll()
  assert.deepEqual(errors, [])
  await fs.writeFile(
    path.join(out, 'summary.json'),
    JSON.stringify({ status: 'passed', checks, errors, requests }, null, 2),
  )
} catch (error) {
  await snapshot('failure').catch(() => {})
  const events = await page.evaluate(() => window.__menuEvents).catch(() => [])
  await fs.writeFile(
    path.join(out, 'summary.json'),
    JSON.stringify({ status: 'failed', checks, errors, requests, events, error: String(error) }, null, 2),
  )
  throw error
} finally {
  await browser.close()
}
