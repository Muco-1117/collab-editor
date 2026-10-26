import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

// Every API request is fulfilled by this test; no real user data is modified.
const base = process.env.E2E_BASE_URL || 'http://localhost:5173'
const out = path.resolve(process.env.E2E_OUTPUT_DIR || 'artifacts/ui-readiness-20261022')
await fs.mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
const page = await context.newPage()
page.setDefaultTimeout(10_000)
const checks = []
const errors = []
const requests = []
const pass = (label) => {
  checks.push(label)
  console.log('PASS', label)
}
page.on('pageerror', (error) => errors.push(error.message))
const user = { id: 99301, username: 'readiness_check', nickname: '操作验证', avatarUrl: '' }
const documents = [
  {
    doc_key: 'readiness-target',
    title: '真实目标文档',
    kind: 'doc',
    my_role: 'owner',
    space_id: 99301,
    space_name: '操作验证空间',
  },
  {
    doc_key: 'readiness-other',
    title: '另一张白板',
    kind: 'board',
    my_role: 'owner',
    space_id: 99301,
    space_name: '操作验证空间',
  },
]
let renameFail = false
let deleteFail = false
let mutationRelease = null
let holdMutation = false
let deleteCount = 0
let renameCount = 0
const waitUntil = async (check) => {
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Condition not met')
}

await context.addInitScript(() => {
  localStorage.setItem('collab_access_token', 'readiness-mock')
  window.__clipboardMode = 'deny'
  window.__clipboardAttempts = []
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (value) => {
        window.__clipboardAttempts.push(value)
        if (window.__clipboardMode === 'deny') throw new DOMException('Clipboard denied', 'NotAllowedError')
      },
    },
  })
})
await context.route('**/api/**', async (route) => {
  const request = route.request()
  const pathname = new URL(request.url()).pathname
  const method = request.method()
  requests.push(`${method} ${pathname}`)
  if (pathname === '/api/auth/me') return route.fulfill({ json: { user } })
  if (pathname === '/api/spaces')
    return route.fulfill({
      json: [
        { id: 99301, name: '操作验证空间', my_role: 'owner', doc_count: documents.length, member_count: 1 },
      ],
    })
  if (pathname.endsWith('/members')) return route.fulfill({ json: { members: [{ ...user, role: 'owner' }] } })
  if (pathname === '/api/stats')
    return route.fulfill({
      json: {
        spaces: 1,
        documents: documents.length,
        operations: 0,
        byApplication: [],
        byOperation: [],
        recentActivity: [],
        contributors: [],
      },
    })
  if (pathname === '/api/docs') return route.fulfill({ json: documents })
  const doc = documents.find((item) => pathname === `/api/docs/${item.doc_key}`)
  if (doc && method === 'PUT') {
    renameCount += 1
    if (holdMutation)
      await new Promise((resolve) => {
        mutationRelease = resolve
      })
    mutationRelease = null
    if (renameFail) return route.fulfill({ status: 503, json: { msg: '标题未保存，请稍后重试' } })
    doc.title = request.postDataJSON().title
    return route.fulfill({ json: { docKey: doc.doc_key, title: doc.title } })
  }
  if (doc && method === 'DELETE') {
    deleteCount += 1
    if (holdMutation)
      await new Promise((resolve) => {
        mutationRelease = resolve
      })
    mutationRelease = null
    if (deleteFail) return route.fulfill({ status: 503, json: { msg: '删除暂时失败，请重试' } })
    documents.splice(documents.indexOf(doc), 1)
    return route.fulfill({ json: { deleted: true } })
  }
  if (doc) return route.fulfill({ json: doc })
  throw new Error(`Unexpected API request ${method} ${pathname}`)
})

async function menu(title, action) {
  await page.getByRole('button', { name: `更多操作：${title}`, exact: true }).click()
  await page.getByRole('menuitem', { name: action, exact: true }).click()
}

async function clearToasts() {
  await page.evaluate(async () => {
    const moduleUrl = performance
      .getEntriesByType('resource')
      .find((entry) => new URL(entry.name).pathname === '/src/stores/toast.js')?.name
    const store = await import(moduleUrl || '/src/stores/toast.js')
    for (const toast of [...store.toasts]) store.dismiss(toast.id)
  })
}

