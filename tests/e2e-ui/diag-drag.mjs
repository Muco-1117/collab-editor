// 诊断：看板 UI 拖拽换列是否双端同步（T0+12 用户反馈）
import { chromium } from 'playwright';
import fs from 'fs';
const BASE = 'http://localhost:8080';
const uname = 'dbg' + Math.random().toString(36).slice(2, 7);
(async () => {
  const browser = await chromium.launch();
  const A = await (await browser.newContext()).newPage();
  const B = await (await browser.newContext()).newPage();
  A.on('dialog', d => d.accept('拖拽诊断'));
  B.on('dialog', d => d.accept('拖拽诊断'));
  for (const p of [A, B]) {
    await p.goto(BASE + '/login.html');
    await p.click('#switch');
    await p.fill('#username', uname + (p === A ? 'a' : 'b'));
    await p.fill('#password', 'pass1234');
    await p.click('#submitBtn');
    await p.waitForURL(BASE + '/', { timeout: 15000 });
  }
  // A 创建空间并邀请 B
  await A.fill('#spName', '拖拽诊断');
  await A.click('#spCreate');
  await A.waitForFunction(() => [...document.querySelectorAll('#spList > div')].some(c => c.textContent.includes('拖拽诊断')), null, { timeout: 8000 });
  const card = A.locator('#spList > div').filter({ hasText: '拖拽诊断' });
  await card.locator('input').fill(uname + 'b');
  await card.locator('button:has-text("邀请")').click();
  await A.waitForFunction(() => [...document.querySelectorAll('#spList > div')].some(c => c.textContent.includes('2 成员')), null, { timeout: 8000 });

  // A 建看板 + 2 列 + 卡
  await A.goto(BASE + '/kanban.html');
  await A.click('button:has-text("＋ 新建看板")');
  await A.waitForSelector('#addColBtn:not([disabled])', { timeout: 8000 });
  await A.click('#addColBtn');
  await A.waitForSelector('.col .add-card', { timeout: 6000 });
  await A.click('#addColBtn');                       // 第二列
  await A.waitForFunction(() => document.querySelectorAll('.col').length === 2, null, { timeout: 6000 });
  await A.locator('.col').first().locator('.add-card').click();
  await A.waitForSelector('.card-kanban .body', { timeout: 6000 });
  const body = A.locator('.card-kanban .body').first();
  await body.click();
  await body.pressSequentially('拖拽卡', { delay: 10 });
  await A.waitForTimeout(500);
  const bKey = await A.evaluate(() => document.querySelector('#docSel').value);
  console.log('A 看板就绪 key=' + bKey.slice(0, 8));

  // B 打开同板
  await B.goto(BASE + '/kanban.html');
  await B.waitForFunction(() => document.querySelectorAll('#docSel option').length > 0, null, { timeout: 8000 });
  await B.selectOption('#docSel', bKey);
  await B.waitForFunction(() => document.querySelector('.card-kanban .body')?.textContent.includes('拖拽卡'), null, { timeout: 8000 });

  // ===== 真实拖拽：A 把卡从第 1 列拖到第 2 列 =====
  const col1 = await A.locator('.col').nth(0).boundingBox();
  const col2 = await A.locator('.col').nth(1).boundingBox();
  const cbb = await A.locator('.card-kanban').first().boundingBox();
  console.log('col1=', JSON.stringify(col1), 'col2=', JSON.stringify(col2), 'card=', JSON.stringify(cbb));
  // 从卡片上缘（body 之外）按下
  await A.mouse.move(cbb.x + cbb.width / 2, cbb.y + 2);
  await A.mouse.down();
  await A.mouse.move(col2.x + 60, col2.y + 80, { steps: 12 });
  await A.mouse.up();
  await A.waitForTimeout(800);

  const colsA = await A.evaluate(() => [...document.querySelectorAll('.col')].map(c => [c.dataset.eid, [...c.querySelectorAll('.card-kanban')].map(x => x.dataset.eid)]));
  const colsB = await B.evaluate(() => [...document.querySelectorAll('.col')].map(c => [c.dataset.eid, [...c.querySelectorAll('.card-kanban')].map(x => x.dataset.eid)]));
  console.log('A 列分布:', JSON.stringify(colsA));
  console.log('B 列分布:', JSON.stringify(colsB));
  const same = JSON.stringify(colsA) === JSON.stringify(colsB);
  const moved = colsA[1][1].length === 1;
  console.log('movedToCol2=' + moved + ' A/B一致=' + same);
  await A.screenshot({ path: 'artifacts/drag-diag-a.png' });
  await B.screenshot({ path: 'artifacts/drag-diag-b.png' });
  await browser.close();
  console.log(moved && same ? 'DIAG-PASS' : 'DIAG-FAIL');
  process.exit(moved && same ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });