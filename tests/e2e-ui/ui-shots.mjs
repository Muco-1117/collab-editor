// UI 换装截图：登录页 / 门户（登录态）/ 编辑器 / 看板 / 白板
import { chromium } from 'playwright';
const BASE = process.env.UI_SHOTS_BASE_URL || 'http://localhost:8080';
const OUT = process.env.UI_SHOTS_OUTPUT_DIR || 'docs/ui-shots';
import fs from 'fs';
fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 850 } });
  const p = await ctx.newPage();
  p.on('dialog', d => d.accept());
  p.on('pageerror', e => console.log('PAGE-EXC:', String(e).slice(0, 150)));

  // 1 未登录门户
  await p.goto(BASE + '/');
  await p.waitForTimeout(900);
  await p.screenshot({ path: OUT + '/1-portal-guest.png' });

  // 2 登录页
  await p.goto(BASE + '/login.html');
  await p.waitForTimeout(400);
  await p.screenshot({ path: OUT + '/2-login.png' });

  // 3 注册登录 → 门户（登录态：metrics + 空间 + 应用卡）
  const u = 'ui' + Math.random().toString(36).slice(2, 6);
  await p.click('#switch'); await p.fill('#username', u); await p.fill('#password', 'pass1234');
  await p.click('#submitBtn');
  await p.waitForURL(BASE + '/', { timeout: 12000 });
  await p.waitForSelector('.metrics .m b:not(:has-text("—"))', { timeout: 8000 });
  await p.waitForTimeout(600);
  await p.screenshot({ path: OUT + '/3-portal-logged.png' });

  // 4 编辑器（新建文档 + 输入两段）
  await p.click('#spList a[href="/editor.html"]');
  await p.waitForURL(/editor/, { timeout: 10000 });
  await p.click('button:has-text("＋ 新建文档")');
  await p.waitForSelector('#segs .seg', { timeout: 8000 });
  await p.fill('#title', '产品设计评审记录');
  await p.locator('#segs .seg').first().click();
  await p.locator('#segs .seg').first().pressSequentially('第一段：本轮评审重点是协作编辑的实时性与冲突收敛', { delay: 8 });
  await p.waitForTimeout(600);
  await p.screenshot({ path: OUT + '/5-editor.png' });

  // 5 看板
  await p.goto(BASE + '/kanban.html');
  await p.click('button:has-text("＋ 新建看板")');
  await p.waitForSelector('#addColBtn:not([disabled])', { timeout: 8000 });
  await p.click('#addColBtn');
  await p.waitForSelector('.col .add-card', { timeout: 6000 });
  await p.click('#addColBtn');
  await p.waitForFunction(() => document.querySelectorAll('.col').length === 2, null, { timeout: 6000 });
  for (let i = 0; i < 2; i++) {
    await p.locator('.col').nth(1).locator('.add-card').click();
    await p.waitForFunction(n => document.querySelectorAll('.card-kanban').length === n + 1, i, { timeout: 6000 });
  }
  await p.locator('.card-kanban .body').nth(0).click();
  await p.locator('.card-kanban .body').nth(0).pressSequentially('卡片 A：引擎收敛验证', { delay: 8 });
  await p.locator('.card-kanban .body').nth(1).click();
  await p.locator('.card-kanban .body').nth(1).pressSequentially('卡片 B：白板坐标同步', { delay: 8 });
  await p.waitForTimeout(500);
  await p.screenshot({ path: OUT + '/6-kanban.png' });

  // 6 白板
  await p.goto(BASE + '/board.html');
  await p.click('button:has-text("＋ 新建白板")');
  await p.waitForTimeout(1000);
  await p.mouse.dblclick(420, 320); // 空白处双击建卡
  await p.waitForSelector('#board .card', { timeout: 8000 });
  const cardA = p.locator('#board .card').first();
  await cardA.dblclick();
  await p.keyboard.type('需求讨论卡片', { delay: 8 });
  await p.waitForTimeout(300);
  await p.screenshot({ path: OUT + '/7-board.png' });

  // 7 我的资料
  await p.goto(BASE + '/');
  await p.waitForSelector('#meBtn', { timeout: 8000 });
  await p.click('#meBtn');
  await p.waitForFunction(n => document.body.textContent.includes('我的资料') && document.body.textContent.includes('@' + n), u, { timeout: 6000 });
  await p.waitForTimeout(300);
  await p.screenshot({ path: OUT + '/8-profile.png' });

  await browser.close();
  console.log('DONE', OUT);
})().catch(e => { console.error('FATAL', String(e).slice(0, 300)); process.exit(1); });
