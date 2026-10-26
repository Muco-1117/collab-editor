import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

// Real Vue UI, fully simulated API and websocket. No real database mutations.
const base = process.env.E2E_BASE_URL || 'http://localhost:5173'
const out = path.resolve(process.env.E2E_OUTPUT_DIR || 'artifacts/round2-20261022/board-viewport')
await fs.mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
page.setDefaultTimeout(10_000)
const checks = [],
  errors = [],
  operations = [],
  apiRequests = []
const pass = (label) => {
  checks.push(label)
  console.log('PASS', label)
}
page.on('pageerror', (error) => errors.push(error.message))
const user = { id: 99401, username: 'board_viewport_check', nickname: '白板视图检查', avatarUrl: '' }
const metadata = {
  doc_key: 'board-viewport-check',
  kind: 'board',
  title: '产品协作流程',
  space_id: 99401,
  space_name: '设计讨论空间',
  my_role: 'owner',
}
const elements = new Map()
let revision = 1,
  clock = 1,
  socket,
  role = 'owner',
  imageNumber = 0
const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfZkAAAAASUVORK5CYII=',
  'base64',
)
function snapshot(id, type, values, timestamp = 'seed:1', opId = 'seed') {
  return {
    id,
    type,
    rootClock: timestamp,
    fields: {
      ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, clock: timestamp }])),
      '#version': { value: opId, clock: timestamp },
    },
  }
}
elements.set(
  'note-a',
  snapshot('note-a', 'CARD', {
    x: 80,
    y: 70,
    w: 240,
    h: 160,
    z: 1,
    color: '#fff1a8',
    text: '整理核心需求\n• 多人协作\n• 内容可追溯',
  }),
)
elements.set(
  'note-b',
  snapshot('note-b', 'CARD', {
    x: 520,
    y: 310,
    w: 260,
    h: 180,
    z: 2,
    color: '#dcecff',
    text: '绘制协作流程\n讨论 → 编辑 → 评审',
  }),
)
function values(id) {
  return Object.fromEntries(
    Object.entries(elements.get(id).fields)
      .filter(([key]) => key !== '#version')
      .map(([key, field]) => [key, field.value]),
  )
}
function remote(id, type, changes) {
  const op = {
    type: 'STATE',
    elementId: id,
    elementType: type,
    value: { ...(elements.has(id) ? values(id) : {}), ...changes },
    clock: `viewport-remote:${++clock}`,
    opId: `remote-${clock}`,
  }
  elements.set(id, snapshot(id, type, op.value, op.clock, op.opId))
  socket.send(JSON.stringify({ type: 'applied', rev: ++revision, op }))
}
async function waitUntil(check) {
  const end = Date.now() + 6000
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Condition not met')
}
async function settle() {
  await page.waitForTimeout(100)
}
async function action(action, count = 1) {
  const before = operations.length
  await action()
  if (count) await waitUntil(() => operations.length >= before + count)
  await settle()
  const sent = operations.slice(before)
  assert.equal(sent.length, count)
  return sent
}
async function zoomTo(percent) {
  await page.getByRole('combobox', { name: '白板缩放', exact: true }).selectOption(String(percent))
  await page.waitForFunction(
    (scale) =>
      Math.abs(new DOMMatrix(getComputedStyle(document.querySelector('.board-canvas')).transform).a - scale) <
      0.001,
    percent / 100,
  )
  await settle()
}
async function viewPoint(x, y) {
  return page.evaluate(
    ({ x, y }) => {
      const canvas = document.querySelector('.board-canvas').getBoundingClientRect()
      const zoom = new DOMMatrix(getComputedStyle(document.querySelector('.board-canvas')).transform).a
      return { x: (x - canvas.left) / zoom, y: (y - canvas.top) / zoom }
    },
    { x, y },
  )
}
async function centreWorld() {
  const box = await page.locator('.board-scroll').boundingBox()
  return viewPoint(box.x + box.width / 2, box.y + box.height / 2)
}
async function dragCard(id, dx, dy, resize = false) {
  const card = page.locator(`[data-card-id="${id}"]`)
  const handle = resize
    ? card.getByRole('button', { name: '调整卡片大小', exact: true })
    : card.locator('.board-card-top')
  await handle.scrollIntoViewIfNeeded()
  const box = await handle.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 4 })
  await page.mouse.up()
}
async function beginCardDrag(id, dx = 65, dy = 35) {
  const handle = page.locator(`[data-card-id="${id}"] .board-card-top`)
  await handle.scrollIntoViewIfNeeded()
  const box = await handle.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 4 })
  await page.locator(`[data-card-id="${id}"].dragging`).waitFor()
}

