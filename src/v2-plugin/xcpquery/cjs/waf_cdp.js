'use strict';
/*
 * Browserless-in-spirit CNIPA cpquery 412-WAF cookie solver, using a REAL
 * headless Chromium (headless_shell from the termux chromium package) via CDP.
 *
 * The previous pure-vm approach (waf_runner.js) reproduced the site's obfuscated
 * waf.js inside a Node vm with a hand-rolled DOM shim, but the produced cookie
 * was rejected by the server (瑞数/RiverSecurity validates real browser
 * fingerprints that the shim cannot reproduce).  A real browser executes the
 * challenge natively and yields a cookie the server accepts.
 *
 * Usage:  node waf_cdp.js <url> [port]
 *   - ensures a headless_shell instance is running (spawns if not)
 *   - navigates a page to <url> (the 412 challenge resolves itself)
 *   - waits until the anti-bot cookie is set
 *   - prints  BARECOOKIE|<Cookie header>  on stdout, exits 0
 *
 * The browser process is left running (detached) so subsequent calls reuse the
 * same instance / cookie jar; this keeps the flow fast after first solve.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PORT = 9222;
const HS = '/data/data/com.termux/files/usr/lib/chromium/headless_shell';
const TMP = '/data/data/com.termux/files/home/.cache/opencode/tmp';
const PROFILE = path.join(TMP, 'waf_cdp_profile');
const WP_COOKIE_PREFIX = 'dX1xbeyMT58W'; // 瑞数 cookie 名前缀

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function spawnBrowser(port) {
  const args = [
    '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-crash-reporter', '--disable-dev-shm-usage',
    '--hide-scrollbars', '--mute-audio',
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${port}`,
    'about:blank',
  ];
  try {
    fs.mkdirSync(PROFILE, { recursive: true });
    const child = spawn(HS, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, HOME: os.homedir(), TMPDIR: TMP, XDG_RUNTIME_DIR: PROFILE },
    });
    child.unref();
    return child;
  } catch (e) {
    return null;
  }
}

async function portAlive(port) {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return resp.ok;
  } catch (_) {
    return false;
  }
}

async function ensureBrowser(port) {
  if (await portAlive(port)) return;
  spawnBrowser(port);
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await portAlive(port)) return;
  }
  throw new Error('headless_shell 未能启动 (CDP 端口无响应)');
}

async function getTabs(port) {
  const resp = await fetch(`http://127.0.0.1:${port}/json/list`);
  return resp.json();
}

async function newTab(port, url) {
  const resp = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  return resp.json();
}

function cdp(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMsg = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.id === id) {
        ws.removeEventListener('message', onMsg);
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error('ws connect failed'));
  });
}

async function getCookies(ws) {
  const r = await cdp(ws, 'Network.getAllCookies', {});
  return r.cookies || [];
}

function cookieHeader(cookies) {
  const parts = [];
  for (const c of cookies) {
    parts.push(c.name + '=' + c.value);
  }
  return parts.join('; ');
}

async function solve(url, port) {
  await ensureBrowser(port);

  let page;
  // Reuse the first page tab if present (keeps cookie jar warm); else create.
  let tabs = await getTabs(port);
  page = tabs.find((t) => t.type === 'page');
  if (!page) {
    page = await newTab(port, url);
  }

  const ws = await openWs(page.webSocketDebuggerUrl);
  try {
    await cdp(ws, 'Page.enable', {});
    await cdp(ws, 'Network.enable', {});
    // Navigate (a second visit with an already-solved jar resolves instantly).
    await cdp(ws, 'Page.navigate', { url }).catch(() => {});

    const deadline = Date.now() + 30000;
    let lastCookies = [];
    while (Date.now() < deadline) {
      await sleep(500);
      let cookies;
      try { cookies = await getCookies(ws); } catch (_) { continue; }
      lastCookies = cookies;
      const wp = cookies.filter((c) => c.name.startsWith(WP_COOKIE_PREFIX) || c.name.startsWith('enable_'));
      if (wp.length >= 2 && cookies.some((c) => c.name === WP_COOKIE_PREFIX + 'P')) {
        return cookieHeader(cookies);
      }
    }
    // Fallback: even if the WP cookie name changed, return whatever is on the domain.
    if (lastCookies.length) return cookieHeader(lastCookies);
    throw new Error('浏览器未在超时内解出瑞数 cookie');
  } finally {
    try { ws.close(); } catch (_) {}
  }
}

async function main() {
  const url = process.argv[2];
  const port = process.argv[3] ? Number(process.argv[3]) : DEFAULT_PORT;
  if (!url) {
    console.error('usage: node waf_cdp.js <url> [port]');
    process.exit(1);
  }
  try {
    const header = await solve(url, port);
    console.log('BARECOOKIE|' + header);
    process.exit(0);
  } catch (e) {
    console.error('WAF_CDP_ERR ' + (e && e.message));
    process.exit(1);
  }
}

main();
