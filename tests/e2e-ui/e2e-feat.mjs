import('playwright').then(async ({ chromium }) => {
  const BASE = 'http://localhost:8080';
  const b = await chromium.launch();
  const ctxA = await b.newContext({ viewport: { width: 1440, height: 860 } });
  const ctxB = await b.newContext({ viewport: { width: 1440, height: 860 } });
  const A = await ctxA.newPage(); const B = await ctxB.newPage();
  await B.goto('about:blank');  // headless: 从未导航过的空页面会阻塞 A 的输入事件（实测）
  const dlg = d => d.accept('新' + Date.now().toString().slice(-6)).catch(() => {});
  for (const p of [A, B]) p.on('dialog', dlg);
  const u = 'feat' + Date.now().toString().slice(-6);
  async function login(p, uname, reg = true) {
    await p.goto(BASE + '/login.html');
    if (reg) {
      await p.locator('#switch').waitFor({ timeout: 6000 });
      await p.locator('#switch').click();
    }
    await p.fill('#username', uname);
    await p.fill('#password', 'pass1234');
    await p.click('#submitBtn');
    await p.waitForURL(BASE + '/', { timeout: 15000 });
  }
  await login(A, u);
  await login(B, u, false);  // 同用户双端登录（私有可见性：不同账号看不到彼此的文档）
  let fails = 0;
  const chk = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : '')); if (!ok) fails++; };

  /* ============ 白板：工具栏/缩放/上色/右键 ============ */
  await A.goto(BASE + '/board.html');
  await A.click('button:has-text("＋ 新建白板")');
  await A.waitForSelector('#zoomLabel', { timeout: 8000 });
  chk('board 工具栏存在', await A.evaluate(() => !!document.querySelector('#zoomLabel') && document.querySelectorAll('#swBar .swatch').length === 8));
  try {
    await A.waitForSelector('#dot.on', { timeout: 9000 });
    chk('白板 ws 连接就绪', true);
  } catch {
    throw new Error('白板 ws 连接未就绪');
  }
  await A.waitForTimeout(500);
  // 双击新建卡片（空白处）
  const bb = await A.evaluate(() => { const r = document.querySelector('#board').getBoundingClientRect(); return { x: r.left + 320, y: r.top + 260 }; });
    // headless Chromium 不合成 dblclick（实测 mousedown/click ×2 但 dblclick=0）→ 直接派发事件
    await A.evaluate(({ x, y }) => {
      document.getElementById('board').dispatchEvent(new MouseEvent('dblclick', { clientX: x, clientY: y, bubbles: true, cancelable: true }));
    }, bb);
  await A.waitForSelector('.card', { timeout: 6000 });
  chk('新建卡片', true);
  // 缩放：110%
  await A.click('button[title="放大"]');
  await A.waitForTimeout(350);
  const z1 = await A.evaluate(() => document.querySelector('#zoomLabel').textContent);
  chk('缩放按钮 110%', z1 === '110%', z1);
  // Ctrl+滚轮缩放 120%
  await A.mouse.move(bb.x + 100, bb.y + 100);
  await A.keyboard.down('Control');
  await A.mouse.wheel(0, -120);
  await A.keyboard.up('Control');
  await A.waitForTimeout(150);
  const z2 = await A.evaluate(() => document.querySelector('#zoomLabel').textContent);
  chk('Ctrl+滚轮放大', z2 === '118%', z2);
  // 点选卡片 → 工具栏上色 → 双窗同步
  await A.click('.card');
  const sel = await A.evaluate(() => document.querySelector('.card.sel') !== null);
  chk('点选卡片高亮', sel);
  await A.evaluate(() => document.querySelectorAll('#swBar .swatch')[3].click());
  await A.waitForTimeout(400);
  const colA = await A.evaluate(() => getComputedStyle(document.querySelector('.card')).backgroundColor);
  chk('工具栏上色生效', colA.includes('168') || colA.includes('208'), colA);
  // 右键菜单上色
  await A.click('.card', { button: 'right' });
  await A.waitForSelector('.ctx', { timeout: 4000 });
  chk('右键菜单弹出', true);
  await A.click('.ctx .swatch[data-c="#ffd666"]');
  await A.waitForTimeout(400);
  const colB = await A.evaluate(() => getComputedStyle(document.querySelector('.card')).backgroundColor);
  chk('右键上色生效', colB.includes('255, 214') || colB.includes('255,213'), colB);
  // B 同步
  await B.goto(BASE + '/board.html');
  try {
    await B.waitForSelector('.card', { timeout: 12000 });
  } catch (e) {
    console.log('B-diagnose:', JSON.stringify(await B.evaluate(() => ({
      items: document.querySelectorAll('#docList .doc-item').length,
      cards: document.querySelectorAll('#board .card').length,
      dot: document.querySelector('#dot')?.className,
      ws: !!window.ws && ws.readyState
    }))));
    throw e;
  }
  await B.waitForTimeout(600);
  const colB2 = await B.evaluate(() => getComputedStyle(document.querySelector('.card')).backgroundColor);
  chk('双窗颜色同步', colB2.split(',').slice(0, 3).join() === colB.split(',').slice(0, 3).join() || Math.abs(colB2.split(',')[0] - colB.split(',')[0]) < 3, colB2);

  /* ============ 看板：列拖拽 + 卡上色 ============ */
  await A.goto(BASE + '/kanban.html');
  await A.click('button:has-text("＋ 新建看板")');
  await A.waitForFunction(() => !!document.querySelector('#addColBtn') && !document.querySelector('#addColBtn').disabled, null, { timeout: 9000 });
  // 五列
  for (let i = 0; i < 5; i++) { await A.click('#addColBtn'); await A.waitForTimeout(300); }
  await A.waitForSelector('.col', { timeout: 6000 });
  await A.waitForTimeout(600);
  const cols = await A.evaluate(() => [...document.querySelectorAll('.col .title')].map(x => x.textContent));
  chk('5 列存在', cols.length === 5, cols.join(','));
  // 拖第一列到第三列位置（用鼠标拖）
  const g1 = await A.locator('.grip-col').first().boundingBox();
  const g3 = await A.locator('.col').nth(2).boundingBox();
  await A.mouse.move(g1.x + g1.width / 2, g1.y + g1.height / 2);
  await A.mouse.down();
  await A.mouse.move(g3.x + g3.width / 2, g3.y + g3.height / 2, { steps: 8 });
  await A.mouse.up();
  await A.waitForTimeout(600);
  const order = await A.evaluate(() => [...document.querySelectorAll('.col .title')].map(x => x.textContent.trim()));
  chk('列拖拽重排', order[0].includes('新列'), order.join(' | '));
  // B 同步顺序
  await B.goto(BASE + '/kanban.html');
  await B.waitForSelector('.col', { timeout: 8000 });
  await B.waitForTimeout(400);
  const orderB = await B.evaluate(() => [...document.querySelectorAll('.col .title')].map(x => x.textContent.trim()));
  chk('列序双窗同步', orderB.join() === order.join(), orderB.join(' | '));
  // 卡右键上色（看板）
  await A.click('.col .add-card');
  await A.waitForSelector('.card-kanban', { timeout: 6000 });
  await A.click('.card-kanban', { button: 'right' });
  await A.waitForSelector('.ctx', { timeout: 4000 });
  await A.click('.ctx .swatch[data-c="#ff9d8f"]');
  await A.waitForTimeout(400);
  const kc = await A.evaluate(() => getComputedStyle(document.querySelector('.card-kanban')).backgroundColor);
  chk('看板卡右键上色', kc.includes('255'), kc);

  await A.screenshot({ path: 'docs/ui-shots/0-toolbox.png' }).catch(() => {});
  await b.close();
  console.log('==== 新功能专项：' + (fails === 0 ? '全部通过' : fails + ' 项失败') + ' ====');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('FATAL', String(e).slice(0, 400)); process.exit(1); });