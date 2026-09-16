// T0+10 端到端：历史时间线 → 回放 → 恢复 → 导出 → 搜索 → 统计
const BASE = 'http://localhost:8080';
const WS = BASE.replace('http', 'ws');

async function api(path, opt = {}) {
  const r = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json', ...(opt.token ? { Authorization: 'Bearer ' + opt.token } : {}) },
    ...opt,
  });
  return { status: r.status, body: await r.json() };
}
const reg = async (tag) => {
  const name = tag + '-' + Math.random().toString(36).slice(2, 6);
  await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: name, password: 'pass1234' }) });
  const l = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: name, password: 'pass1234' }) });
  return { name, token: l.body.token };
};
function clientWs(name, token) {
  const ws = new WebSocket(WS + '/ws/collab?token=' + encodeURIComponent(token));
  const inbox = [], waiters = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    const i = waiters.findIndex(w => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].res(m); else inbox.push(m);
  };
  return {
    open: () => new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }),
    send: o => ws.send(JSON.stringify(o)),
    next(pred, ms = 6000) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(name + ' 超时')), ms); waiters.push({ pred, res: m => { clearTimeout(t); res(m); } }); });
    },
    close: () => ws.close(),
  };
}

(async () => {
  const U = await reg('u10');
  const sid = (await api('/api/spaces', { method: 'POST', token: U.token, body: JSON.stringify({ name: '产品演示' }) })).body.spaceId;
  const key = (await api('/api/docs', { method: 'POST', token: U.token, body: JSON.stringify({ title: '论文提纲', spaceId: sid }) })).body.docKey;
  console.log('[1] 空间+文档就绪 →', key.slice(0, 8));

  const write = async (text, clock) => {
    const c = clientWs('w', U.token);
    await c.open();
    c.send({ type: 'hello', docId: key, clientId: 'w', hostname: 'e2e', lastRev: 0 });
    await c.next(m => m.type === 'welcome');
    c.send({ type: 'op', docId: key, clientId: 'w', baseRev: 0, op: { type: 'PUT', elementId: 'doc-root', elementType: 'TEXT', field: 'text',
      value: text, clock: clock } });
    const a = await c.next(m => m.type === 'applied' && m.op.value === text);
    c.close();
    return a.rev;
  };
  const rev1 = await write('第一章：背景与意义', 'p:1');
  const rev2 = await write('第二章：系统设计（最新）', 'p:2');
  console.log('[1] 写入 rev1=' + rev1 + ' rev2=' + rev2);

  const hist = (await api('/api/docs/' + key + '/history', { token: U.token })).body;
  console.log('[2] 时间线 ' + hist.ops.length + ' 条 · 当前 rev=' + hist.rev);
  if (hist.ops.length < 2) throw new Error('时间线不足');

  const rp1 = (await api('/api/docs/' + key + '/replay?rev=' + rev1, { token: U.token })).body;
  const text1 = rp1.elements.find(e => e.id === 'doc-root').fields.text.value;
  console.log('[3] 回放 rev' + rev1 + ' →', text1);
  if (text1 !== '第一章：背景与意义') throw new Error('回放内容不对: ' + text1);

  const rs = await api('/api/docs/' + key + '/restore', { method: 'POST', token: U.token, body: JSON.stringify({ rev: rev1 }) });
  console.log('[4] 恢复 rev' + rev1 + ' →', rs.body.msg, '(diff ' + rs.body.ops + ' ops, rev=' + rs.body.rev + ')');
  const cur = (await api('/api/docs/' + key + '/replay?rev=' + rs.body.rev, { token: U.token })).body;
  const curText = cur.elements.find(e => e.id === 'doc-root').fields.text.value;
  console.log('    当前内容 →', curText);
  if (curText !== '第一章：背景与意义') throw new Error('恢复后文本不对: ' + curText);

  const mdR = await fetch(BASE + '/api/docs/' + key + '/export', { headers: { Authorization: 'Bearer ' + U.token } });
  const mdBody = await mdR.text();
  console.log('[5] Markdown 导出 →', mdR.status, JSON.stringify(mdBody.slice(0, 60)));
  if (mdR.status !== 200 || !mdBody.includes('# 论文提纲')) throw new Error('导出异常');

  const s1 = (await api('/api/docs/search?q=第一章', { token: U.token })).body;
  const s2 = (await api('/api/docs/search?q=论文提纲', { token: U.token })).body;
  console.log('[6] 正文搜索「第一章」→ ' + s1.length + ' 条 (body=' + s1.some(d => d.hit === 'body') + ')'
    + ' · 标题搜索「论文提纲」→ ' + s2.length + ' 条 (title=' + s2.some(d => d.hit === 'title') + ')');
  if (!s1.some(d => d.hit === 'body') || !s2.some(d => d.hit === 'title')) throw new Error('搜索未命中');

  const st = (await api('/api/stats', { token: U.token })).body;
  console.log('[7] 统计 → 我的空间 ' + st.mySpaces + ', 文档 ' + st.myDocs + ', 平台 ' + JSON.stringify(st.platform));

  console.log('=== T0+10 产品成熟端到端 PASS ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message || e); process.exit(1); });