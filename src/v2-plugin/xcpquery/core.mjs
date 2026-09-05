import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { browserRequest, loginWithCode, wafCookieHeaderFor, solveWafResident, browserLogin, invalidateWafCache, getResidentWs, browserEval } from "./cjs/browser.mjs";

// Minimal PNG decoder using only Node built-ins (no third-party deps).
// Supports 8-bit, non-interlaced PNG; always returns RGBA (4 bytes/pixel).
function decodePng(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (
    buf.length < 8 ||
    buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47
  )
    throw new Error("decodePng: not a PNG");
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); off += 4;
    const type = buf.toString("ascii", off, off + 4); off += 4;
    const data = buf.subarray(off, off + len); off += len;
    off += 4; // skip CRC
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  if (bitDepth !== 8) throw new Error("decodePng: only 8-bit PNG (got " + bitDepth + ")");
  if (interlace !== 0) throw new Error("decodePng: interlaced PNG unsupported");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error("decodePng: unsupported colorType " + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels; // 8-bit
  const stride = width * bpp;
  const out = new Uint8Array(width * height * 4);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  };
  let pos = 0;
  const prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[pos++];
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) cur[i] = raw[pos++];
    const recon = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? recon[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v;
      switch (ft) {
        case 0: v = cur[i]; break;
        case 1: v = cur[i] + a; break;
        case 2: v = cur[i] + b; break;
        case 3: v = cur[i] + ((a + b) >> 1); break;
        case 4: v = cur[i] + paeth(a, b, c); break;
        default: throw new Error("decodePng: bad filter " + ft);
      }
      recon[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const di = (y * width + x) * 4;
      const si = x * bpp;
      let r, g, bl, al;
      if (colorType === 0) { const v = recon[si]; r = g = bl = v; al = 255; }
      else if (colorType === 2) { r = recon[si]; g = recon[si + 1]; bl = recon[si + 2]; al = 255; }
      else if (colorType === 3) { const v = recon[si]; r = g = bl = v; al = 255; }
      else if (colorType === 4) { const v = recon[si]; al = recon[si + 1]; r = g = bl = v; }
      else { r = recon[si]; g = recon[si + 1]; bl = recon[si + 2]; al = recon[si + 3]; }
      out[di] = r; out[di + 1] = g; out[di + 2] = bl; out[di + 3] = al;
    }
    prev.set(recon);
  }
  return { width, height, data: out };
}

const __dir = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.join(__dir, ".session_cache.json");
const WAF_RUNNER = path.join(__dir, "cjs", "waf_runner.js");
const WAF_CDP = path.join(__dir, "cjs", "waf_cdp.js");
const STR_ENC = path.join(__dir, "cjs", "str_enc.js");

