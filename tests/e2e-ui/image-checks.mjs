import fs from 'node:fs/promises'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'

function unzip(bytes) {
  const files = new Map()
  for (let offset = 0; offset < bytes.length - 46; offset++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) continue
    const method = bytes.readUInt16LE(offset + 10), size = bytes.readUInt32LE(offset + 20)
    const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32)
    const local = bytes.readUInt32LE(offset + 42)
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
    const data = bytes.subarray(start, start + size)
    files.set(name, method === 8 ? inflateRawSync(data) : data)
    offset += 45 + nameLength + extra + comment
  }
  return files
}

export async function imageChecks({ pages, resources, step, gotoWorkspace, waitSynced, eventually, screenshot, pageApi, assert, artifactDir, assertConverged }) {
  const { owner: a, editor: b, viewer: c } = pages
  const fixture = Buffer.from(await a.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 80
    const context = canvas.getContext('2d'); context.fillStyle = '#236449'; context.fillRect(0, 0, 120, 80)
    context.fillStyle = '#ffffff'; context.fillRect(20, 20, 40, 30)
    return canvas.toDataURL('image/png').split(',')[1]
  }), 'base64')
  const file = (name) => ({ name, mimeType: 'image/png', buffer: fixture })
  const imageReady = async (page, selector, count = 1) => eventually('图片显示完成', () => page.locator(`${selector} img`).evaluateAll(images => images.filter(image => image.complete && image.naturalWidth > 0).length), n => n === count)
  const snapshot = async (page, key) => {
    const history = await pageApi(page, `/api/docs/${key}/history`)
    const replay = await pageApi(page, `/api/docs/${key}/replay?rev=${history.body.rev}`)
    return { rev: history.body.rev, elements: replay.body.elements }
  }
  const upload = (page, label, name) => page.getByLabel(label, { exact: true }).setInputFiles(file(name))
  const download = async (page, format, kind) => {
    await waitSynced(page)
    await page.getByLabel('导出格式', { exact: true }).selectOption(format)
    const [result] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '导出', exact: true }).click()])
    const output = path.join(artifactDir, `image-${kind}.${format}`)
    await result.saveAs(output)
    return fs.readFile(output)
  }
  let docAsset, originalRevision
  await step('文档图片上传、三端元数据收敛、替换和顺序同步', async () => {
    for (const page of [a,b,c]) await gotoWorkspace(page, 'doc', resources.docKeys.doc)
    await upload(a, '插入图片', 'document-original.png')
    for (const page of [a,b,c]) await imageReady(page, '.document-image')
    const original = await snapshot(a, resources.docKeys.doc)
    originalRevision = original.rev
    docAsset = original.elements.find(el => el.type === 'IMAGE')
    await upload(b, '替换图片', 'document-replaced.png')
    await eventually('图片替换同步到所有者', () => a.locator('.document-image figcaption').textContent(), text => text === 'document-replaced.png')
    await eventually('图片替换同步到只读者', () => c.locator('.document-image figcaption').textContent(), text => text === 'document-replaced.png')
    await a.locator('.paragraph-row').filter({ has: a.locator('.document-image') }).getByRole('button', { name: '段落上移', exact: true }).click()
    await eventually('图片顺序三端一致', async () => Promise.all([a,b,c].map(page => page.locator('.paragraph-row').evaluateAll(rows => rows.map(row => Boolean(row.querySelector('figure')))))), orders => JSON.stringify(orders[0]) === JSON.stringify(orders[1]) && JSON.stringify(orders[0]) === JSON.stringify(orders[2]) && orders[0][1] === true)
    await assertConverged(['owner','editor','viewer'])
    await screenshot(a, '13-document-image-sync')
    return { originalRevision, assetId: docAsset.fields.assetId.value, binaryBytes: fixture.length }
  })
  await step('文档 Word、HTML、Markdown、纯文本下载完整性', async () => {
    const outputs = {}
    for (const format of ['docx','html','md','txt']) {
      const bytes = await download(a, format, 'doc'); outputs[format] = bytes.length
      if (format === 'docx') {
        const files = unzip(bytes)
        assert(files.has('word/media/image1.png'), 'Word 缺少图片二进制')
        assert(files.get('word/document.xml').toString().includes('document-replaced.png'), 'Word 缺少图片名称')
      } else {
        const text = bytes.toString('utf8')
        assert(text.includes('document-replaced.png'), `${format} 缺少图片名称`)
        assert(text.includes(resources.titles.doc), `${format} 缺少标题`)
        if (format !== 'txt') assert(text.includes('data:image/png;base64,'), `${format} 缺少内嵌图片`)
      }
    }
    return outputs
  })
  await step('图片删除与历史恢复、只读权限和导出类型限制', async () => {
    await b.getByRole('button', { name: '删除图片', exact: true }).click()
    await eventually('图片删除同步三端', async () => Promise.all([a,b,c].map(page => page.locator('.document-image').count())), counts => counts.every(n => n === 0))
    const restored = await pageApi(a, `/api/docs/${resources.docKeys.doc}/restore`, { method: 'POST', body: { rev: originalRevision } })
    assert(restored.status === 200, '图片版本恢复失败')
    for (const page of [a,b,c]) await imageReady(page, '.document-image')
    await eventually('恢复原始图片元数据', () => c.locator('.document-image figcaption').textContent(), text => text === 'document-original.png')
    assert(await c.getByRole('button', { name: '插入图片', exact: true }).count() === 0, '只读用户仍有图片上传按钮')
    const viewerToken = await c.evaluate(() => localStorage.getItem('collab_access_token'))
    const deniedResponse = await c.context().request.post(new URL(`/api/docs/${resources.docKeys.doc}/images`, c.url()).href, {
      headers: { Authorization: `Bearer ${viewerToken}` }, multipart: { file: file('denied.png') },
    })
    const denied = deniedResponse.status()
    assert(denied === 403, '服务端未拦截只读上传')
    const token = await a.evaluate(() => localStorage.getItem('collab_access_token'))
    const result = await a.context().request.get(new URL(`/api/docs/${resources.docKeys.board}/export?format=docx`, a.url()).href, { headers: { Authorization: `Bearer ${token}` } })
    assert(result.status() === 400, '导出类型约束失效')
    await assertConverged(['owner','editor','viewer'])
    await screenshot(c, '14-image-history-readonly')
    return { viewerUploadStatus: denied, restoredRevision: restored.body.rev }
  })
  await step('白板图片位置、尺寸、层级三端同步及 PNG/SVG 导出', async () => {
    for (const page of [a,b,c]) await gotoWorkspace(page, 'board', resources.docKeys.board)
    await upload(a, '插入图片', 'board-image.png')
    for (const page of [a,b,c]) await imageReady(page, '.board-card')
    const item = a.locator('.board-card').filter({ has: a.locator('.board-image') })
    await item.focus(); await item.press('Shift+ArrowRight'); await item.press('Shift+ArrowDown')
    const handle = await item.getByRole('button', { name: '调整卡片大小', exact: true }).boundingBox()
    await a.mouse.move(handle.x + handle.width/2, handle.y + handle.height/2); await a.mouse.down()
    await a.mouse.move(handle.x + handle.width/2 + 50, handle.y + handle.height/2 + 30, { steps: 5 }); await a.mouse.up()
    await a.getByRole('button', { name: '置于底层', exact: true }).click()
    await eventually('白板图片布局一致', async () => Promise.all([a,b,c].map(page => page.locator('.board-card').filter({ has: page.locator('.board-image') }).getAttribute('style'))), styles => styles.every(style => style === styles[0]))
    await assertConverged(['owner','editor','viewer'])
    const svg = await download(a, 'svg', 'board')
    assert(svg.toString().includes('data:image/png;base64,'), 'SVG 缺少内嵌图片')
    const png = await download(a, 'png', 'board')
    assert(png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])), 'PNG 格式无效')
    await screenshot(a, '15-board-image-sync')
    return { pngBytes: png.length, svgBytes: svg.length }
  })
  await step('看板封面上传、替换、流转、CSV/XLSX 导出及移除', async () => {
    for (const page of [a,b,c]) await gotoWorkspace(page, 'kanban', resources.docKeys.kanban)
    await upload(b, '上传封面', 'task-cover.png')
    for (const page of [a,b,c]) await imageReady(page, '.kanban-card')
    await upload(a, '替换封面', 'task-cover-replaced.png')
    await eventually('封面替换同步', () => c.locator('.kanban-cover').getAttribute('alt'), text => text === 'task-cover-replaced.png')
    await a.getByRole('button', { name: '移到上一列表', exact: true }).click()
    await eventually('带图任务跨列同步', () => c.locator('.kanban-column').first().locator('.kanban-cover').count(), n => n === 1)
    await assertConverged(['owner','editor','viewer'])
    const csv = await download(a, 'csv', 'kanban')
    assert(csv.toString().includes('task-cover-replaced.png') && csv.toString().includes('/api/assets/'), 'CSV 缺少封面元数据')
    const xlsx = unzip(await download(a, 'xlsx', 'kanban'))
    assert(xlsx.get('xl/worksheets/sheet1.xml').toString().includes('task-cover-replaced.png'), 'XLSX 缺少封面元数据')
    await screenshot(a, '16-kanban-cover-sync')
    await b.getByRole('button', { name: '移除封面', exact: true }).click()
    await eventually('封面移除三端同步', async () => Promise.all([a,b,c].map(page => page.locator('.kanban-cover').count())), counts => counts.every(n => n === 0))
    return { csvBytes: csv.length, xlsxEntries: xlsx.size }
  })
}