async function pushToasts(items) {
  return page.evaluate(async (items) => {
    const moduleUrl = performance
      .getEntriesByType('resource')
      .find((entry) => new URL(entry.name).pathname === '/src/stores/toast.js')?.name
    const store = await import(moduleUrl || '/src/stores/toast.js')
    return items.map((item) => store.notify(item.message, item.type, item.duration))
  }, items)
}

try {
  await page.goto(`${base}/#/`)
  await page.getByRole('heading', { level: 1, name: '操作验证空间', exact: true }).waitFor()
  await menu('真实目标文档', '复制链接')
  let dialog = page.getByRole('dialog', { name: '复制内容链接', exact: true })
  const link = dialog.getByRole('textbox', { name: '内容链接', exact: true })
  await link.waitFor()
  const expected = `${base}/#/work/doc/readiness-target`
  assert.equal(await link.inputValue(), expected)
  assert.ok(!page.url().includes('/work/'))
  assert.equal(
    await link.evaluate((element) => element.selectionEnd - element.selectionStart),
    expected.length,
  )
  await dialog.getByRole('button', { name: '选中链接', exact: true }).click()
  assert.equal(await link.evaluate((element) => document.activeElement === element), true)
  await page.evaluate(() => {
    window.__clipboardMode = 'allow'
  })
  await dialog.getByRole('button', { name: '重新复制', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  assert.deepEqual(await page.evaluate(() => window.__clipboardAttempts), [expected, expected])
  pass('首页复制被浏览器拒绝后显示目标内容链接并全选，可手动复制或重试剪贴板')

  await clearToasts()
  await menu('真实目标文档', '重命名')
  dialog = page.getByRole('dialog', { name: '重命名内容', exact: true })
  const title = dialog.getByRole('textbox', { name: '标题', exact: true })
  const save = dialog.getByRole('button', { name: '保存', exact: true })
  assert.equal(await save.isDisabled(), true)
  await title.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    element.value = '中文组合名称'
    element.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: '中文组合名称' }))
    element.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', isComposing: true, cancelable: true }),
    )
    element.form.requestSubmit()
  })
  assert.equal(renameCount, 0)
  assert.equal(await dialog.isVisible(), true)
  await title.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文组合名称' }))
    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: '中文组合名称' }))
  })
  await title.fill('第一次修改')
  renameFail = true
  holdMutation = true
  await save.click()
  await waitUntil(() => mutationRelease)
  assert.equal(renameCount, 1)
  assert.equal(await title.isDisabled(), true)
  assert.equal(await dialog.getByRole('button', { name: '关闭', exact: true }).isDisabled(), true)
  assert.equal(await dialog.getByRole('button', { name: '取消', exact: true }).isDisabled(), true)
  await page.keyboard.press('Escape')
  await dialog.locator('form').evaluate((element) => {
    element.requestSubmit()
    element.requestSubmit()
  })
  await page.getByRole('link', { name: '进入个人主页', exact: true }).evaluate((element) => element.click())
  await page.waitForTimeout(150)
  assert.ok(!page.url().includes('/profile'))
  assert.equal(await dialog.isVisible(), true)
  assert.equal(renameCount, 1)
  mutationRelease()
  holdMutation = false
  await dialog.getByRole('alert').waitFor()
  assert.equal(await dialog.getByRole('alert').textContent(), '标题未保存，请稍后重试')
  assert.equal(await title.inputValue(), '第一次修改')
  assert.equal(await page.locator('.toast-error').count(), 0)
  await title.fill('修正后名称')
  renameFail = false
  await title.press('Enter')
  await dialog.waitFor({ state: 'detached' })
  await page.getByRole('button', { name: '更多操作：修正后名称', exact: true }).waitFor()
  assert.equal(documents.find((doc) => doc.doc_key === 'readiness-target').title, '修正后名称')
  assert.equal(renameCount, 2)
  pass('未改名不能重复保存，中文组合 Enter 不提交；慢请求防重复/关闭/导航，失败内联提示且可修正重试')

  await clearToasts()
  await menu('修正后名称', '删除内容')
  dialog = page.getByRole('dialog', { name: '删除内容', exact: true })
  deleteFail = true
  holdMutation = true
  await dialog.getByRole('button', { name: '删除', exact: true }).click()
  await waitUntil(() => mutationRelease)
  await page.keyboard.press('Escape')
  assert.equal(await dialog.isVisible(), true)
  assert.equal(await dialog.getByRole('button', { name: '关闭', exact: true }).isDisabled(), true)
  mutationRelease()
  holdMutation = false
  await dialog.getByRole('alert').waitFor()
  assert.equal(await dialog.getByRole('alert').textContent(), '删除暂时失败，请重试')
  assert.equal(await page.getByRole('button', { name: '更多操作：修正后名称', exact: true }).count(), 1)
  deleteFail = false
  await dialog.getByRole('button', { name: '删除', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  await page.getByRole('button', { name: '更多操作：修正后名称', exact: true }).waitFor({ state: 'detached' })
  assert.equal(deleteCount, 2)
  assert.equal(documents.length, 1)
  pass('删除请求失败保留确认框和原内容，显示明确内联错误，重试后只移除对应目标')

  await clearToasts()
  const duplicateIds = await pushToasts(
    Array.from({ length: 12 }, () => ({ message: '同一错误，点击重试', type: 'error', duration: 1200 })),
  )
  assert.equal(new Set(duplicateIds).size, 1)
  assert.equal(await page.locator('.toast').count(), 1)
  await pushToasts(
    Array.from({ length: 8 }, (_, index) => ({ message: `不同提示 ${index}`, type: 'info', duration: 1200 })),
  )
  assert.equal(await page.locator('.toast').count(), 3)
  assert.deepEqual(await page.locator('.toast > span').allTextContents(), [
    '不同提示 5',
    '不同提示 6',
    '不同提示 7',
  ])
  const closeButtons = page.getByRole('button', { name: '关闭提示', exact: true })
  await closeButtons.first().focus()
  await closeButtons.first().press('Enter')
  assert.equal(await page.locator('.toast').count(), 2)
  assert.equal(await closeButtons.first().evaluate((element) => document.activeElement === element), true)
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.toast').count(), 1)
  pass('相同提示合并，提示最多三条；键盘 Enter/Escape 可关闭并把焦点交给下一条')

  await clearToasts()
  await pushToasts([{ message: '悬停阅读不会自动消失', type: 'info', duration: 500 }])
  const toast = page.locator('.toast').first()
  await toast.hover()
  await page.waitForTimeout(750)
  assert.equal(await toast.count(), 1)
  await toast.getByRole('button', { name: '关闭提示', exact: true }).focus()
  await page.mouse.move(5, 5)
  await page.waitForTimeout(750)
  assert.equal(await toast.count(), 1)
  await page.getByRole('combobox', { name: '搜索当前可见内容' }).focus()
  await toast.waitFor({ state: 'detached' })
  pass('提示悬停与键盘焦点分别暂停计时，两者都移开后才继续自动关闭')

  await page.setViewportSize({ width: 320, height: 844 })
  await page.evaluate(() => {
    window.__clipboardMode = 'deny'
  })
  await menu('另一张白板', '复制链接')
  dialog = page.getByRole('dialog', { name: '复制内容链接', exact: true })
  assert.equal(
    await dialog.getByRole('textbox', { name: '内容链接', exact: true }).inputValue(),
    `${base}/#/work/board/readiness-other`,
  )
  await page.screenshot({ path: path.join(out, 'clipboard-mobile-320.png'), fullPage: true })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await pushToasts([
    { message: '错误详情：' + 'VeryLongUnbrokenServiceResponse'.repeat(8), type: 'error', duration: 8000 },
  ])
  await page.screenshot({ path: path.join(out, 'toast-mobile-320.png'), fullPage: true })
  assert.ok(
    await page.locator('.toast').evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  )
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
  pass('320px 复制链接弹窗和长错误提示正常换行，没有横向溢出')

  await page.setViewportSize({ width: 1440, height: 960 })
  await clearToasts()
  await page.evaluate(async () => {
    const resources = performance.getEntriesByType('resource').map((entry) => entry.name)
    const moduleFor = (pathname) => resources.find((name) => new URL(name).pathname === pathname) || pathname
    const vue = await import(moduleFor('/node_modules/.vite/deps/vue.js'))
    const routing = await import(moduleFor('/node_modules/.vite/deps/vue-router.js'))
    const { default: DocumentActions } = await import(moduleFor('/src/components/DocumentActions.vue'))
    const item = vue.shallowRef({
      doc_key: 'readiness-other',
      title: '旧目标',
      kind: 'board',
      my_role: 'owner',
    })
    const events = []
    const host = document.createElement('div')
    host.id = 'action-harness'
    host.style.cssText = 'position:fixed;top:100px;left:20px;z-index:1300;background:white;padding:8px'
    document.body.appendChild(host)
    const route = {
      path: '/',
      component: {
        render: () =>
          vue.h(DocumentActions, {
            document: item.value,
            onRenamed: (value) => events.push(['renamed', value]),
            onDeleted: (value) => events.push(['deleted', value]),
          }),
      },
    }
    const router = routing.createRouter({ history: routing.createMemoryHistory(), routes: [route] })
    const app = vue.createApp({ render: () => vue.h(routing.RouterView) })
    app.use(router)
    await router.push('/')
    await router.isReady()
    app.mount(host)
    window.__actionHarness = {
      events,
      replace: () => {
        item.value = { doc_key: 'readiness-prop-replaced', title: '新目标', kind: 'doc', my_role: 'owner' }
      },
      close: () => {
        app.unmount()
        host.remove()
      },
    }
  })
  await page.locator('#action-harness').getByRole('button', { name: '更多操作：旧目标', exact: true }).click()
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '重命名内容', exact: true })
  await dialog.getByRole('textbox', { name: '标题', exact: true }).fill('迟到的旧目标名称')
  holdMutation = true
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await waitUntil(() => mutationRelease)
  await page.evaluate(() => window.__actionHarness.replace())
  await dialog.waitFor({ state: 'detached' })
  mutationRelease()
  holdMutation = false
  await page.waitForTimeout(150)
  assert.deepEqual(await page.evaluate(() => window.__actionHarness.events), [])
  await page
    .locator('#action-harness')
    .getByRole('button', { name: '更多操作：新目标', exact: true })
    .waitFor()
  assert.equal(await page.locator('.toast-success').count(), 0)
  await page.evaluate(() => window.__actionHarness.close())
  pass('同一组件在请求中切换内容目标时取消旧操作展示，迟到响应不向新目标发送改名事件')

  await menu('另一张白板', '重命名')
  dialog = page.getByRole('dialog', { name: '重命名内容', exact: true })
  await dialog.getByRole('textbox', { name: '标题', exact: true }).fill('保存时登录失效')
  holdMutation = true
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await waitUntil(() => mutationRelease)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('collab:unauthorized')))
  await page.waitForURL((url) => url.hash.startsWith('#/login'))
  await dialog.waitFor({ state: 'detached' })
  mutationRelease()
  holdMutation = false
  await page.waitForTimeout(150)
  assert.equal(await page.locator('.toast-success').count(), 0)
  pass('保存期间登录失效仍能跳转登录，卸载后的迟到响应不弹成功提示或修改其他目标')

  assert.deepEqual(errors, [])
  pass('浏览器没有脚本错误，所有请求均模拟且未触碰真实用户数据')
  await fs.writeFile(
    path.join(out, 'summary.json'),
    JSON.stringify({ status: 'passed', checks, errors, requests }, null, 2),
  )
} catch (error) {
  mutationRelease?.()
  await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true })
  await fs.writeFile(
    path.join(out, 'summary.json'),
    JSON.stringify({ status: 'failed', checks, errors, error: String(error) }, null, 2),
  )
  throw error
} finally {
  await browser.close()
}
