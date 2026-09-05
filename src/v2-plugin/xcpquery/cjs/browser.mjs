import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Resident real-browser WAF solver (small kernel: headless_shell).
// The site's own waf.js computes and writes the clearance cookies
// (dX1xbeyMT58WO, dX1xbeyMT58WP, enable_dX1xbeyMT58W) in the browser; we never
// write them ourselves. We load the challenge page, let waf.js run, then read
// the WP cookie via CDP and reuse the browser's cookie jar for business calls.
// The browser is spawned ONCE and kept resident (low load, reused per call).
const CHROME = process.env.XCP_CHROME || "/data/data/com.termux/files/usr/lib/chromium/headless_shell";
const NODE = "/data/data/com.termux/files/usr/bin/node";
const TMP = "/data/data/com.termux/files/home/.cache/opencode/tmp";
const PROFILE = path.join(TMP, "xcp_browser_profile");
const PORT = 9223;
const PROXY_PORT = Number(process.env.WAF_PROXY_PORT || 8899);
const TARGET = "https://cpquery.cponline.cnipa.gov.cn";
const TYF = "https://tysf.cponline.cnipa.gov.cn/am";
const SSO_AUTH = "https://sso.cponline.cnipa.gov.cn/oauth/authorize?response_type=code&scope=openid&client_id=public-inquiry&redirect_uri=https://cpquery.cponline.cnipa.gov.cn";
const PREFIX = "dX1xbeyMT58";
const ENABLE = "enable_" + PREFIX + "W";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let starting = null;
let proxyProc = null;
let residentWs = null; // reused CDP websocket to the working tab

async function portAlive() {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch (_) { return false; }
}

// --- Stale/foreign browser reclamation -------------------------------------
// The resident browser is keyed by (PORT, PROFILE).  If a previous plugin
// instance died, or another chromium attached to the same port/profile, the
// surviving process keeps the port bound and the Chromium singleton lock.
// The old `ensureBrowser` blindly reused ANY listener on PORT, so it happily
// attached to a half-dead browser whose rendered tab is gone -> every later
// CDP poll (WAF solve / SSO login) hangs forever -> "Tool execution aborted".
// So: verify the listener is actually a HEALTHY browser we can drive, and
// reclaim the port/profile when it is not.

// Enumerate chromium pids whose cmdline references our profile (or PORT).
function staleBrowserPids() {
  const pids = [];
  try {
    for (const ent of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(ent)) continue;
      let cmd = "";
      try { cmd = fs.readFileSync(`/proc/${ent}/cmdline`, "utf8"); } catch (_) { continue; }
      if (!cmd) continue;
      const flat = cmd.replace(/\0/g, " ");
      const isChromium = /headless_shell|[/]chromium[/]chrome|chrome\b/.test(flat);
      if (!isChromium) continue;
      if (flat.includes(PROFILE) || flat.includes(`--remote-debugging-port=${PORT}`)) pids.push(Number(ent));
    }
  } catch (_) {}
  return pids;
}

function killStaleBrowsers() {
  for (const pid of staleBrowserPids()) {
    if (pid === process.pid) continue;
    try { process.kill(pid, "SIGKILL"); } catch (_) {}
  }
}

// Drop Chromium's singleton lock left behind by a killed instance, otherwise a
// fresh browser refuses to adopt the profile and silently dies.
function clearSingletonLock() {
  for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try { fs.unlinkSync(path.join(PROFILE, f)); } catch (_) {}
  }
}

