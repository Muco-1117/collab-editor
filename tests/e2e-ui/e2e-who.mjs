import('playwright').then(async ({ chromium }) => {
  const BASE = 'http://localhost:8080';
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1360, height: 820 } });
  const A = await ctx.newPage(); const B = await ctx.newPage();
  A.on('pageerror', e => console.log('A-EXC:', String(e).slice(0, 120)));
  B.on('pageerror', e => console.log('B-EXC:', String(e).slice(0, 120)));
  const u = 'who' + Date.now().toString().slice(-6);
  for (const p of [A, B]) {
    p.on('dialog', d => d.accept('看板 ' + Date.now().toString().slice(-4)).catch(() => {}));
    await p.goto(BASE + '/login.html');
    await p.click('#switch');
    await p.fill('#username', p === A ? u : u + 'b');
    await p.fill('#password', 'pass1234');
    await p.click('#submitBtn');
    await p.waitForURL(BASE + '/', { timeout: 15000 });
  }
  // A 建看板 + 列 + 卡
  await A.goto(BASE + '/kanban.html');
  await A.click('button:has-text("＋ 新建看板")');
  await A.waitForSelector('#addColBtn:not([disabled])', { timeout: 8000 });
  await A.click('#addColBtn');
  await A.waitForSelector('.col .add-card', { timeout: 6000 });
  await A.click('.col .add-card');
  await A.waitForSelector('.card-kanban', { timeout: 6000 });
  // B 加入同一看板
  await B.goto(BASE + '/kanban.html');
  await B.waitForSelector('#docList .doc-item', { timeout: 8000 });
  await B.click('#docList .doc-item');
  await B.waitForSelector('#dot.on', { timeout: 8000 });
  await A.waitForTimeout(1200);
  const avA = await A.evaluate(() => ({
    whoCount: document.querySelectorAll('#who .who-avatar').length,
    whoCap: document.querySelector('#who .who-caption')?.textContent || ''
  }));
  const avB = await B.evaluate(() => document.querySelectorAll('#who .who-avatar').length);
  console.log('在线头像 A:', JSON.stringify(avA), avA.whoCount >= 2 ? 'PASS' : 'FAIL');
  console.log('在线头像 B(含我在内):', avB, avB >= 2 ? 'PASS' : 'FAIL');
  // 历史弹窗
  await A.click('button:has-text("📜 历史")');
  await A.waitForSelector('.histMask', { timeout: 6000 });
  const hist = await A.evaluate(() => ({
    rows: document.querySelectorAll('.histMask .btn[onclick*="restoreRev"]').length,
    title: document.querySelector('.histMask b')?.textContent || ''
  }));
  console.log('看板历史弹窗:', JSON.stringify(hist), hist.rows > 0 ? 'PASS' : 'FAIL');
  await A.keyboard.press('Escape').catch(() => {});
  await A.click('.histMask .btn', { position: { x: 5, y: 5 } }).catch(() => {});
  await A.screenshot({ path: 'docs/ui-shots/0-who-histo.png' }).catch(() => {});
  await b.close();
}).catch(e => { console.error('FATAL', String(e).slice(0, 300)); process.exit(1); });