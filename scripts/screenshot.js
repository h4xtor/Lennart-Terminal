'use strict';

/**
 * Screenshot capture for Lennart Terminal via CDP.
 *
 * Launch the app with --remote-debugging-port, then:
 *   node scripts/screenshot.js [port] [outfile] [--full]
 *
 * Writes a PNG of the app window (viewport by default, full page with --full).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * Electron only produces frames for a window that is not fully occluded,
 * and Page.captureScreenshot hangs forever in that state. So first ask
 * Windows to bring the app window to the foreground.
 */
function findWindow(extra) {
  const ps = `
$p = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*Lennart*' } | Select-Object -First 1
if (-not $p) { Write-Output 'no-window'; exit 1 }
Write-Output $p.MainWindowHandle
${extra || ''}`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 15000 });
  return (r.stdout || '').trim();
}

function findWindowHandle() {
  const out = findWindow();
  const n = Number(out.split(/\r?\n/)[0]);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Force the window on screen: minimize+restore is the only reliable way to
 * get Windows to grant foreground rights, and temporary WS_EX_TOPMOST keeps
 * Electron's occlusion tracker happy even if the user refocuses something.
 */
function makeForeground(hwnd) {
  const ps = `
Add-Type @'
using System; using System.Runtime.InteropServices;
public class FG {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
}
'@
$h = [IntPtr]${hwnd}
[FG]::ShowWindow($h, 6) | Out-Null
Start-Sleep -Milliseconds 250
[FG]::ShowWindow($h, 9) | Out-Null
$fg = [FG]::GetForegroundWindow()
$tid = [FG]::GetCurrentThreadId()
$fgTid = [FG]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
[FG]::AttachThreadInput($fgTid, $tid, $true) | Out-Null
[FG]::SetForegroundWindow($h) | Out-Null
[FG]::BringWindowToTop($h) | Out-Null
[FG]::AttachThreadInput($fgTid, $tid, $false) | Out-Null
# HWND_TOPMOST, keep position/size, show it
[FG]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0043) | Out-Null
Write-Output ('fg=' + ([FG]::GetForegroundWindow() -eq $h))
`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 15000 });
  return (r.stdout || '').trim();
}

/** Undo the temporary topmost so the window behaves normally again. */
function clearTopmost(hwnd) {
  if (!hwnd) return;
  const ps = `
Add-Type @'
using System; using System.Runtime.InteropServices;
public class NT { [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f); }
'@
[NT]::SetWindowPos([IntPtr]${hwnd}, [IntPtr](-2), 0, 0, 0, 0, 0x0043) | Out-Null
`;
  spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 10000 });
}

// topmost is set on a best-effort basis: make sure it is always undone,
// even when the capture fails half-way.
let gTopmostHwnd = 0;
process.on('exit', () => {
  try { if (gTopmostHwnd) clearTopmost(gTopmostHwnd); } catch (_) {}
});

const PORT = Number(process.argv[2] || 9222);
const FULL = process.argv.includes('--full');
const OUT = path.resolve(
  process.argv.filter((a) => !a.startsWith('--'))[3] ||
    path.join(__dirname, '..', 'screenshot-v0.2.0.png')
);

async function main() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const list = await res.json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target on CDP port ' + PORT);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const step = (s) => console.log(`[screenshot] ${s}`);
  step('connected to ' + page.webSocketDebuggerUrl);
  await send('Page.enable');
  step('Page.enable ok');

  // ---- wait until the renderer is actually compositing ----
  const visibility = async () => {
    const r = await send('Runtime.evaluate', {
      expression: 'document.visibilityState',
      returnByValue: true
    });
    return r.result.value;
  };

  let vis = await visibility();
  let hwnd = 0;
  if (vis !== 'visible') {
    step(`renderer is "${vis}", forcing window to the foreground...`);
    hwnd = findWindowHandle();
    if (!hwnd) throw new Error('could not find the Lennart Terminal window');
    gTopmostHwnd = hwnd;
    step(makeForeground(hwnd) || 'foreground call failed');
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      vis = await visibility();
      if (vis === 'visible') break;
    }
  }
  if (vis !== 'visible') throw new Error(`renderer still "${vis}" - window occluded/minimized, cannot rasterize`);
  step('renderer visible');
  // let it paint a fresh frame
  await new Promise((r) => setTimeout(r, 600));

  // fromSurface:false is reliable in Electron even when the window is
  // occluded/minimized (fromSurface:true can hang waiting on the compositor).
  let shot;
  try {
    shot = await withTimeout(send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: false,
      captureBeyondViewport: FULL,
      ...(FULL ? { clip: await measurePage() } : {})
    }), 8000, 'captureScreenshot fromSurface:false');
  } catch (e) {
    step('fromSurface:false failed (' + e.message + '), retrying fromSurface:true');
    shot = await withTimeout(send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: FULL,
      ...(FULL ? { clip: await measurePage() } : {})
    }), 8000, 'captureScreenshot fromSurface:true');
  }

  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log(`screenshot written: ${OUT} (${fs.statSync(OUT).size} bytes)`);
  try { ws.close(); } catch (_) {}
  gTopmostHwnd = 0;
  if (hwnd) { clearTopmost(hwnd); step('topmost flag cleared'); }
  process.exit(0);

  async function withTimeout(p, ms, label) {
    let t;
    const timeout = new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(label + ' timed out after ' + ms + 'ms')), ms);
    });
    try { return await Promise.race([p, timeout]); } finally { clearTimeout(t); }
  }

  async function measurePage() {
    const m = await send('Runtime.evaluate', {
      expression: `JSON.stringify({width: Math.max(document.documentElement.scrollWidth, window.innerWidth), height: Math.max(document.documentElement.scrollHeight, window.innerHeight), x: 0, y: 0, scale: 1})`,
      returnByValue: true
    });
    return JSON.parse(m.result.value);
  }
}

const watchdog = setTimeout(() => {
  console.error('screenshot failed: timeout after 20s (CDP step hung)');
  process.exit(1);
}, 20000);

main().catch((err) => {
  console.error('screenshot failed:', err.message);
  process.exit(1);
});