// A browser is only reusable if we can open a CDP socket AND get a real answer
// (not just an HTTP 200 on /json/version, which a wedged browser still serves).
async function browserHealthy() {
  let ws = null;
  try {
    const v = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!v.ok) return false;
    const j = await v.json();
    if (!j || !j.webSocketDebuggerUrl) return false;
    ws = await Promise.race([
      openWs(j.webSocketDebuggerUrl),
      new Promise((_, rej) => setTimeout(() => rej(new Error("ws-timeout")), 2000)),
    ]);
    await Promise.race([
      cdp(ws, "Browser.getVersion", {}),
      new Promise((_, rej) => setTimeout(() => rej(new Error("cdp-timeout")), 2500)),
    ]);
    return true;
  } catch (_) {
    return false;
  } finally {
    if (ws) { try { ws.close(); } catch (_) {} }
  }
}
async function proxyAlive() {
  try { const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/`, { signal: AbortSignal.timeout(800) }); return r.ok; } catch (_) { return false; }
}
function startProxy() {
  if (proxyProc) return;
  try {
    proxyProc = spawn(NODE, [path.join(import.meta.dirname, "waf_proxy.mjs")], { detached: true, stdio: "ignore", env: { ...process.env, WAF_PROXY_PORT: String(PROXY_PORT) } });
    proxyProc.unref();
  } catch (_) {}
}
// Reference-style real-browser UA (Edge, matching the proven cpquery_proxy.js).
// The WAF rejects a non-Edge UA (returns 400), so we must use the Edge string.
const REAL_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0";
const REAL_META = { brands: [{ brand: "Chromium", version: "151" }, { brand: "Not_A Brand", version: "24" }, { brand: "Google Chrome", version: "151" }], fullVersionList: [{ brand: "Chromium", version: "151.0.0.0" }, { brand: "Not_A Brand", version: "24.0.0.0" }, { brand: "Google Chrome", version: "151.0.0.0" }], platform: "Windows", platformVersion: "10.0.0", architecture: "x86", model: "", wow64: false, mobile: false, bitness: "64", formFactors: ["Desktop"] };

// Inject before ANY page script: erase every headless/automation tell.
const STEALTH = `(() => {
  const noop = () => {};
  const def = (obj, prop, val) => { try { Object.defineProperty(obj, prop, { get: () => val, configurable: true }); } catch (e) {} };
  def(Navigator.prototype, 'webdriver', false);
  def(Navigator.prototype, 'platform', 'Win32');
  def(Navigator.prototype, 'hardwareConcurrency', 8);
  def(Navigator.prototype, 'deviceMemory', 8);
  def(Navigator.prototype, 'maxTouchPoints', 0);
  def(Navigator.prototype, 'languages', ['zh-CN', 'zh', 'en-US', 'en']);
  def(Navigator.prototype, 'language', 'zh-CN');
  if (!window.chrome) { try { window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}), app: {} }; } catch (e) {} }
  try {
    const mk = (name, file, type) => ({ name, filename: file, description: name, length: 1, '0': { type, suffixes: 'pdf', description: name, enabledPlugin: null } });
    const plugins = [ mk('Chrome PDF Plugin', 'internal-pdf-viewer', 'application/pdf'), mk('Chrome PDF Viewer', 'mhjfbmdgcfjbbpaeojkl', 'application/pdf'), mk('Native Client', 'ppapi', 'application/x-nacl') ];
    const mt = [{ type: 'application/pdf', subtypes: [], description: 'Portable Document Format', enabledPlugin: { name: 'Chrome PDF Plugin' } }, { type: 'application/x-google-chrome-pdf', subtypes: [], description: '', enabledPlugin: {} }];
    const plugArr = plugins.slice(); plugArr.item = (i) => plugArr[i]; plugArr.namedItem = (n) => plugins.find(p => p.name === n); plugArr.refresh = noop;
    const mtArr = mt.slice(); mtArr.item = (i) => mtArr[i]; mtArr.namedItem = (n) => mt.find(m => m.type === n);
    def(Navigator.prototype, 'plugins', plugArr);
    def(Navigator.prototype, 'mimeTypes', mtArr);
  } catch (e) {}
  try {
    const VENDOR = 0x9245, RENDERER = 0x9246;
    const spoofV = 'Google Inc. (NVIDIA)', spoofR = 'NVIDIA GeForce RTX 3060/PCIe/SSE2';
    for (const Ctx of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!Ctx) continue;
      const g = Ctx.prototype.getParameter;
      Ctx.prototype.getParameter = function (p) { if (p === VENDOR) return spoofV; if (p === RENDERER) return spoofR; return g.call(this, p); };
    }
  } catch (e) {}
  try {
    def(screen, 'width', 1920); def(screen, 'height', 1080);
    def(screen, 'availWidth', 1920); def(screen, 'availHeight', 1080);
    def(screen, 'colorDepth', 24); def(screen, 'pixelDepth', 24);
  } catch (e) {}
})();`;

function spawnBrowser() {
  const args = ["--no-sandbox","--disable-gpu","--in-process-gpu","--no-first-run","--disable-dev-shm-usage","--disable-blink-features=AutomationControlled","--window-size=1920,1080","--force-color-profile=srgb","--lang=zh-CN","--accept-lang=zh-CN","--user-data-dir=" + PROFILE,"--remote-debugging-port=" + PORT,"about:blank"];
  const benv = { ...process.env, HOME: os.homedir(), TMPDIR: TMP, XDG_RUNTIME_DIR: PROFILE }; delete benv.LD_PRELOAD; delete benv.LD_LIBRARY_PATH;
  try { fs.mkdirSync(PROFILE, { recursive: true }); const c = spawn(CHROME, args, { detached: true, stdio: "ignore", env: benv }); c.unref(); } catch (_) {}
}
async function ensureBrowser() {
  if (process.env.XCP_PROXY && !(await proxyAlive())) { startProxy(); for (let i = 0; i < 40; i++) { await sleep(250); if (await proxyAlive()) break; } }
  // Reuse ONLY a browser we can actually drive.  A wedged/foreign listener on
  // PORT is reclaimed instead of being trusted (see staleBrowserPids above).
  if (await portAlive()) {
    if (await browserHealthy()) return;
    // Listener exists but is unusable -> reclaim port + profile, then respawn.
    killStaleBrowsers();
    clearSingletonLock();
    for (let i = 0; i < 20; i++) { await sleep(250); if (!(await portAlive())) break; }
    if (await portAlive()) { killStaleBrowsers(); clearSingletonLock(); await sleep(1000); }
  } else {
    // No listener: make sure no orphan still holds the profile lock.
    clearSingletonLock();
  }
  if (starting) return starting;
  starting = (async () => {
    spawnBrowser();
    for (let i = 0; i < 60; i++) { await sleep(500); if (await portAlive() && (await browserHealthy())) return; }
    throw new Error("chromium 未能启动");
  })();
  try { await starting; } finally { starting = null; }
}
async function applyRealUA(ws) {
  // Mimic `--user-agent=` (string only, no client-hint metadata) to match the
  // proven reference behavior; the WAF keys off the Edge UA string.
  await cdp(ws, "Emulation.setUserAgentOverride", { userAgent: REAL_UA }).catch(() => {});
}
async function applyStealth(ws) {
  await cdp(ws, "Page.addScriptToEvaluateOnNewDocument", { source: STEALTH }).catch(() => {});
}
async function getTabs() { return (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); }
async function newTab(url) { return (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json(); }
export function cdp(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMsg = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (_) { return; } if (m.id === id) { ws.removeEventListener("message", onMsg); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } };
    ws.addEventListener("message", onMsg); ws.send(JSON.stringify({ id, method, params }));
  });
}
function openWs(url) { return new Promise((res, rej) => { const w = new WebSocket(url); w.onopen = () => res(w); w.onerror = rej; }); }
async function safeEval(ws, expression, awaitPromise = false) {
  try { const ev = await cdp(ws, "Runtime.evaluate", { expression, awaitPromise, returnByValue: true }); return ev.result && ev.result.value; } catch (_) { return undefined; }
}

// The WAF is fully solved once waf.js has written the WP + WO clearance
// cookies.  (enable_* is an internal transient marker that is not always
// emitted on this kernel, so we don't wait for it.)
async function hasWafSolved(ws) {
  try {
    const r = await cdp(ws, "Network.getAllCookies", {});
    const names = new Set((r.cookies || []).map((c) => c.name));
    return names.has(PREFIX + "WP") && names.has(PREFIX + "WO");
  } catch (_) { return false; }
}

// Solve on a given tab: clear cookies, navigate, let waf.js run, poll for WP.
async function solveOnTab(ws) {
  await cdp(ws, "Network.clearBrowserCookies", {}).catch(() => {});
  await cdp(ws, "Page.navigate", { url: TARGET }).catch(() => {});
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await sleep(500);
    if (await hasWafSolved(ws)) return true;
  }
  return false;
}

// Get or create the resident tab (about:blank or cpquery) and its CDP socket.
export async function getResidentWs() {
  await ensureBrowser();
  let page = null;
  try {
    const tabs = await getTabs();
    page = tabs.find((t) => t.type === "page" && (t.url === "about:blank" || t.url.startsWith(TARGET))) || tabs[0];
  } catch (_) {}
  if (!page) page = await newTab("about:blank");
  const ws = await openWs(page.webSocketDebuggerUrl);
  await cdp(ws, "Page.enable", {}).catch(() => {});
  await cdp(ws, "Network.enable", {}).catch(() => {});
  // 必须去掉默认 UA 里的 HeadlessChrome 无头标识（并同步 client hints，否则自相矛盾更可疑）。
  // 其余 stealth 默认关闭，避免过度伪装导致指纹不一致。
  await applyRealUA(ws);
  if (process.env.XCP_STEALTH) { await applyStealth(ws); }
  return ws;
}

export async function solveWafResident(ssoCookies = null) {
  // Open the resident browser, optionally inject SSO/OAuth session cookies
  // FIRST (so the WAF clearance is bound to that session), then drive the
  // 瑞数 WAF to clearance.  Returns the open WebSocket (NOT closed) so the
  // caller can immediately reuse the validated session for the token exchange.
  const ws = await getResidentWs();
  if (ssoCookies && ssoCookies.length) {
    for (const c of ssoCookies) {
      if (!c || !c.name) continue;
      const dom = (c.domain || "cpquery.cponline.cnipa.gov.cn").replace(/^\./, "");
      const url = "https://" + (dom.includes(".") ? dom : "cpquery.cponline.cnipa.gov.cn");
      await cdp(ws, "Network.setCookie", { name: c.name, value: c.value, url, path: "/" }).catch(() => {});
    }
  }
  if (!(await hasWafSolved(ws))) await solveOnTab(ws);
  return ws;
}

export async function loginWithCode(code, ssoCookies = [], wsArg = null) {
  // Solve the 瑞数 WAF in the resident real browser (root page), then exchange
  // the SSO `code` for a JWT via an in-browser fetch to /auth/token.  The
  // browser-computed WP is valid for this session; credentials:include sends the
  // WAF + injected SSO cookies.  If `wsArg` is supplied (already solved), it is
  // reused directly so the `code` is not aged before the POST.
  const ws = wsArg || (await getResidentWs());
  const D = !!process.env.XCP_DEBUG;
  try {
    if (!wsArg && !(await hasWafSolved(ws))) await solveOnTab(ws);
    if (!(await hasWafSolved(ws))) await solveOnTab(ws);
    for (const c of ssoCookies || []) {
      if (!c || !c.name) continue;
      const dom = (c.domain || "cpquery.cponline.cnipa.gov.cn").replace(/^\./, "");
      const url = "https://" + (dom.includes(".") ? dom : "cpquery.cponline.cnipa.gov.cn");
      await cdp(ws, "Network.setCookie", { name: c.name, value: c.value, url, path: "/" }).catch(() => {});
    }
    const ckAll = await cdp(ws, "Network.getAllCookies", {}).catch(() => ({ cookies: [] }));
    if (D) console.error("[login] cookies:", (ckAll.cookies || []).map((c) => c.name).join(",") || "(none)");
    const expr = `(async () => {
       try {
         const r = await fetch("/auth/token", {
           method: "POST",
           headers: { "Content-Type": "application/json", Accept: "application/json, text/plain, */*" },
           body: ${JSON.stringify(JSON.stringify({ code }))},
           credentials: "include",
           redirect: "follow"
         });
         const t = await r.text();
         return JSON.stringify({ status: r.status, body: t });
       } catch (e) { return JSON.stringify({ error: e.message }); }
     })()`;
    const run = async () =>
      JSON.parse((await cdp(ws, "Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result.value || "{}");
    let parsed = await run();
    if (D) console.error("[login] auth/token #1:", parsed.status, "\nBODY>>>", (parsed.body || "").slice(0, 800));
    if (parsed.status === 412 || (parsed.body && parsed.body.includes('cd="'))) {
      await solveOnTab(ws);
      parsed = await run();
      if (D) console.error("[login] auth/token #2:", parsed.status, "\nBODY>>>", (parsed.body || "").slice(0, 800));
    }
    if (parsed.error) throw new Error("auth/token 请求失败: " + parsed.error);
    const text = parsed.body || "";
    try {
      const j = JSON.parse(text);
      if (j && j.code === 200 && j.data) return j.data;
    } catch (_) {}
    throw new Error("auth/token 未返回 token: " + (parsed.status || "") + " " + text.slice(0, 200));
  } finally { if (!wsArg) { try { ws.close(); } catch (_) {} } }
}

// Reused CDP websocket across browserRequest calls so a recursive tree walk /
// multi-request flow doesn't open+close a new TCP/WebSocket (and re-resolve
// the WAF) on every single call.
let _reqWs = null;
async function getReqWs() {
  if (_reqWs) {
    try { const v = await cdp(_reqWs, "Page.getNavigationHistory", {}).catch(() => null); if (v) return _reqWs; } catch (_) { _reqWs = null; }
  }
  _reqWs = await getResidentWs();
  return _reqWs;
}

export async function browserRequest(method, urlPath, opts = {}) {
  const { body, headers = {}, binary = false } = opts;
  const ws = await getReqWs();
  const D = !!process.env.XCP_DEBUG;
  let sentToken = false;
  try {
    // Solve the 瑞数 WAF (cpquery-domain WP/WO) via the resident browser.
    let solved = await hasWafSolved(ws);
    if (!solved) await solveOnTab(ws);

    // Path portion of the target (for path-specific WAF re-solve).
    let urlPathPath = urlPath;
    try { urlPathPath = new URL(urlPath.startsWith("http") ? urlPath : TARGET + urlPath).pathname; } catch (_) {}

    // Node-side fetch (proven in cpquery.js): inject the WAF cookie header +
    // Referer + UA so the request is accepted.  Carrying the WAF clearance in a
    // header avoids the CORS/domain pitfall of an in-page fetch.
    const doFetch = async (forceResolve) => {
      const cookieHeader = await fullCookieHeader(ws, { forceResolve, apiPath: urlPathPath });
      const url = urlPath.startsWith("http") ? urlPath : TARGET + urlPath;
      if (D) console.error("[req] cookieCount=", (cookieHeader.match(/=/g) || []).length, "len=", (cookieHeader || "").length, "url:", url);
      const token = await browserEval(ws, () => { try { return localStorage.getItem("ACCESS_TOKEN"); } catch (e) { return null; } }).catch(() => null);
      sentToken = !!token;
      const h = {
        "User-Agent": REAL_UA,
        "Accept": "application/json, text/plain, */*",
        "Referer": TARGET + "/",
        "Cookie": cookieHeader,
      };
      if (token) h["Authorization"] = "Bearer " + token;
      for (const [k, v] of Object.entries(headers)) h[k] = v;
      if (method === "POST") h["Content-Type"] = "application/json";
      const resp = await fetch(url, {
        method,
        headers: h,
        body: method === "POST" ? (body !== undefined && body !== null ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined) : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(25000),
      });
      let b;
      if (binary) { const buf = Buffer.from(await resp.arrayBuffer()); b = buf.toString("base64"); }
      else b = await resp.text();
      const rh = {};
      try { for (const [k, v] of resp.headers.entries()) rh[k] = v; } catch (_) {}
      return { status: resp.status, contentType: resp.headers.get("content-type") || "", url: resp.url, body: b, responseHeaders: rh };
    };

    let res = await doFetch(false);
    if (res.status === 412 || (typeof res.body === "string" && res.body.includes('cd="'))) {
      // A 412 means the reused WP is stale on the server side: force a fresh
      // re-solve (delete WP, re-navigate, let waf.js write a new one), then retry.
      res = await doFetch(true);
    }
    // 401 but no valid token sent → session stale.  Refresh WAF+SSO session
    // once and retry.  (The session token lives in index.js scope, so the
    // decision to re-login lives there; here we only refresh WAF/session when
    // the request carried no Authorization token.)
    if (res.status === 401 && !sentToken) {
      if (D) console.error("[xcp] 401 with no token → refresh WAF session and retry");
      await solveWafResident(); // re-establish WAF + SSO session
      res = await doFetch(false);
    }
    return res;
  } finally { /* keep _reqWs open for reuse */ }
}

export async function browserCookies() {
  await ensureBrowser();
  const tabs = await getTabs();
  const page = tabs.find((t) => t.type === "page");
  if (!page) return [];
  const ws = await openWs(page.webSocketDebuggerUrl);
  try { const r = await cdp(ws, "Network.getAllCookies", {}); return (r.cookies || []).filter((c) => c.domain && c.domain.includes("cpquery")); }
  finally { try { ws.close(); } catch (_) {} }
}

// Return the FULL cpquery-domain cookie header.  The 瑞数 WAF clearance (WP)
// is short-lived and must be FRESHLY computed by the resident browser loading
// the cpquery home page — a WP carried over from the SSO/login flow (or an old
// session) is rejected by the API (server deletes WP + 400).  So we force a
// re-solve: delete the stale WP, navigate home, wait for waf.js to write a new
// WP, then forward the whole jar (WAF clearance + SSO session cookies).
// Cached for 5 minutes so a recursive tree walk / multi-call flow doesn't
// re-solve the 瑞数 WAF on every node.  Each re-solve is a headless-Chromium
// navigation costing seconds, so long cache reuse is the single biggest win.
let _wafCache = { at: 0, header: "" };
const WAF_CACHE_MS = 5 * 60 * 1000;

// Build the cookie header from the CURRENT browser jar (no navigation, no WAF
// re-solve).  Cheap and called on the hot path.
async function cookieHeaderFromJar(ws) {
  const ck = await cdp(ws, "Network.getAllCookies", {}).catch(() => ({ cookies: [] }));
  const parts = (ck.cookies || [])
    .filter((c) => c.domain && (c.domain.includes("cpquery") || c.domain.includes("cponline") || c.domain.includes("cnipa")))
    .map((c) => `${c.name}=${c.value}`);
  return parts.join("; ");
}

// Re-solve the WAF by deleting the stale WP and re-navigating, then poll until
// waf.js writes a NEW WP.  CRITICAL: the 瑞数 WP is ISSUED PER-PATH — a WP
// computed on the homepage "/" does NOT satisfy every API path (verified:
// `/api/view/gn/fetch-file-infos` returns 412 with the home WP but 200 after
// navigating that exact path).  So when apiPath is given (the pure pathname of
// the endpoint that 412'd), we navigate THERE so waf.js computes a challenge
// valid for it.  We only navigate a PURE pathname (no query string) — navigating
// a full signed `fetch-file?...` URL does NOT run waf.js and would hang 30s.
// Fall back to home when no apiPath.  Returns true on success.
async function resolveWaf(ws, apiPath) {
  const ck0 = await cdp(ws, "Network.getAllCookies", {}).catch(() => ({ cookies: [] }));
  const oldWp = (ck0.cookies || []).find((c) => c.name === PREFIX + "WP");
  const oldVal = oldWp ? oldWp.value : null;
  await cdp(ws, "Network.deleteCookies", { name: PREFIX + "WP", url: TARGET }).catch(() => {});
  const navUrl = apiPath && apiPath !== "/" && !/[?&#]/.test(apiPath) ? TARGET + apiPath : TARGET + "/?" + Date.now();
  await cdp(ws, "Page.navigate", { url: navUrl }).catch(() => {});
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await sleep(400);
    const ck = await cdp(ws, "Network.getAllCookies", {}).catch(() => ({ cookies: [] }));
    const wp = (ck.cookies || []).find((c) => c.name === PREFIX + "WP");
    const wo = (ck.cookies || []).find((c) => c.name === PREFIX + "WO");
    if (wp && wo && wp.value !== oldVal) return true;
  }
  return false;
}

export async function fullCookieHeader(wsArg, { forceResolve = false, apiPath = null } = {}) {
  const ws = wsArg || (await getResidentWs());
  try {
    const now = Date.now();
    // B) Prefer a still-fresh cached header (try existing WP directly).
    if (!forceResolve && now - _wafCache.at < WAF_CACHE_MS && _wafCache.header)
      return _wafCache.header;
    // If the jar already has a WP/WO pair and it's not stale, reuse it instead
    // of forcing a re-solve — only resolve when forced (e.g. after a 412).
    if (!forceResolve) {
      const ck = await cdp(ws, "Network.getAllCookies", {}).catch(() => ({ cookies: [] }));
      const names = new Set((ck.cookies || []).map((c) => c.name));
      if (names.has(PREFIX + "WP") && names.has(PREFIX + "WO")) {
        const header = await cookieHeaderFromJar(ws);
        if (header) { _wafCache = { at: Date.now(), header }; return header; }
      }
    }
    const ok = await resolveWaf(ws, apiPath);
    if (!ok) throw new Error("WAF 未解出（刷新 WP 失败）");
    const header = await cookieHeaderFromJar(ws);
    if (!header) throw new Error("WAF 未解出（无 cookie）");
    _wafCache = { at: Date.now(), header };
    return header;
  } finally { if (!wsArg) { try { ws.close(); } catch (_) {} } }
}

export async function stopBrowser() {
  try { const tabs = await getTabs(); for (const t of tabs) { try { await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`, { method: "PUT" }); } catch (_) {} } } catch (_) {}
  try { if (proxyProc) { proxyProc.kill("SIGKILL"); proxyProc = null; } } catch (_) {}
}

