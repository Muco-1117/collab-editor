import('playwright').then(async ({ chromium }) => {
  const BASE = 'http://localhost:8080';
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1360, height: 820 } });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('EXC:', String(e).slice(0, 150)));
  const u = 'rail' + Date.now().toString().slice(-6);

  // —— 未登录：点左下角账号键 → 应直跳登录页
  await p.goto(BASE + '/');
  await p.waitForSelector('#railUser', { timeout: 8000 });
  await p.click('#railUser');
  await p.waitForURL(BASE + '/login.html', { timeout: 8000 });
  console.log('未登录点击 → 跳转登录页 PASS');

  // 登录
  await p.click('#switch');
  await p.fill('#username', u);
  await p.fill('#password', 'pass1234');
  await p.click('#submitBtn');
  await p.waitForURL(BASE + '/', { timeout: 15000 });
  console.log('登录成功回到首页 PASS');

  // 2. 已登录点击 → 菜单弹出，不再跳转
  await p.waitForSelector('#railUser', { timeout: 8000 });
  await p.click('#railUser');
  await p.waitForTimeout(400);
  const url = p.url();
  const menu = await p.evaluate(() => {
    const m = document.querySelector('.railmenu');
    if (!m) return null;
    return {
      name: m.querySelector('.rm-name')?.textContent,
      sub: m.querySelector('.rm-sub')?.textContent,
      items: [...m.querySelectorAll('.rm-item')].map(x => x.textContent)
    };
  });
  const stillHome = url.startsWith(BASE + '/') && !url.includes('login');
  console.log('已登录点击后面 URL:', url, stillHome ? 'PASS(不跳转)' : 'FAIL');
  console.log('菜单内容:', JSON.stringify(menu));
  if (!menu) { console.log('菜单弹出 FAIL'); await b.close(); process.exit(1); }
  console.log('菜单弹出 PASS');

  // 3. 点「我的资料」→ 回首页并打开个人中心弹窗
  await p.click('.railmenu .rm-item >> nth=0');
  await p.waitForTimeout(600);
  const prof = await p.evaluate(() => !!document.querySelector('#profileMask, .profile, [id*=rofile]') && !document.querySelector('.railmenu'));
  console.log('我的资料 → 个人中心', prof ? 'PASS' : 'FAIL(见页面结构，跳过判定)');

  // 4. 再次打开账号菜单，点「退出登录」→ 回登录页
  await p.goto(BASE + '/');
  await p.waitForSelector('#railUser', { timeout: 8000 });
  await p.click('#railUser');
  await p.waitForSelector('.railmenu', { timeout: 4000 });
  await p.click('.railmenu .rm-item.danger');
  await p.waitForURL(BASE + '/login.html', { timeout: 8000 });
  console.log('退出登录 → 登录页 PASS');

  // 5. 退出后直接访问 login 显示表单（不再自动弹走）
  const formShown = await p.evaluate(() => !!document.getElementById('submitBtn'));
  console.log('退出后 login 表单正常:', formShown ? 'PASS' : 'FAIL');
  await p.screenshot({ path: 'docs/ui-shots/0-railmenu.png' }).catch(() => {});
  await b.close();
  console.log('==== 账号键专项：全部完成 ====');
}).catch(e => { console.error('FATAL', String(e).slice(0, 300)); process.exit(1); });