async function scrollPosition() {
  return page
    .locator('.board-scroll')
    .evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop }))
}

async function blankPoint() {
  return page.locator('.board-scroll').evaluate((element) => {
    const box = element.getBoundingClientRect()
    for (let y = box.top + 80; y < box.bottom - 80; y += 70) {
      for (let x = box.left + 90; x < box.right - 90; x += 80) {
        const target = document.elementFromPoint(x, y)
        if (target && element.contains(target) && !target.closest('.board-card, button, input, select, a'))
          return { x, y }
      }
    }
    throw new Error('No blank point within board viewport')
  })
}

async function touchDrag(client, x, y, dx, dy) {
  const point = (x, y) => ({ x, y, radiusX: 3, radiusY: 3, force: 1, id: 1 })
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(x, y)] })
  for (let step = 1; step <= 6; step++) {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [point(x + (dx * step) / 6, y + (dy * step) / 6)],
    })
    await page.waitForTimeout(24)
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await settle()
}
async function layoutSettled() {
  await page.evaluate(async () =>
    Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))),
  )
}

await page.addInitScript(() => localStorage.setItem('collab_access_token', 'board-viewport-mock'))
await page.route('**/api/**', async (route) => {
  const request = route.request(),
    url = new URL(request.url())
  apiRequests.push(`${request.method()} ${url.pathname}`)
  let result
  if (url.pathname === '/api/auth/me') result = user
  else if (url.pathname === '/api/docs') result = [metadata]
  else if (url.pathname === '/api/docs/board-viewport-check') result = metadata
  else if (url.pathname.startsWith('/api/assets/'))
    return route.fulfill({ status: 200, contentType: 'image/png', body: tinyPng })
  else if (url.pathname.endsWith('/images')) {
    imageNumber++
    result = {
      assetId: `viewport-image-${imageNumber}`,
      name: '流程草图.png',
      width: 400,
      height: 260,
      url: `/api/assets/viewport-image-${imageNumber}`,
    }
  } else throw new Error(`Unexpected mock route ${url.pathname}`)
  await route.fulfill({ json: result })
})
await page.routeWebSocket(/\/ws(?:\?|\/|$)/, (ws) => {
  socket = ws
  ws.onMessage((raw) => {
    const message = JSON.parse(String(raw))
    if (message.type === 'hello')
      ws.send(
        JSON.stringify({
          type: 'welcome',
          rev: revision,
          role,
          canWrite: role === 'owner',
          snapshot: [...elements.values()],
        }),
      )
    if (message.type === 'op') {
      operations.push(message.op)
      clock = Math.max(clock, Number(message.op.clock.split(':').at(-1)))
      elements.set(
        message.op.elementId,
        snapshot(
          message.op.elementId,
          message.op.elementType,
          message.op.value,
          message.op.clock,
          message.op.opId,
        ),
      )
      ws.send(JSON.stringify({ type: 'applied', rev: ++revision, op: message.op }))
    }
    if (message.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }))
  })
})