// Solve the 瑞数 WAF for a SPECIFIC endpoint (navigate there so waf.js computes
// the clearance cookie for that exact challenge) and return the WO/WP/enable_
// cookie header.  Different endpoints issue different challenges, so the WP for
// "/" will NOT satisfy /auth/token — this computes the right one.
export async function wafCookieHeaderFor(apiPath) {
  const ws = await getResidentWs();
  try {
    let solved = await hasWafSolved(ws);
    if (!solved) {
      await cdp(ws, "Page.navigate", { url: TARGET + apiPath }).catch(() => {});
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        await sleep(500);
        if (await hasWafSolved(ws)) { solved = true; break; }
      }
    }
    if (!solved) throw new Error("WAF 未解出（" + apiPath + "）");
    const ck = await cdp(ws, "Network.getAllCookies", {}).catch(() => ({ cookies: [] }));
    const parts = (ck.cookies || [])
      .filter((c) => c.name === PREFIX + "WO" || c.name === PREFIX + "WP" || c.name === ENABLE)
      .map((c) => `${c.name}=${c.value}`);
    return parts.join("; ");
  } finally { try { ws.close(); } catch (_) {} }
}

// --- browser-driven full login (pure driver: the real browser runs the entire
//     SSO + captcha + WAF + token flow, so the SSO session and the WAF
//     clearance live in ONE browser session — no cross-session mismatch) -------