// Configurable Node binary for the WAF/password sub-processes. Defaults to the
// bare "node" on PATH. Override via XCP_WAF_NODE (absolute path or name on PATH)
// to run the anti-bot solver under a specific Node build.
//
// On termux the system Node is fine for waf.js, but the OpenCode process may not
// have "node" on its PATH when spawning the sub-process, so fall back to a list
// of well-known absolute paths before giving up on the bare "node" name.
function resolveWafNode() {
  if (process.env.XCP_WAF_NODE) return process.env.XCP_WAF_NODE;
  const candidates = [
    "/data/data/com.termux/files/usr/bin/node",
    "/data/data/com.termux/files/usr/local/bin/node",
    "/usr/bin/node",
    "/usr/local/bin/node",
    process.execPath,
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return "node";
}
const WAF_NODE = resolveWafNode();

const SSO =
  "https://sso.cponline.cnipa.gov.cn/oauth/authorize?response_type=code&scope=openid&client_id=public-inquiry&redirect_uri=https://cpquery.cponline.cnipa.gov.cn";
const TYF = "https://tysf.cponline.cnipa.gov.cn/am";
const CPQUERY = "https://cpquery.cponline.cnipa.gov.cn";
const WP_DOMAIN = ".cpquery.cponline.cnipa.gov.cn";

const UA =
  "python-requests/2.32.3";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Cookie jar (domain-aware, single shared store)
// ---------------------------------------------------------------------------
const jar = new Map(); // name -> { value, domain }
function normalizeDomain(d) {
  if (!d) return "";
  d = d.toLowerCase();
  if (d.startsWith(".")) d = d.slice(1);
  return d;
}
function setCookie(name, value, domain) {
  jar.set(name, { value, domain: normalizeDomain(domain) });
}
function domainMatches(dom, host) {
  if (!dom) return true;
  dom = dom.toLowerCase();
  host = host.toLowerCase();
  return host === dom || host.endsWith("." + dom);
}
function cookieHeaderFor(host) {
  const parts = [];
  for (const [name, e] of jar) {
    if (domainMatches(e.domain, host)) parts.push(name + "=" + e.value);
  }
  return parts.join("; ");
}
function absorbCookies(resp, host) {
  const sc =
    typeof resp.headers.getSetCookie === "function"
      ? resp.headers.getSetCookie()
      : resp.headers.get("set-cookie")
      ? [resp.headers.get("set-cookie")]
      : [];
  for (const c of sc) {
    const idx = c.indexOf(";");
    const first = idx >= 0 ? c.slice(0, idx) : c;
    const eq = first.indexOf("=");
    if (eq < 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    let domain = "";
    const m = c.match(/domain=([^;]+)/i);
    if (m) domain = m[1].trim();
    setCookie(name, value, domain || host);
  }
}

// ---------------------------------------------------------------------------
// 412 WAF bypass (real headless Chromium via CDP — preferred)
// ---------------------------------------------------------------------------
function computeWpCookieCdp(url) {
  const out = spawnSync(WAF_NODE, [WAF_CDP, String(url)], {
    cwd: __dir,
    encoding: "utf8",
    timeout: 90000,
    windowsHide: true,
  });
  for (const line of (out.stdout || "").split("\n")) {
    if (line.startsWith("BARECOOKIE|"))
      return line.slice("BARECOOKIE|".length).trim();
  }
  throw new Error(
    "waf_cdp failed: " + ((out.stderr || "") + (out.stdout || "")).slice(-2000)
  );
}

// Legacy pure-vm solver (fallback when chromium is unavailable).
function computeWpCookie(cd, nsd) {
  const out = spawnSync(WAF_NODE, [WAF_RUNNER, String(cd), String(nsd)], {
    cwd: __dir,
    encoding: "utf8",
    timeout: 120000,
    windowsHide: true,
  });
  for (const line of (out.stdout || "").split("\n")) {
    if (line.startsWith("BARECOOKIE|"))
      return line.slice("BARECOOKIE|".length).trim();
  }
  throw new Error(
    "waf_runner failed: " + ((out.stderr || "") + (out.stdout || "")).slice(-2000)
  );
}
function absorbCookieHeader(hdr, domain) {
  for (const part of hdr.split(";")) {
    const p = part.trim();
    if (p.includes("=")) {
      const i = p.indexOf("=");
      setCookie(p.slice(0, i).trim(), p.slice(i + 1).trim(), domain);
    }
  }
}
function injectWp(text, host) {
  const cdm = text.match(/cd="([^"]+)"/);
  const nsdm = text.match(/nsd=(\d+)/);
  if (cdm && nsdm) {
    // Prefer the real-browser CDP solver; fall back to the vm solver.
    try {
      const hdr = computeWpCookieCdp("https://" + host + "/");
      absorbCookieHeader(hdr, WP_DOMAIN);
      return true;
    } catch (_) {
      try {
        const hdr = computeWpCookie(cdm[1], parseInt(nsdm[1], 10));
        absorbCookieHeader(hdr, WP_DOMAIN);
        return true;
      } catch (_) {
        return false;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Captcha (blockPuzzle) gap detection — pure JS via built-in zlib PNG decode + NCC template match
// ---------------------------------------------------------------------------
function detectGap(origB64, jigB64) {
  const orig = decodePng(Buffer.from(origB64, "base64"));
  const jig = decodePng(Buffer.from(jigB64, "base64"));
  const W = orig.width,
    H = orig.height,
    w = jig.width,
    h = jig.height;
  const og = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const r = orig.data[i * 4],
      g = orig.data[i * 4 + 1],
      b = orig.data[i * 4 + 2];
    og[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  const jg = new Float64Array(w * h);
  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = jig.data[i * 4],
      g = jig.data[i * 4 + 1],
      b = jig.data[i * 4 + 2];
    jg[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    alpha[i] = jig.data[i * 4 + 3];
  }
  const mask = [];
  for (let i = 0; i < w * h; i++) if (alpha[i] > 10) mask.push(i);
  let tsum = 0;
  for (const i of mask) tsum += jg[i];
  const tmean = tsum / mask.length;
  let tvar = 0;
  for (const i of mask) tvar += (jg[i] - tmean) ** 2;
  const tstd = Math.sqrt(tvar) || 1;
  let bestX = 0,
    bestY = 0,
    bestVal = -Infinity;
  for (let y = 0; y <= H - h; y++) {
    for (let x = 0; x <= W - w; x++) {
      let isum = 0;
      for (const i of mask) {
        const ix = x + (i % w);
        const iy = y + Math.floor(i / w);
        isum += og[iy * W + ix];
      }
      const imean = isum / mask.length;
      let num = 0,
        ivar = 0;
      for (const i of mask) {
        const ix = x + (i % w);
        const iy = y + Math.floor(i / w);
        const d = og[iy * W + ix] - imean;
        ivar += d * d;
        num += (jg[i] - tmean) * d;
      }
      const istd = Math.sqrt(ivar) || 1;
      const val = num / (tstd * istd);
      if (val > bestVal) {
        bestVal = val;
        bestX = x;
        bestY = y;
      }
    }
  }
  return { x: bestX, conf: bestVal };
}

// ---------------------------------------------------------------------------
// Auth state + session cache
// ---------------------------------------------------------------------------
let TOKEN = null;
let USERNAME = null;
let PASSWORD = null;

function saveSession() {
  try {
    const cookies = {};
    for (const [name, e] of jar) cookies[name] = { value: e.value, domain: e.domain };
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ token: TOKEN, cookies, ts: Date.now() }));
    try {
      fs.chmodSync(SESSION_FILE, 0o600);
    } catch (_) {}
  } catch (_) {}
}
function loadSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return false;
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
    if (Date.now() - data.ts > 12 * 3600 * 1000) return false;
    if (!data.token || !data.cookies) return false;
    TOKEN = data.token;
    for (const [name, c] of Object.entries(data.cookies)) setCookie(name, c.value, c.domain);
    return true;
  } catch (_) {
    return false;
  }
}

// Exchange the SSO `code` for a JWT.  POST /auth/token with the SSO/OAuth
// session cookies; on a 412 WAF challenge, solve that exact challenge in the
// real headless browser (waf.js computes the clearance cookie for /auth/token
// specifically) and retry.  Mirrors the proven reference, but uses the browser
// WAF solver (the vm solver is outdated for the current challenge here).
async function exchangeToken(code) {
  const url = CPQUERY + "/auth/token";
  const extra = {
    Referer: CPQUERY + "/",
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
  };
  const doPost = () => rawPostJson(url, { code }, { auth: false, extra });
  let resp = await doPost();
  // /auth/token needs a clearance computed for ITS OWN path.  After the WAF
  // cache was extended (5min reuse) the reused homepage WP is no longer
  // rejected with a 412 — the server now answers a plain 400 — so we must
  // retry on 400 as well, otherwise the route-specific re-solve never fires
  // and login dies with "auth/token: 400".
  if (resp.status === 412 || resp.status === 400) {
    if (process.env.XCP_DEBUG) console.error("[login]", resp.status, "-> 浏览器解出 /auth/token 专属 WP");
    const wp = await wafCookieHeaderFor("/auth/token");
    if (wp) {
      for (const part of wp.split(";")) {
        const eq = part.indexOf("=");
        if (eq < 0) continue;
        setCookie(part.slice(0, eq).trim(), part.slice(eq + 1).trim(), ".cpquery.cponline.cnipa.gov.cn");
      }
    }
    resp = await doPost();
  }
  const j = await resp.json().catch(() => ({}));
  if (j && j.code === 200 && j.data) return j.data;
  if (resp.status === 200 && j && j.data) return j.data;
  // Diagnostics for the failure.
  let raw = "";
  try { raw = await resp.clone().text(); } catch (_) {}
  const hdrs = {};
  try { for (const [k, v] of resp.headers.entries()) hdrs[k] = v; } catch (_) {}
  if (process.env.XCP_DEBUG) {
    console.error("[login] auth/token FAIL status", resp.status);
    console.error("[login] headers", JSON.stringify(hdrs).slice(0, 400));
    console.error("[login] body", raw.slice(0, 500));
    console.error("[login] jar cpquery cookies", [...jar.entries()].filter(([, c]) => (c.domain || "").includes("cpquery")).map(([n]) => n).join(","));
  }
  throw new Error("auth/token 未返回 token: " + resp.status + " " + JSON.stringify(j).slice(0, 200));
}

async function doLogin(username, password) {
  const D = !!process.env.XCP_DEBUG;
  // Pure-driver browser login: the real headless browser kernel runs the entire
  // SSO + slider-captcha + 瑞数 WAF + code→token flow in ONE session, so the
  // SSO session and the WAF clearance are naturally consistent.  Node only
  // helps compute the slider gap (detectGap) and the password encryption.
  if (D) console.error("[login] 启动纯驱动浏览器登录（SSO+滑块+WAF+token 全程浏览器）");
  const token = await browserLogin(username, password, {
    detectGap: (orig, jig) => detectGap(orig, jig),
    encryptPassword: (pw, rk) => {
      const r = spawnSync(WAF_NODE, [STR_ENC, pw, rk], { cwd: __dir, encoding: "utf8", timeout: 60000, windowsHide: true });
      return (r.stdout || "").trim();
    },
  });
  if (!token) throw new Error("auth/token 未返回 token");
  TOKEN = token;
  saveSession();
  return token;
}

function tokenExpired() {
  if (!TOKEN) return true;
  try {
    const seg = String(TOKEN).split(".")[1];
    if (!seg) return true;
    const pad = seg + "===".slice((seg.length + 3) % 4);
    const json = JSON.parse(Buffer.from(pad, "base64").toString("utf-8"));
    if (json.exp && Date.now() / 1000 > json.exp) return true;
  } catch (_) {
    return true;
  }
  return false;
}

async function ensureSession() {
  if (TOKEN && !tokenExpired()) return;
  if (loadSession() && !tokenExpired()) return;
  if (!USERNAME || !PASSWORD)
    throw new Error("请在插件配置或环境变量中设置 CNIPA_USERNAME / CNIPA_PASSWORD");
  await doLogin(USERNAME, PASSWORD);
}

// ---------------------------------------------------------------------------
// HTTP core
// ---------------------------------------------------------------------------
function _headersFor(url, auth, extra) {
  const u = new URL(url);
  const headers = {
    "User-Agent": UA,
    Accept: "*/*",
  };
  if (auth && TOKEN) headers["Authorization"] = "Bearer " + TOKEN;
  if (extra) Object.assign(headers, extra);
  const ck = cookieHeaderFor(u.host);
  if (ck) headers["Cookie"] = ck;
  return headers;
}

// Shared fetch: follows redirects MANUALLY so cookies set on every redirect hop
// are absorbed (mirrors requests.Session behavior), and handles the 412 WAF.
async function rawFetch(method, url, body, { auth = false, extra = {}, follow = true } = {}) {
  let cur = url;
  let m = method;
  let b = body;
  let hops = 0;
  while (true) {
    const headers = _headersFor(cur, auth, extra);
    if ((m === "POST" || m === "PUT") && !headers["Content-Type"])
      headers["Content-Type"] = "application/json";
    const init = { method: m, headers, redirect: "manual" };
    if (b !== null && (m === "POST" || m === "PUT")) init.body = b;
    let resp;
    try {
      resp = await fetch(cur, init);
    } catch (e) {
      throw e;
    }
    absorbCookies(resp, new URL(cur).host);
    if (follow && [301, 302, 303, 307, 308].includes(resp.status)) {
      const loc = resp.headers.get("location");
      if (!loc) return resp;
      if (process.env.XCP_DEBUG)
        console.error(`[redirect] ${resp.status} ${new URL(cur).host} -> ${loc}`);
      cur = new URL(loc, cur).href;
      if (++hops > 12) return resp;
      if (resp.status === 301 || resp.status === 302 || resp.status === 303) {
        m = "GET";
        b = null;
      }
      continue;
    }
    return resp;
  }
}

async function rawGet(url, { auth = false, extra = {} } = {}) {
  return rawFetch("GET", url, null, { auth, extra, follow: true });
}
async function rawPostJson(url, body, { auth = true, extra = {} } = {}) {
  return rawFetch("POST", url, JSON.stringify(body ?? {}), { auth, extra, follow: true });
}

async function cpqueryRequest(method, apiPath, params) {
  // All cpquery data APIs are behind 瑞数 → route through headless browser.
  for (let attempt = 0; attempt < 4; attempt++) {
    let fullPath = apiPath;
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/plain, */*" };
    if (TOKEN) headers["Authorization"] = "Bearer " + TOKEN;
    let res;
    try {
      if (method === "GET") {
        const qs = new URLSearchParams(params || {}).toString();
        fullPath = qs ? apiPath + "?" + qs : apiPath;
        res = await browserRequest("GET", fullPath, { headers });
      } else {
        res = await browserRequest("POST", fullPath, {
          body: JSON.stringify(params || {}),
          headers,
        });
      }
    } catch (e) {
      invalidateWafCache();
      if (attempt < 3) {
        await sleep(300);
        continue;
      }
      throw e;
    }
    if (process.env.XCP_DEBUG)
      console.error("[xcp] status", res.status, "body", (res.body || "").slice(0, 160));
    try { fs.appendFileSync("/data/data/com.termux/files/home/.cache/opencode/tmp/xcp_api.log", `[xcp] TOKEN=${TOKEN ? "Y" + TOKEN.length : "NONE"} ${method} ${apiPath} -> ${res.status} :: ${(res && res.body ? res.body : JSON.stringify(res)).slice(0, 700)}\n`); } catch (_) {}
    if (res.error) {
      invalidateWafCache();
      if (attempt < 3) {
        await sleep(300);
        continue;
      }
      throw new Error("browser request error: " + res.error);
    }
    // Client errors (400/401/404) are NOT retriable — they indicate bad request, auth, or missing resource.
    // Only 412 (WAF challenge) triggers a targeted re-solve.
    if (res.status === 400 || res.status === 401 || res.status === 404) {
      // 401 with valid TOKEN but stale browser session → re-login once and retry
      if (res.status === 401 && TOKEN && attempt === 0) {
        if (process.env.XCP_DEBUG) console.error("[xcp] 401 → re-login and retry");
        await ensureSession(); // re-login to refresh browser session
        continue;
      }
      const text = res.body || "";
      if (process.env.XCP_DEBUG) console.error("[xcp] client error", res.status, text.slice(0, 200));
      throw new Error(`client error ${res.status}: ${text.slice(0, 200)}`);
    }
    if (res.status === 412 || (typeof res.body === "string" && res.body.includes('cd="'))) {
      invalidateWafCache();
      if (attempt < 3) {
        await sleep(300);
        continue;
      }
      throw new Error("412 anti-bot challenge failed");
    }
    const text = res.body || "";
    if (!text) {
      invalidateWafCache();
      if (attempt < 3) {
        await sleep(300);
        continue;
      }
      return {};
    }
    try {
      return JSON.parse(text);
    } catch (_) {
      if (attempt < 2) {
        await sleep(300);
        continue;
      }
      return { _error: `HTTP ${res.status}: ${text.slice(0, 400)}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const NODE_IDS = {
  申请信息: "aj_gk_sqxx",
  审查信息: "aj_gk_scxx",
  费用信息: "aj_gk_fyxx",
  发文信息: "aj_gk_fwxx",
  公告信息: "aj_gk_gbgg",
  申请文件: "aj_gk_scxx_sqwj",
  中间文件: "aj_gk_scxx_zjwj",
  通知书: "aj_gk_scxx_tzs",
  复审文件: "aj_gk_scxx_fswj",
  无效文件: "aj_gk_scxx_wxwj",
  复审无效审查决定: "aj_gk_scjd",
  复审信息: "aj_gk_scjd_fsxxwj",
  无效信息: "aj_gk_scjd_wxxx",
};
const SECTION_API = {
  申请信息: "/api/view/gn/sqxx",
  费用信息: "/api/view/gn/fyxx",
  发文信息: "/api/view/gn/fwxx",
  公告信息: "/api/view/gn/gbggxx",
};
const NUMBER_TYPE_MAP = { 申请号: 1, 公开号: 2, 优先权号: 3 };
const FOREIGN_SEARCH_ENDPOINT = "/api/search/forgien/forgienSearch";
const FOREIGN_DETAIL_ENDPOINT = "/api/view/dg/sqxx";
const FOREIGN_DOCS_ENDPOINT = "/api/view/dg/scxxwjs";
const FOREIGN_DOC_CATEGORIES = [
  "fenleixx",
  "qitaxx",
  "dafuyj",
  "yinwen",
  "jiansuobg",
  "tongzhis",
  "shenqingwj",
];
const FOREIGN_DOC_CATEGORY_LABELS = {
  fenleixx: "分类信息",
  qitaxx: "其他信息",
  dafuyj: "答复意见",
  yinwen: "引文信息",
  jiansuobg: "检索报告",
  tongzhis: "通知书",
  shenqingwj: "申请文件",
};
const FOREIGN_COUNTRIES = ["CN", "EP", "JP", "KR", "US"];
const FILE_INFO_ENDPOINT = "/api/view/gn/fetch-file-infos";
const SCJD_FILE_INFO_ENDPOINT = "/api/view/gn/fetch-scjd-file-infos";

function detectFileExtension(data) {
  if (data.length < 4) return "bin";
  if (data.slice(0, 4).equals(Buffer.from("%PDF"))) return "pdf";
  if (data.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "png";
  if (data.slice(0, 2).equals(Buffer.from([0xff, 0xd8]))) return "jpg";
  if (data.slice(0, 4).equals(Buffer.from("GIF8"))) return "gif";
  if (data.slice(0, 4).equals(Buffer.from("<?xm")) || data.slice(0, 5).equals(Buffer.from("<?xml")))
    return "xml";
  return "bin";
}

// ---------------------------------------------------------------------------
// Domestic data APIs
// ---------------------------------------------------------------------------
async function searchPatent(patentNo) {
  await ensureSession();
  return cpqueryRequest("POST", "/api/search/gn/sqfscx", {
    pageNum: 1,
    pageSize: 10,
    zhuanlisqh: patentNo,
    followsqh: "0000",
    conditionList: [],
  });
}
async function navigateDetail(patentNo) {
  await ensureSession();
  await cpqueryRequest("POST", "/api/view/gn/obtain-init-treenodes", { zhuanlisqh: patentNo });
  const tree = await cpqueryRequest("POST", "/api/view/gn/obtain-init-treenodes", {
    zhuanlisqh: patentNo,
  });
  const nodes = {};
  for (const n of tree.data || []) nodes[n.name] = n;
  const sections = {};
  for (const [name, api] of Object.entries(SECTION_API)) {
    if (nodes[name] && nodes[name].isLeaf) {
      try {
        sections[name] = await cpqueryRequest("POST", api, {
          zhuanlisqh: patentNo,
          nodeId: nodes[name].nodeId,
        });
      } catch (_) {}
    }
  }
  const outNodes = {};
  for (const [n, x] of Object.entries(nodes))
    outNodes[n] = { nodeId: x.nodeId, isLeaf: x.isLeaf, url: x.url };
  return { nodes: outNodes, sections };
}
async function getExaminationChildren(patentNo) {
  await ensureSession();
  const r = await cpqueryRequest("POST", "/api/view/gn/scxx", {
    zhuanlisqh: patentNo,
    nodeId: "aj_gk_scxx",
  });
  const out = {};
  for (const n of r.data || []) out[n.name] = n;
  return out;
}
async function getDocumentFileInfo(patentNo, rid, ds, wenjiandm = "", isScjd = false, anjianbh = "") {
  await ensureSession();
  const body = { rid, ds, wenjiandm, zhuanlisqh: patentNo };
  if (isScjd) {
    body.anjianbh = anjianbh || "";
    return (await cpqueryRequest("POST", SCJD_FILE_INFO_ENDPOINT, body)).data || {};
  }
  return (await cpqueryRequest("POST", FILE_INFO_ENDPOINT, body)).data || {};
}
function getDownloadUrl(fileInfo) {
  if (!fileInfo || !fileInfo.ossLujingList) return "";
  const base = `${CPQUERY}/api/pcshoss/view/fetch-file`;
  const oss = fileInfo.ossLujingList[0];
  const m = String(oss.osslujing || "").match(/\.(\w+)$/);
  const ext = m ? m[1].toLowerCase() : fileInfo.wenjianhzm || "pdf";
  const params = new URLSearchParams({
    osslujing: oss.osslujing,
    wenjianhzm: ext,
    timestamp: String(oss.timestamp),
    sign: oss.sign,
    isDN: oss.isDN ? "true" : "false",
    ds: fileInfo.ds || "",
    wenjiandm: fileInfo.wenjiandm || "",
  });
  return `${base}?${params.toString()}`;
}
async function downloadDocument(patentNo, rid, ds, wenjiandm = "", isScjd = false, anjianbh = "") {
  await ensureSession();
  for (let attempt = 0; attempt < 5; attempt++) {
    const fi = await getDocumentFileInfo(patentNo, rid, ds, wenjiandm, isScjd, anjianbh);
    const url = getDownloadUrl(fi);
    if (!url) {
      if (attempt < 4) {
        await sleep(3000);
        continue;
      }
      return Buffer.alloc(0);
    }
    // Convert full cpquery URL to same-origin path (fetch-file is on cpquery domain).
    const u = new URL(url);
    const pathAndQuery = u.pathname + u.search;
    const headers = { Accept: "*/*" };
    if (TOKEN) headers["Authorization"] = "Bearer " + TOKEN;
    let res;
    try {
      res = await browserRequest("GET", pathAndQuery, { headers, binary: true });
    } catch (e) {
      if (attempt < 4) {
        await sleep(3000);
        continue;
      }
      throw e;
    }
    if (res.error) {
      if (attempt < 4) {
        await sleep(3000);
        continue;
      }
      throw new Error("下载失败: " + res.error);
    }
    if (res.status === 412) {
      if (attempt < 4) {
        await sleep(500);
        continue;
      }
      throw new Error("下载失败: 412 anti-bot");
    }
    if (res.status === 200 && res.body) {
      return Buffer.from(res.body, "base64");
    }
    if (attempt < 4) {
      await sleep(3000);
      continue;
    }
    throw new Error("下载失败: HTTP " + res.status);
  }
}
async function getScjdTree(patentNo) {
  await ensureSession();
  const root = await cpqueryRequest("POST", "/api/view/gn/scjd", {
    zhuanlisqh: patentNo,
    nodeId: "aj_gk_scjd",
  });
  const categories = root.data || [];
  const result = {};
  for (const child of categories) {
    const childName = child.name || "";
    const childNodeId = child.nodeId || "";
    const childUrl = child.url || "";
    if (!childUrl || !childNodeId) continue;
    const casesR = await cpqueryRequest("POST", childUrl, {
      zhuanlisqh: patentNo,
      nodeId: childNodeId,
      parentNodeId: "aj_gk_scjd",
    });
    const cases = casesR.data || [];
    const caseDetails = [];
    for (const c of cases) {
      const cnode = c.nodeId || "";
      const curl = c.url || "";
      const isLeaf = c.isLeaf !== false;
      const cinfo = { name: c.name || "", nodeId: cnode, isLeaf };
      if (curl) {
        const fd = await cpqueryRequest("POST", curl, {
          zhuanlisqh: patentNo,
          nodeId: cnode,
          parentNodeId: childNodeId,
        });
        const fdd = fd.data || {};
        if (fdd && fdd.rid) {
          cinfo.rid = fdd.rid;
          cinfo.ds = fdd.ds;
          cinfo.wenjiandm = fdd.wenjiandm || "";
          cinfo.anjianbh = fdd.anjianbh || cnode.toLowerCase();
        } else if (Array.isArray(fdd)) {
          caseDetails.push(...fdd);
          continue;
        }
      }
      caseDetails.push(cinfo);
    }
    result[childName] = { cases: caseDetails };
  }
  return result;
}
async function getAllDocuments(patentNo, includeEmpty = true) {
  await ensureSession();
  await cpqueryRequest("POST", "/api/view/gn/obtain-init-treenodes", { zhuanlisqh: patentNo });
  const result = [];
  const catsRaw = await cpqueryRequest("POST", "/api/view/gn/scxx", {
    zhuanlisqh: patentNo,
    nodeId: "aj_gk_scxx",
  });
  const categories = {};
  for (const n of catsRaw.data || []) categories[n.name] = n;
  async function recurse(items, catName = "", parentNodeId = "", pathPrefix = "") {
    for (const item of items) {
      const isLeaf = item.isLeaf !== false;
      const name = item.name || "";
      const ad = item.additionalData || {};
      const rid = ad.rid || "";
      const ds = ad.ds || "";
      const wjdm = ad.wenjiandm || "";
      const nodeId = item.nodeId || "";
      const url = item.url || "";
      const fullPath = pathPrefix ? pathPrefix + "/" + name : name;
      if (isLeaf && rid && ds) {
        result.push({ name, rid, ds, wenjiandm: wjdm, category: catName, path: fullPath, is_scjd: false, anjianbh: "" });
      } else if (!isLeaf && nodeId && url) {
        const body = { zhuanlisqh: patentNo, nodeId };
        if (parentNodeId) body.parentNodeId = parentNodeId;
        const children = (await cpqueryRequest("POST", url, body)).data || [];
        if (children.length || includeEmpty) await recurse(children, catName, nodeId, fullPath);
      }
    }
  }
  for (const [catName, catInfo] of Object.entries(categories)) {
    const urlPath = catInfo.url || "";
    const nodeId = catInfo.nodeId || "";
    if (!urlPath || !nodeId) continue;
    const items = (await cpqueryRequest("POST", urlPath, { zhuanlisqh: patentNo, nodeId })).data || [];
    await recurse(items, catName, nodeId, catName);
  }
  const scjd = await getScjdTree(patentNo);
  for (const [catName, catData] of Object.entries(scjd)) {
    for (const c of catData.cases || []) {
      if (c.rid && c.ds)
        result.push({
          name: c.name || "",
          rid: c.rid,
          ds: c.ds,
          wenjiandm: c.wenjiandm || "",
          category: `复审无效审查决定/${catName}`,
          path: `复审无效审查决定/${catName}/${c.name || ""}`,
          is_scjd: true,
          anjianbh: c.anjianbh || "",
        });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Foreign (多国) data APIs
// ---------------------------------------------------------------------------
function normalizeForeignApplicationNumber(country, raw) {
  country = (country || "CN").toUpperCase();
  if (raw == null) return raw;
  let s = String(raw).trim();
  if (country === "KR") {
    s = s.replace(/^(10|KR)[-\s]*/i, "");
    return s.replace(/[^\d]/g, "");
  }
  if (country === "US") {
    const serial = s.split("/").pop();
    return serial.replace(/[^\d]/g, "");
  }
  if (country === "EP") return s.split(".")[0].replace(/[^\d]/g, "");
  if (country === "CN") {
    s = s.replace(/^(CN|P)/i, "");
    s = s.split(".")[0];
    s = s.replace(/[^\d]/g, "");
    if (s.length === 13) s = s.slice(0, 12);
    return s;
  }
  if (country === "JP") return normalizeJpApplicationNumber(s);
  return s.replace(/[^\d]/g, "");
}
function normalizeJpApplicationNumber(s) {
  s = s.trim();
  const m = s.match(/平\s*(\d{1,2})\s*[-\s]\s*(\d+)/);
  if (m) return m[2] + String(parseInt(m[1], 10) + 88);
  const m2 = s.match(/(?:特願)?\s*(\d{4})\s*[-\s]\s*(\d+)/);
  if (m2) return m2[1] + m2[2];
  return s.replace(/[^\d]/g, "");
}
function normalizeForeignPublicationNumber(country, raw) {
  let s = String(raw).replace(/^[A-Za-z]{2}/, "");
  s = s.replace(/[A-Za-z]\d?$/, "");
  return s.replace(/[^\d]/g, "");
}
function deriveForeignLsh(patentNo, country) {
  let s = String(patentNo).replace(/^[A-Za-z]{2}/, "");
  s = s.replace(/[A-Za-z]\d?$/, "");
  return s.replace(/[^\d]/g, "");
}
function firstForeignRecord(res, country) {
  if (!res || typeof res !== "object") return null;
  const d = res.data;
  let recs = [];
  if (d && typeof d === "object") {
    for (const k of ["result", "list", "records"]) {
      const v = d[k];
      if (Array.isArray(v) && v.length && typeof v[0] === "object") {
        recs = v;
        break;
      }
    }
    if (d.shenqinglsh) recs = [d];
  } else if (Array.isArray(d) && d.length && typeof d[0] === "object") {
    recs = d;
  }
  if (!recs.length) return null;
  if (country) {
    country = country.toUpperCase();
    for (const r of recs) if (String(r.shenqgb || "").toUpperCase() === country) return r;
    return null;
  }
  return recs[0];
}
function foreignDetailBody(patentNo, country, shenqinglsh, shenqinglx) {
  country = (country || "CN").toUpperCase();
  if (shenqinglsh == null) shenqinglsh = deriveForeignLsh(patentNo, country);
  if (shenqinglx == null) {
    const m = String(patentNo).match(/([A-Za-z]+)$/);
    shenqinglx = m ? m[1] : "";
  }
  return {
    zhuanlisqh: patentNo,
    shenqgb: country,
    shenqinglsh,
    shenqinglx,
    tabName: "multiTab",
  };
}
async function resolveForeignIds(patentNo, country, shenqinglsh, shenqinglx) {
  const requested = (country || "CN").toUpperCase();
  const keepCountry = requested !== "" && requested !== "ALL";
  if (shenqinglsh) return [requested, shenqinglsh, shenqinglx || ""];
  const num = String(patentNo);
  const looksPub =
    /^[A-Z]{2}\d{4,}/.test(num) || /[A-Za-z]\d?$/.test(num);
  const attempts = looksPub
    ? [[2, shenqinglx || ""], [1, shenqinglx || ""]]
    : [[1, shenqinglx || ""], [2, shenqinglx || ""]];
  for (const [nt, dt] of attempts) {
    try {
      const res = await searchPatentForeign(num, requested, nt, dt);
      const rec = firstForeignRecord(res, keepCountry ? requested : null);
      if (rec) {
        shenqinglsh = rec.shenqinglsh || shenqinglsh;
        shenqinglx = rec.shenqinglx || shenqinglx;
        if (keepCountry) return [requested, shenqinglsh, shenqinglx || ""];
        return [rec.shenqgb || requested, shenqinglsh, shenqinglx || ""];
      }
    } catch (_) {}
  }
  shenqinglsh = deriveForeignLsh(patentNo, requested);
  if (!shenqinglx) {
    const m = String(patentNo).match(/([A-Za-z]\d?)$/);
    shenqinglx = m ? m[1] : "";
  }
  return [requested, shenqinglsh, shenqinglx || ""];
}
async function searchPatentForeign(patentNo, country = "CN", numberType = 1, docType = "") {
  await ensureSession();
  if (typeof numberType === "string") numberType = NUMBER_TYPE_MAP[numberType] || 1;
  let num = patentNo;
  if (numberType === 1) num = normalizeForeignApplicationNumber(country, patentNo);
  else if (numberType === 2) num = normalizeForeignPublicationNumber(country, patentNo);
  const body = { haomalx: numberType, haoma: num, guobei: country, wenxianlx: docType };
  if (!country || country === "ALL" || country === "") {
    const out = {};
    for (const cc of FOREIGN_COUNTRIES) {
      const b = { ...body, guobei: cc };
      if (numberType === 1) b.haoma = normalizeForeignApplicationNumber(cc, patentNo);
      else if (numberType === 2) b.haoma = normalizeForeignPublicationNumber(cc, patentNo);
      try {
        out[cc] = await cpqueryRequest("GET", FOREIGN_SEARCH_ENDPOINT, b);
      } catch (e) {
        out[cc] = { _error: e.message };
      }
    }
    return out;
  }
  let result = await cpqueryRequest("POST", FOREIGN_SEARCH_ENDPOINT, body);
  if (!firstForeignRecord(result, country) && (numberType === 1 || numberType === 2)) {
    const alt = numberType === 1 ? 2 : 1;
    const altHaoma =
      alt === 1
        ? normalizeForeignApplicationNumber(country, patentNo)
        : normalizeForeignPublicationNumber(country, patentNo);
    result = await cpqueryRequest("POST", FOREIGN_SEARCH_ENDPOINT, {
      ...body,
      haomalx: alt,
      haoma: altHaoma,
    });
  }
  return result;
}
async function navigateDetailForeign(patentNo, country = "US", shenqinglsh, shenqinglx) {
  await ensureSession();
  [country, shenqinglsh, shenqinglx] = await resolveForeignIds(patentNo, country, shenqinglsh, shenqinglx);
  const body = foreignDetailBody(patentNo, country, shenqinglsh, shenqinglx);
  const data = await cpqueryRequest("POST", FOREIGN_DETAIL_ENDPOINT, body);
  return { sections: { 申请信息: data } };
}
async function getAllDocumentsForeign(patentNo, country = "US", shenqinglsh, shenqinglx) {
  await ensureSession();
  [country, shenqinglsh, shenqinglx] = await resolveForeignIds(patentNo, country, shenqinglsh, shenqinglx);
  const body = foreignDetailBody(patentNo, country, shenqinglsh, shenqinglx);
  const payload = (await cpqueryRequest("POST", FOREIGN_DOCS_ENDPOINT, body)).data || {};
  const result = [];
  for (const cat of FOREIGN_DOC_CATEGORIES) {
    const items = payload[cat] || [];
    const label = FOREIGN_DOC_CATEGORY_LABELS[cat] || cat;
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      result.push({
        category: cat,
        category_label: label,
        name: it.description_content || it.identifier || "",
        legal_date: it.legalDate || "",
        pages: it.pages || "",
        format: it.format || "",
        identifier: it.identifier || "",
        uri: it.uri || "",
        description_content: it.description_content || "",
      });
    }
  }
  return result;
}
async function downloadDocumentForeign(uri) {
  await ensureSession();
  if (!uri) return Buffer.alloc(0);
  const u = new URL(uri);
  // If the foreign document is served from the 瑞数-protected cpquery domain,
  // route through the headless browser; otherwise use Node fetch.
  if (u.host === "cpquery.cponline.cnipa.gov.cn") {
    const headers = { Accept: "*/*" };
    if (TOKEN) headers["Authorization"] = "Bearer " + TOKEN;
    const res = await browserRequest("GET", u.pathname + u.search, { headers, binary: true });
    if (res.error) throw new Error("外国文档下载失败: " + res.error);
    if (res.status !== 200) throw new Error("外国文档下载失败: HTTP " + res.status);
    return Buffer.from(res.body, "base64");
  }
  const headers = { "User-Agent": UA, Origin: u.origin, Referer: uri };
  if (TOKEN) headers["Authorization"] = "Bearer " + TOKEN;
  const ck = cookieHeaderFor(u.host);
  if (ck) headers["Cookie"] = ck;
  const resp = await fetch(uri, { headers, redirect: "follow" });
  absorbCookies(resp, u.host);
  if (resp.status !== 200) throw new Error("外国文档下载失败: HTTP " + resp.status);
  return Buffer.from(await resp.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Formatting (port of format_case_summary*)
// ---------------------------------------------------------------------------
function formatCaseSummary(patentNo, summary) {
  const lines = [`专利号: ${patentNo}`, ""];
  const sections = summary.sections || {};
  for (const [name, data] of Object.entries(sections)) {
    if (!data || data.code !== 200) continue;
    const d = data.data || {};
    lines.push(`【${name}】`);
    if (d.zhuluxmxx) {
      const info = d.zhuluxmxx.zhuluxmxx || {};
      const labels = {
        zhuanlimc: "发明名称",
        shenqingr: "申请日",
        zhuanlisqh: "申请号",
        anjianywzt: "案件状态",
        zhufenlh: "主分类号",
        fufenlh: "副分类号",
        falvzt: "法律状态",
      };
      for (const [k, v] of Object.entries(info)) lines.push(`  ${labels[k] || k}: ${v}`);
    }
    if (d.shenqingren && Array.isArray(d.shenqingren.shenqingrenList))
      for (const sqr of d.shenqingren.shenqingrenList)
        lines.push(`  申请人: ${sqr.shenqingrxm || ""} (${sqr.shenqingrgb || ""})`);
    if (d.famingren && Array.isArray(d.famingren.famingrenList)) {
      const names = d.famingren.famingrenList.map((f) => f.famingrxm || "").join(", ");
      lines.push(`  发明人: ${names}`);
    }
    if (d.dailijg && Array.isArray(d.dailijg.dailijgList))
      for (const dl of d.dailijg.dailijgList)
        lines.push(`  代理机构: ${dl.dailijgdm || ""} / ${dl.diyidlrxm || ""}`);
    lines.push("");
  }
  return lines.join("\n");
}
function formatCaseSummaryForeign(patentNo, summary, country = "") {
  let head = `多国专利号: ${patentNo}`;
  if (country) head += `  国别: ${country}`;
  const lines = [head, ""];
  const nodes = summary.nodes || {};
  const sections = summary.sections || {};
  if (nodes && Object.keys(nodes).length) {
    lines.push("栏目: " + Object.keys(nodes).join(" / "));
    lines.push("");
  }
  if (!sections || !Object.keys(sections).length) {
    lines.push("（该号码在 OPD 海外专利库中暂无可用详情数据）");
    return lines.join("\n");
  }
  for (const [name, data] of Object.entries(sections)) {
    const code = data && typeof data === "object" ? data.code : null;
    if (code != null && code !== 200) {
      lines.push(`【${name}】 ${data.msg || ""}`);
      continue;
    }
    const d = (data && typeof data === "object" ? data.data : null) || {};
    lines.push(`【${name}】`);
    if (d.famingmc !== undefined || d.shenqingrenxm !== undefined || d.qitatxflh !== undefined) {
      const labels = {
        famingmc: "发明名称",
        shenqingrenxm: "申请人",
        ipc_fenleih: "IPC分类号",
        yinyongzzwxxx: "引用非专利文献",
        yinyongfzlwxxx: "引用专利文献",
      };
      for (const [k, v] of Object.entries(d)) {
        if (k === "qitatxflh" && v && typeof v === "object") {
          lines.push(`  其他体系分类号(CPC): ${v.cpc || ""}`);
        } else if (labels[k] && v) {
          lines.push(`  ${labels[k]}: ${v}`);
        } else if (k in labels) {
          // skip empty labeled
        } else if (v && typeof v === "object") {
          if (Object.keys(v).length)
            lines.push(`  ${k}: ${JSON.stringify(v, null, 0).slice(0, 300)}`);
        } else if (v) {
          lines.push(`  ${k}: ${v}`);
        }
      }
    } else if (d.zhuluxmxx) {
      const info = d.zhuluxmxx.zhuluxmxx || {};
      for (const [k, v] of Object.entries(info)) lines.push(`  ${k}: ${v}`);
    } else if (d.yijiaofei !== undefined || d.yingjiaofei !== undefined) {
      for (const key of ["yijiaofei", "yingjiaofei", "tuifei", "zhinajin", "shoujufawen", "chonghong"]) {
        const val = d[key];
        if (!val) continue;
        if (typeof val === "object") {
          const m = Object.entries(val).filter(([, x]) => Array.isArray(x) && x.length);
          if (m.length) lines.push(`  ${key}: ${JSON.stringify(Object.fromEntries(m))}`);
          else if (val.isShow) lines.push(`  ${key}: ${JSON.stringify(val)}`);
        } else {
          lines.push(`  ${key}: ${val}`);
        }
      }
    } else {
      for (const [k, v] of Object.entries(d)) {
        if (typeof v === "object") {
          if (v && Object.keys(v).length)
            lines.push(`  ${k}: ${JSON.stringify(v, null, 0).slice(0, 300)}`);
        } else if (v) {
          lines.push(`  ${k}: ${v}`);
        }
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool helpers
// ---------------------------------------------------------------------------
function _isForeign(args) {
  return ["foreign", "多国", "gw", "forgien"].includes(String(args.scope || "domestic").toLowerCase());
}
function _toText(r) {
  if (r && typeof r === "object") return JSON.stringify(r, null, 2);
  return String(r);
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// v2 tool layer surface: everything the v2 plugin entry needs from the v1
// protocol implementation. The v1 `tool({ args: zod })` definitions live in
// server.ts; this module keeps only the protocol logic.
export {
  doLogin,
  ensureSession,
  searchPatent,
  searchPatentForeign,
  navigateDetail,
  navigateDetailForeign,
  formatCaseSummary,
  formatCaseSummaryForeign,
  getAllDocuments,
  getAllDocumentsForeign,
  downloadDocument,
  downloadDocumentForeign,
  detectFileExtension,
  getExaminationChildren,
  getScjdTree,
  FOREIGN_DOC_CATEGORY_LABELS,
  FOREIGN_DOC_CATEGORIES,
  SECTION_API,
  NODE_IDS,
  FOREIGN_DETAIL_ENDPOINT,
  FOREIGN_DOCS_ENDPOINT,
  foreignDetailBody,
  cpqueryRequest,
  _isForeign,
  _toText,
};
