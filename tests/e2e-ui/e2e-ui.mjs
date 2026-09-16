// 双层验证 · 界面层：Playwright 真实浏览器双窗口端到端
// 覆盖：注册/登录 → 空间 → 新建文档 → 双窗口实时同步 → 历史回退双向生效 → 看板双端同步
// 运行：node e2e-ui.mjs   （需：服务已启动 http://localhost:8080）
import { chromium } from 'playwright';
import fs from 'fs';

const BASE = 'http://localhost:8080';
const ART = 'artifacts';
fs.mkdirSync(ART, { recursive: true });

const results = [];
const step = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log((ok ? '✅' : '❌') + ' ' + name + (extra ? ' — ' + extra : ''));
};

async function newUser(page, uname) {
  await page.goto(BASE + '/login.html');
  await page.click('#switch');                       // 切到注册
  await page.fill('#username', uname);
  await page.fill('#password', 'pass1234');
  await page.click('#submitBtn');
  await page.waitForURL(BASE + '/', { timeout: 15000 }); // 注册成功自动登录进首页
}

(async () => {
  const browser = await chromium.launch();
  const ctxA = await browser.newContext();   // 用户 A（独立 cookie 桶）
  const ctxB = await browser.newContext();   // 用户 B（独立 cookie 桶）
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  A.on('pageerror', e => console.log('  [A pageerror]', e.message));
  B.on('pageerror', e => console.log('  [B pageerror]', e.message));
  A.on('dialog', d => d.accept('双窗口同步文档'));   // newDoc prompt → 标题
  B.on('dialog', d => d.accept('双看板验证'));

  const ua = 'ua' + Math.random().toString(36).slice(2, 7);
  const ub = 'ub' + Math.random().toString(36).slice(2, 7);
  console.log('用户A=' + ua + ' 用户B=' + ub);

  // ── 1. 注册登录 ─────────────────────────────────────────────
  await newUser(A, ua);
  await newUser(B, ub);
  step('1 双用户注册并登录门户', A.url() === BASE + '/' && B.url() === BASE + '/', ua);
  await A.screenshot({ path: ART + '/1-home-a.png' });

  // ── 2. A 创建空间 + 邀请 B + 新建文档 ───────────────────────
    await A.fill('#spName', '双窗口验证空间');
    await A.click('#spCreate');
    await A.waitForSelector('#spList', { timeout: 8000 });
    // 邀请 B（A 页面上以 A 的 token 调邀请 API）
    const invited = await A.evaluate(async ub => {
      const list = await (await fetch('/api/spaces', { headers: { Authorization: 'Bearer ' + window.auth.token() } })).json();
      const sp = list.find(s => s.name === '双窗口验证空间');
          if (!sp) return false;
          const r = await fetch('/api/spaces/' + sp.id + '/members', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + window.auth.token() },
        body: JSON.stringify({ username: ub, role: 'editor' }),
      });
      return r.ok;
    }, ub);
    step('2 A 建空间并邀请 B', invited === true, ub);
    await A.click('#spList a[href="/editor.html"]');      // 一键进文档应用
    await A.waitForURL(/\/editor\.html/, { timeout: 10000 });
    await A.click('button:has-text("＋ 新建文档")');       // prompt 自动填标题
    await A.waitForSelector('#segs .seg', { timeout: 8000 });
    await A.waitForFunction(() => document.querySelector('#dot').className.includes('on'), null, { timeout: 8000 });
    step('2b A 进文档并新建，WS 已连接', true);

  // ── 3. A 写标题 + 正文 ──────────────────────────────────────
  await A.fill('#title', '双窗口同步文档');
  const segA = A.locator('#segs .seg').first();
  await segA.click();
  await segA.pressSequentially('第一段：来自用户A的输入', { delay: 12 });
  await A.waitForTimeout(500);   // 防抖 200ms 后 PUT
  await A.screenshot({ path: ART + '/3-editor-a-write.png' });

  // ── 4. B 进同一空间 → 打开同一文档 → 实时看到 A 的输入 ────────
  await B.goto(BASE + '/editor.html');
  await B.waitForSelector('#docList .doc-item', { timeout: 8000 });
  await B.click('#docList .doc-item .name');              // 打开该空间下文档列表首个
  await B.waitForFunction(() => [...document.querySelectorAll('#segs .seg')].some(e => e.textContent.includes('用户A的输入')), null, { timeout: 8000 });
  step('4 B 打开同一文档，实时看到 A 的输入', true);
  await B.screenshot({ path: ART + '/e2e-editor-b-sync.png' });

  // ── 5. B 写新段 → A 实时收到 ────────────────────────────────
  const segB = B.locator('#segs .seg').last();
  await segB.click();
  await segB.pressSequentially('第二段：来自用户B的协作', { delay: 12 });
  await A.waitForFunction(() => [...document.querySelectorAll('#segs .seg')].some(e => e.textContent.includes('来自用户B的协作')), null, { timeout: 8000 });
  step('5 B 的新段落实时同步到 A', true);
  await A.screenshot({ path: ART + '/e2e-editor-a-b-new.png' });

  // ── 6. A 历史回退 → A、B 双向看到旧版本 ─────────────────────
  await A.click('button:has-text("📜 历史")');
  await A.waitForSelector('#histBox button:has-text("恢复到此")', { timeout: 6000 });
  await A.locator('#histBox button:has-text("恢复到此")').first().click(); // 最早 rev → 恢复（confirm 自动确定）
  await A.waitForSelector('#histBox', { state: 'detached', timeout: 6000 });
  await A.waitForFunction(() => document.querySelector('#segs').textContent.trim().length > 0, null, { timeout: 5000 });
  await A.waitForTimeout(700);
  const aText = await A.locator('#segs').innerText();
  const bText = await B.locator('#segs').innerText();
  step('6 历史回退后 A/B 两端内容一致', aText.trim() === bText.trim(), 'A 长' + aText.length + ' B 长' + bText.length);
  await A.screenshot({ path: ART + '/e2e-restore-both.png' });

  // ── 7. 看板：A 建板建列建卡，B 同步看到；B 加卡，A 实时看到 ──
  await A.goto(BASE + '/kanban.html');
  await A.waitForSelector('button:has-text("＋ 新建看板")', { timeout: 8000 });
  await A.click('button:has-text("＋ 新建看板")');            // prompt 自动 accept
  await A.waitForSelector('#addColBtn:not([disabled])', { timeout: 8000 });
  await A.click('#addColBtn');
  await A.waitForSelector('.col .add-card', { timeout: 6000 });
  await A.click('.col .add-card');
  await A.waitForSelector('.card-kanban .body', { timeout: 6000 });
  const kKey = await A.evaluate(() => document.querySelector('#docSel').value || '');   // 取 A 看板 docKey
  step('7 A 建看板并建首列首卡', kKey.length > 0, kKey.slice(0, 8));
  const cardA = A.locator('.card-kanban .body').first();
  await cardA.click();
  await cardA.pressSequentially('看板验证卡A', { delay: 10 });
  await A.waitForTimeout(400);
  await A.waitForFunction(() => document.querySelector('.col .title').textContent.length > 0, null, { timeout: 4000 }).catch(() => {});

  await B.goto(BASE + '/kanban.html');
  await B.waitForFunction(() => document.querySelectorAll('#docSel option').length > 0, null, { timeout: 8000 });
  await B.selectOption('#docSel', kKey);   // A 的看板（同空间可见）
  await B.waitForFunction(() => document.querySelector('#board .card-kanban .body')?.textContent.includes('看板验证卡A'), null, { timeout: 8000 });
  step('7b B 看到 A 的看板卡片实时同步', true);

  const cardB = B.locator('.card-kanban .body').first();
  await cardB.click();
  await cardB.pressSequentially('（B补卡）', { delay: 10 });
  await A.waitForFunction(() => [...document.querySelectorAll('.card-kanban .body')].some(e => e.textContent.includes('B补卡')), null, { timeout: 8000 });
  step('7c B 补卡实时同步回 A', true);
  await B.screenshot({ path: ART + '/e2e-kanban-b.png' });

  // ── 8. 门户统计随操作实时更新 ───────────────────────────────
  await A.goto(BASE + '/');
  await A.waitForSelector('#statsLine:not(:has-text("—"))', { timeout: 8000 });
  const stats = (await A.locator('#statsLine').innerText()).replace(/\s+/g, ' ');
  step('8 门户统计实时可读', /用户/.test(stats), stats);

  // ── 汇总 ─────────────────────────────────────────────────────
  const ok = results.filter(r => r.ok).length, total = results.length;
  console.log('\n===== 界面层（Playwright）端到端：' + ok + '/' + total + ' PASS =====');
  fs.writeFileSync(ART + '/summary.json', JSON.stringify({ total, ok, results, time: new Date().toISOString() }, null, 2));
  await browser.close();
  process.exit(ok === total ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(2); });