export async function browserEval(ws, fn, ...args) {
  const expr = "(" + fn.toString() + ")(" + args.map((a) => JSON.stringify(a)).join(",") + ")";
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try {
      const ev = await cdp(ws, "Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (ev && ev.result && ev.result.subtype === "error") throw new Error(ev.result.description || String(ev.result.value));
      return ev && ev.result ? ev.result.value : undefined;
    } catch (e) {
      lastErr = e;
      if (/navigated|closed|Execution context|context destroyed/i.test(e.message)) { await sleep(400); continue; }
      throw e;
    }
  }
  throw lastErr;
}

async function inpageFetch(method, url, body) {
  try {
    const resp = await fetch(url, {
      method,
      headers: { "content-type": "application/json", accept: "application/json, text/plain, */*" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "include",
      redirect: "follow",
    });
    let b;
    try { b = await resp.json(); } catch (e) { try { b = await resp.text(); } catch (e2) { b = ""; } }
    return { status: resp.status, url: resp.url, body: b };
  } catch (e) { return { error: e.message }; }
}

// Clear ONLY the cpquery-domain cookies and reload, so waf.js re-computes a
// fresh WP — while the tysf SSO session (separate domain) is preserved, which
// means no re-login is needed.
async function refreshWaf(ws) {
  invalidateWafCache();
  const ck = await cdp(ws, "Network.getAllCookies", {}).catch(() => ({ cookies: [] }));
  for (const c of ck.cookies || []) {
    if (c.domain && c.domain.includes("cpquery")) {
      await cdp(ws, "Network.deleteCookies", { name: c.name, domain: c.domain, path: c.path || "/" }).catch(() => {});
    }
  }
  await cdp(ws, "Page.reload", {}).catch(() => {});
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { await sleep(500); if (await hasWafSolved(ws)) break; }
}

export function invalidateWafCache() {
  _wafCache = { at: 0, header: "" };
}

export async function browserLogin(username, password, helpers) {
  const ws = await getResidentWs();
  const D = !!process.env.XCP_DEBUG;
  const fetchIn = (method, url, body) => browserEval(ws, inpageFetch, method, url, body);
  // Capture the SPA's own /auth/token request so we can replicate its exact shape.
  const spaReqs = [];
  try {
    await cdp(ws, "Network.enable", {});
    ws.on("message", (raw) => {
      try {
        const m = JSON.parse(raw);
        if (m.method === "Network.requestWillBeSent") {
          const u = m.params.request.url;
          if (u.includes("/auth/token") || u.includes("/oauth") || u.includes("token")) {
            spaReqs.push({ url: u, method: m.params.request.method, headers: m.params.request.headers, postData: m.params.request.postData });
            if (D) console.error("[net] capture:", m.params.request.method, u, "post=", m.params.request.postData, "ct=", (m.params.request.headers || {})["content-type"]);
          }
        }
      } catch (e) {}
    });
  } catch (e) {}
  try {
    // Top-level navigation to the SSO authorize URL (real flow): the browser
    // follows the 302 to the tysf login page, landing on the tysf origin so all
    // subsequent SSO requests are same-origin (no CORS).  waf.js auto-clears
    // each domain as the page loads.
    await cdp(ws, "Page.navigate", { url: SSO_AUTH }).catch(() => {});

    const waitForCode = async (ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        await sleep(1000);
        const href = (await browserEval(ws, () => location.href).catch(() => "")) || "";
        const m = href.match(/[?&]code=([^&]+)/);
        if (m) return m[1];
      }
      return null;
    };

    let code = await waitForCode(15000);
    if (D) console.error("[login] SSO 导航后 code=", code, "href=", (await browserEval(ws, () => location.href).catch(() => "")) || "");

    if (!code) {
      // Fresh profile: need to drive the tysf login form in-browser.
      if (!(await hasWafSolved(ws))) await solveOnTab(ws);
      const lp = await fetchIn("GET", TYF + "/login");
      const tmpl = lp.body && lp.body.data;
      if (!tmpl) throw new Error("tysf /login 未返回模板: " + JSON.stringify(lp).slice(0, 200));
      const rk = (await fetchIn("POST", TYF + "/auth/getRandomCode", {})).body.data;

      let ver = null;
      for (let i = 0; i < 10; i++) {
        const c = await fetchIn("POST", TYF + "/captcha/get", { captchaType: "blockPuzzle" });
        const cd = c.body && c.body.repData;
        if (!cd) { if (D) console.error("[login] captcha 无数据", JSON.stringify(c).slice(0, 200)); continue; }
        let orig = cd.originalImageBase64, jig = cd.jigsawImageBase64;
        if (orig.startsWith("data:")) orig = orig.split(",", 1)[1];
        if (jig.startsWith("data:")) jig = jig.split(",", 1)[1];
        const { x } = helpers.detectGap(orig, jig);
        const pj = JSON.stringify({ x, y: 5 });
        const chk = await fetchIn("POST", TYF + "/captcha/check", { captchaType: "blockPuzzle", pointJson: pj, token: cd.token });
        if (chk.body && chk.body.repCode === "0000") { ver = cd.token + "---" + pj; break; }
        if (D) console.error("[login] captcha try", i, chk.body && chk.body.repCode);
      }
      if (!ver) throw new Error("滑块验证码识别/校验失败");

      const enc = helpers.encryptPassword(password, rk);
      const cb = tmpl.callbackVOList;
      cb[0].callback.loginName = username;
      cb[1].callback.password = enc;
      cb[2].callback.selectedKey = "1";
      cb[3].callback.validateCode = ver;
      const lr = await fetchIn("POST", TYF + "/login", tmpl);
      const ru = lr.body && lr.body.data && lr.body.data.callback && lr.body.data.callback.redirectURL;
      if (!ru) throw new Error("tysf 登录未返回 redirectURL: " + JSON.stringify(lr.body).slice(0, 200));
      const ru2 = ru.startsWith("//") ? "https:" + ru : ru;
      // Top-level navigation back to cpquery?code= (cross-origin hops followed
      // natively by the browser, no CORS issue).
      await cdp(ws, "Page.navigate", { url: ru2 }).catch(() => {});
      code = await waitForCode(30000);
    }
    if (!code) throw new Error("未从 cpquery 回调拿到 code");
    if (D) console.error("[login] code=", code);

    // cpquery-domain WAF is cleared by waf.js on load; ensure clearance is ready.
    if (!(await hasWafSolved(ws))) await solveOnTab(ws);
    // Give waf.js a beat to finish, then exchange the code IMMEDIATELY — the SSO
    // `code` is single-use and short-TTL, so we must not wait around for the SPA.
    await sleep(500);

    const exchangeToken = async () => {
      // The SPA exchanges the single-use `code` itself and navigates while doing
      // so, which ABORTS this in-flight in-page fetch -> "Failed to fetch".
      // That abort is transient and unrelated to the token, so retry a few times
      // instead of letting the whole login die on it.
      for (let attempt = 0; attempt < 3; attempt++) {
        let tk = null;
        try {
          tk = await fetchIn("POST", TARGET + "/auth/token", { code });
        } catch (e) {
          if (D) console.error("[login] /auth/token fetch aborted (attempt", attempt, "):", (e && e.message) || String(e));
          await sleep(800);
          continue;
        }
        let data = tk && tk.body;
        const failedToFetch = typeof data === "string" && /Failed to fetch/i.test(data);
        if (D) console.error("[login] /auth/token:", tk && tk.status, JSON.stringify(tk && tk.body == null ? tk : tk.body).slice(0, 300));
        if (failedToFetch) { await sleep(800); continue; }
        if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) {} }
        if (data && data.code === 200 && data.data) return data.data;
        return null;
      }
      return null;
    };

    // Prefer reading the JWT the SPA already stored (it may have exchanged first);
    // fall back to exchanging ourselves right away.
    const readToken = async () => {
      const r = await browserEval(ws, () => {
        try {
          const out = {};
          for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); out[k] = localStorage.getItem(k); }
          out.__cookie = document.cookie || "";
          return out;
        } catch (e) { return { __err: e.message }; }
      }).catch((e) => ({ __err: e.message }));
      const jwt = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
      for (const v of Object.values(r || {})) {
        if (typeof v === "string" && jwt.test(v.trim())) return v.trim();
      }
      return null;
    };

    let token = await readToken();
    if (!token) {
      // The SPA auto-exchanges the (single-use) `code` on load.  Poll for the
      // JWT it stores; only as a last resort call /auth/token ourselves (which
      // would otherwise race the SPA and burn the single-use code -> 70003).
      const tEnd = Date.now() + 18000;
      while (Date.now() < tEnd && !token) { await sleep(1000); token = await readToken(); }
    }
    if (!token) {
      // The SPA may have hit the WAF (412) at boot and stored a failed result.
      // Reload: waf.js is now cached, so the SPA's re-exchange should have WAF
      // clearance ready and succeed.
      const hadWafErr = await browserEval(ws, () => {
        try { const x = localStorage.getItem("__xcpLogin"); return !!(x && /412/.test(x)); } catch (e) { return false; }
      }).catch(() => false);
      if (hadWafErr) {
        if (D) console.error("[login] SPA 此前 412，重载页面重试换码");
        await cdp(ws, "Page.reload", {}).catch(() => {});
        const tEnd2 = Date.now() + 15000;
        while (Date.now() < tEnd2 && !token) { await sleep(1000); token = await readToken(); }
      }
    }
    if (!token) token = await exchangeToken();
    if (!token && D) {
      const dump = await browserEval(ws, () => {
        const ls = {};
        try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = localStorage.getItem(k); } } catch (e) {}
        return { ls, cookie: document.cookie || "", href: location.href };
      }).catch((e) => ({ err: e.message }));
      console.error("[login] 存储 dump:", JSON.stringify(dump).slice(0, 1200));
    }
    if (token) {
      await browserEval(ws, (t) => { try { localStorage.setItem("ACCESS_TOKEN", t); } catch (e) {} }, token).catch(() => {});
      return token;
    }
    if (D && spaReqs.length) console.error("[login] SPA /auth/token 请求:", JSON.stringify(spaReqs[0]).slice(0, 800));
    throw new Error("auth/token 失败（已尝试立即换码 + 读取 SPA 存储）");
  } finally { /* keep resident ws open for data calls */ }
}
