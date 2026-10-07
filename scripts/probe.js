// Tiny CDP helper: node scripts/probe.js 9222 '<js expression>'  [shrink|restore]
const port = process.argv[2] || '9222';
const expr = process.argv[3];
const mode = process.argv[4] || '';

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = list.find((t) => t.type === 'page' && !/devtools/.test(t.url)) || list[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result || m.error); pending.delete(m.id); }
  };
  await new Promise((r) => { ws.onopen = r; });

  if (mode === 'shrink') {
    await send('Emulation.setDeviceMetricsOverride', { width: 1380, height: 760, deviceScaleFactor: 1, mobile: false });
    await new Promise((r) => setTimeout(r, 1500));
  } else if (mode === 'restore') {
    await send('Emulation.clearDeviceMetricsOverride', {});
    await new Promise((r) => setTimeout(r, 900));
  }

  const out = await send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true,
  });
  console.log(JSON.stringify(out.result ? out.result.value : out, null, 2));
  ws.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