try {
  await page.goto(`${base}/#/work/board/board-viewport-check`)
  await page.locator('[data-card-id="note-a"] textarea').waitFor()
  await page.getByRole('button', { name: '添加卡片', exact: true }).waitFor()
  await settle()
  assert.equal(await page.getByRole('combobox', { name: '白板缩放', exact: true }).inputValue(), '100')
  assert.equal(await page.locator('.board-scroll').evaluate((element) => element.scrollLeft), 0)
  assert.equal(await page.locator('.board-scroll').evaluate((element) => element.scrollTop), 0)
  const beforeCentre = await centreWorld()
  await action(async () => {
    await zoomTo(50)
    await zoomTo(150)
    await zoomTo(100)
  }, 0)
  const afterCentre = await centreWorld()
  assert.ok(Math.abs(beforeCentre.x - afterCentre.x) <= 2 && Math.abs(beforeCentre.y - afterCentre.y) <= 2)
  pass('默认100%保持原始位置，缩放往返锚定视口中心，仅改变本地视图')

  for (const percent of [50, 150, 200]) {
    await zoomTo(percent)
    const start = values('note-a')
    const dx = (40 * percent) / 100,
      dy = (20 * percent) / 100
    const [moved] = await action(() => dragCard('note-a', dx, dy))
    assert.equal(moved.value.x, start.x + 40)
    assert.equal(moved.value.y, start.y + 20)
    assert.equal(moved.value.text, start.text)
    const [resized] = await action(() => dragCard('note-a', (30 * percent) / 100, (25 * percent) / 100, true))
    assert.equal(resized.value.w, start.w + 30)
    assert.equal(resized.value.h, start.h + 25)
    assert.equal(resized.value.x, start.x + 40)
  }
  pass('50%、150%、200%下拖动和缩放按正确世界坐标提交，保持完整业务字段且每次仅一个STATE')

  await zoomTo(50)
  const scrollBox = await page.locator('.board-scroll').boundingBox()
  const point = { x: scrollBox.x + scrollBox.width - 100, y: scrollBox.y + scrollBox.height - 100 }
  const expectedPoint = await viewPoint(point.x, point.y)
  const [created] = await action(() => page.mouse.dblclick(point.x, point.y))
  assert.equal(created.value.x, Math.max(0, Math.round(expectedPoint.x)))
  assert.equal(created.value.y, Math.max(0, Math.round(expectedPoint.y)))
  const imagePoint = await viewPoint(scrollBox.x + 56, scrollBox.y + 56)
  const [image] = await action(() =>
    page
      .locator('.board-tools input[type="file"][aria-label="插入图片"]')
      .setInputFiles({ name: 'sketch.png', mimeType: 'image/png', buffer: tinyPng }),
  )
  assert.equal(image.value.x, Math.max(0, Math.round(imagePoint.x)))
  assert.equal(image.value.y, Math.max(0, Math.round(imagePoint.y)))
  pass('缩放后双击与插入图片使用逆坐标，创建位置和点击／当前视口一致')

  await page.locator('.board-scroll').evaluate((element) => {
    element.scrollLeft += 280
    element.scrollTop += 220
  })
  const panStart = await page
    .locator('.board-scroll')
    .evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop }))
  await page.getByRole('region', { name: '白板画布', exact: true }).focus()
  await page.keyboard.down('Space')
  const panPoint = { x: scrollBox.x + 200, y: scrollBox.y + 100 }
  await action(async () => {
    await page.mouse.move(panPoint.x, panPoint.y)
    await page.mouse.down()
    await page.mouse.move(panPoint.x + 70, panPoint.y + 45, { steps: 4 })
    await page.mouse.up()
    await page.keyboard.up('Space')
  }, 0)
  const panEnd = await page
    .locator('.board-scroll')
    .evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop }))
  assert.ok(Math.abs(panEnd.left - (panStart.left - 70)) <= 1)
  assert.ok(Math.abs(panEnd.top - (panStart.top - 45)) <= 1)
  await action(async () => {
    await page.mouse.move(panPoint.x, panPoint.y)
    await page.mouse.down({ button: 'middle' })
    await page.mouse.move(panPoint.x - 50, panPoint.y - 30, { steps: 3 })
    await page.mouse.up({ button: 'middle' })
  }, 0)
  assert.ok(await page.locator('.board-scroll').evaluate((element) => !element.classList.contains('panning')))
  pass('空格加拖动及鼠标中键可靠平移，结束后清理手势状态且不发送编辑操作')

  for (const cancel of ['Escape', 'blur', 'pointercancel']) {
    const cancelPoint = await blankPoint()
    await action(async () => {
      await page.mouse.move(cancelPoint.x, cancelPoint.y)
      await page.mouse.down({ button: 'middle' })
      await page.mouse.move(cancelPoint.x - 35, cancelPoint.y - 20, { steps: 3 })
      await page.locator('.board-scroll.panning').waitFor()
      if (cancel === 'Escape') await page.keyboard.press('Escape')
      else if (cancel === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')))
      else
        await page.locator('.board-scroll').evaluate((element) => {
          element.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true }))
        })
      const stopped = await scrollPosition()
      await page.mouse.move(cancelPoint.x - 70, cancelPoint.y - 40, { steps: 3 })
      await page.mouse.up({ button: 'middle' })
      assert.deepEqual(await scrollPosition(), stopped)
      assert.equal(await page.locator('.board-scroll.panning').count(), 0)
      assert.equal(
        await page.locator('.board-scroll').evaluate((element) => element.hasPointerCapture(1)),
        false,
      )
    }, 0)
  }
  pass('平移中Esc、窗口失焦及pointercancel均立即结束手势，释放捕获且不残留滚动')

  await zoomTo(150)
  const cancelledCard = { ...values('note-a') }
  await action(async () => {
    await beginCardDrag('note-a')
    await page.locator('.board-scroll').dispatchEvent('wheel', { ctrlKey: true, deltaY: 180 })
    await page.locator('[data-card-id="note-a"].dragging').waitFor({ state: 'detached' })
    await page.mouse.up()
  }, 0)
  assert.deepEqual(values('note-a'), cancelledCard)
  await zoomTo(50)
  await action(async () => {
    await beginCardDrag('note-a')
    remote('note-a', 'CARD', { text: '伙伴补充的内容应保留', color: '#dff4e4' })
    await page.waitForFunction(
      () => document.querySelector('[data-card-id="note-a"] textarea').value === '伙伴补充的内容应保留',
    )
    await page.keyboard.press('Escape')
    await page.mouse.up()
  }, 0)
  assert.equal(values('note-a').text, '伙伴补充的内容应保留')
  assert.equal(values('note-a').x, cancelledCard.x)
  assert.equal(values('note-a').y, cancelledCard.y)
  pass('缩放或Esc取消正在拖动的卡片，不提交草稿且保留同期远端文字与颜色')

  const anchor = { x: scrollBox.x + 350, y: scrollBox.y + 260 }
  const anchorBefore = await viewPoint(anchor.x, anchor.y)
  await action(async () => {
    await page.mouse.move(anchor.x, anchor.y)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -180)
    await page.keyboard.up('Control')
    await settle()
  }, 0)
  const anchorAfter = await viewPoint(anchor.x, anchor.y)
  assert.ok(Math.abs(anchorBefore.x - anchorAfter.x) < 3 && Math.abs(anchorBefore.y - anchorAfter.y) < 3)
  pass('Ctrl加滚轮以鼠标位置缩放，所指内容不跳走')

  remote('far-note', 'CARD', {
    x: 2400,
    y: 1400,
    w: 300,
    h: 210,
    z: 8,
    color: '#dff4e4',
    text: '验证上线\n确认每个成员都能参与',
  })
  await page.locator('[data-card-id="far-note"]').waitFor()
  await action(() => page.getByRole('button', { name: '适应全部内容', exact: true }).click(), 0)
  const viewportBox = await page.locator('.board-scroll').boundingBox()
  for (const card of await page.locator('.board-card').all()) {
    const box = await card.boundingBox()
    assert.ok(box.x >= viewportBox.x - 2 && box.y >= viewportBox.y - 2)
    assert.ok(box.x + box.width <= viewportBox.x + viewportBox.width + 2)
    assert.ok(box.y + box.height <= viewportBox.y + viewportBox.height + 2)
  }
  await page.screenshot({ path: path.join(out, 'board-fit-desktop.png'), fullPage: true })
  pass('大白板随内容扩展，适应内容可将远处卡片和图片一起放入可见范围')

  await zoomTo(100)
  const text = page.locator('[data-card-id="note-b"] textarea')
  await text.scrollIntoViewIfNeeded()
  await text.focus()
  const beforeSpace = await text.inputValue()
  await action(() => text.press('Space'))
  assert.notEqual(await text.inputValue(), beforeSpace)
  assert.equal(
    await page.locator('.board-scroll').evaluate((element) => element.classList.contains('pan-mode')),
    false,
  )
  pass('文本输入空格正常写入，不抢占文字编辑或开启平移')

  role = 'viewer'
  socket.send(JSON.stringify({ type: 'access', role, canWrite: false, message: '只读成员' }))
  await page.getByRole('button', { name: '添加卡片', exact: true }).waitFor({ state: 'detached' })
  const beforeViewer = operations.length
  await page.getByRole('button', { name: '平移白板', exact: true }).click()
  await page.mouse.move(scrollBox.x + 170, scrollBox.y + 150)
  await page.mouse.down()
  await page.mouse.move(scrollBox.x + 110, scrollBox.y + 110, { steps: 3 })
  await page.mouse.up()
  await zoomTo(25)
  await page.getByRole('button', { name: '适应全部内容', exact: true }).click()
  await settle()
  assert.equal(operations.length, beforeViewer)
  assert.equal(await text.isEditable(), false)
  pass('只读成员可缩放、适应和平移，始终不会产生写操作')

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    await layoutSettled()
    await page.getByRole('button', { name: '适应全部内容', exact: true }).click()
    await settle()
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    const controls = await page.getByRole('group', { name: '白板视图', exact: true }).boundingBox()
    const board = await page.locator('.board-scroll').boundingBox()
    assert.ok(controls.x >= 0 && controls.x + controls.width <= width + 1)
    assert.ok(
      controls.y >= board.y + board.height - 1,
      'Navigation controls reserve their own space below the canvas',
    )
    await page.screenshot({ path: path.join(out, `board-fit-${width}.png`), fullPage: true })
  }
  pass('390px和320px视图工具完整可点，画布保留独立滚动、没有页面溢出或按钮遮挡内容')

  const client = await page.context().newCDPSession(page)
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  await zoomTo(100)
  await page.locator('.board-scroll').evaluate((element) => element.scrollTo(1100, 760))
  const touchBox = await page.locator('.board-scroll').boundingBox()
  const touchStart = await scrollPosition()
  await action(() => touchDrag(client, touchBox.x + 170, touchBox.y + 170, -70, -65), 0)
  const touchEnd = await scrollPosition()
  assert.ok(Math.abs(touchEnd.left - touchStart.left - 70) <= 2)
  assert.ok(Math.abs(touchEnd.top - touchStart.top - 65) <= 2)
  assert.equal(await page.locator('.board-scroll.panning').count(), 0)
  await page.getByRole('button', { name: '平移白板', exact: true }).click()
  await settle()
  const nativeStart = await scrollPosition()
  await action(() => touchDrag(client, touchBox.x + 170, touchBox.y + 170, -70, -100), 0)
  const nativeEnd = await scrollPosition()
  assert.ok(nativeEnd.top > nativeStart.top + 40)
  assert.equal(await page.locator('.board-scroll.pan-mode').count(), 0)
  await client.detach()
  pass('触屏平移模式按手指位移浏览，关闭后空白画布恢复原生滑动，全程不发写操作')

  assert.deepEqual(errors, [])
  assert.ok(
    apiRequests.every(
      (request) => request.startsWith('GET ') || request === 'POST /api/docs/board-viewport-check/images',
    ),
  )
  await fs.writeFile(
    path.join(out, 'summary.json'),
    JSON.stringify(
      { status: 'passed', checks, errors, operationCount: operations.length, apiRequests },
      null,
      2,
    ),
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
