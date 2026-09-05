// server.ts — opencode v2 plugin：uyanip.com 全球专利查询。
// 直接通过 HTTP API 调用（无需浏览器），不依赖任何 MCP SDK。
// 工具名带 uyanip_ 前缀（v2 用 namespace 组合实现）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
const API_BASE = "https://api.duyandb.com";
const PUBLIC_KEY_AUTH = "Basic emhpcXVlOmFjbWVzZWNyZXQ=";
const LOGIN_AUTH = "Basic YWNtZTphYWNtZXNlY3JldA==";
const HOME_URL = "https://www.uyanip.com";
const DETAIL_URL = "https://www.uyanip.com/detail";
const REFERER_DEFAULT = "https://www.uyanip.com/";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.join(__dir, "session.json");

const _UA_LIST = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
];

const _RESOURCE_SUFFIXES = [
  "/js/jquery.min.js",
  "/js/jquery.cookie.js",
  "/js/ramda.min.js",
  "/js/date-utils.min.js",
  "/layui/layui.js",
  "/layui/css/layui.css",
];

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------
let TOKEN_DATA = {};
let TOKEN_EXPIRY = 0;
let CONFIG_USERNAME = "";
let CONFIG_PASSWORD = "";
let loginInFlight = null;
const cookieJar = new Map(); // name -> { value, domain }
let lastRequestTime = 0;
let sessionInitialized = false;

// ---------------------------------------------------------------------------
// 计时 / 人类化抖动
// ---------------------------------------------------------------------------
function humanDelay(minMs = 800, maxMs = 2500) {
  const now = Date.now() / 1000;
  const elapsed = now - lastRequestTime;
  let base = (Math.random() * (maxMs - minMs) + minMs) / 1000;
  base += base * (Math.random() * 0.3 - 0.15);
  const target = Math.max(0, base);
  const wait = elapsed < target ? (target - elapsed) * 1000 : 0;
  lastRequestTime = Date.now() / 1000;
  return new Promise((r) => setTimeout(r, wait));
}

function pageLoadDelay() {
  return new Promise((r) => setTimeout(r, Math.random() * 150 + 50));
}

function pickUA() {
  return _UA_LIST[Math.floor(Math.random() * _UA_LIST.length)];
}

// ---------------------------------------------------------------------------
// Cookie 罐
// ---------------------------------------------------------------------------
function parseSetCookie(sc) {
  const parts = sc.split(";");
  const [first, ...rest] = parts[0].split("=");
  let domain = "";
  for (const p of parts.slice(1)) {
    const idx = p.indexOf("=");
    const k = p.slice(0, idx).trim().toLowerCase();
    const v = p.slice(idx + 1).trim();
    if (k === "domain") domain = v.replace(/^\./, "");
  }
  return { name: first.trim(), value: rest.join("="), domain };
}

function storeCookies(setCookies) {
  for (const sc of setCookies || []) {
    const c = parseSetCookie(sc);
    cookieJar.set(c.name, c);
  }
}

function cookieHeaderFor(host) {
  const out = [];
  for (const [name, c] of cookieJar) {
    if (!c.domain || host.endsWith(c.domain) || c.domain.endsWith(host)) {
      out.push(`${name}=${c.value}`);
    }
  }
  return out.join("; ");
}

// ---------------------------------------------------------------------------
// 会话持久化
// ---------------------------------------------------------------------------
function saveSession() {
  try {
    const cookies = [];
    for (const [name, c] of cookieJar) {
      cookies.push({ name, value: c.value, domain: c.domain, path: "/" });
    }
    const data = { cookies, token: TOKEN_DATA, token_expiry: TOKEN_EXPIRY };
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (_) {}
}

function loadSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return;
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
    for (const c of data.cookies || []) {
      cookieJar.set(c.name, { value: c.value, domain: c.domain || "" });
    }
    TOKEN_DATA = data.token || {};
    TOKEN_EXPIRY = data.token_expiry || 0;
  } catch (_) {}
}

function clearSession() {
  TOKEN_DATA = {};
  TOKEN_EXPIRY = 0;
  try {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  } catch (_) {}
}

function isLoggedIn() {
  return Boolean(TOKEN_DATA && TOKEN_DATA.access_token) && Date.now() / 1000 < TOKEN_EXPIRY;
}

// ---------------------------------------------------------------------------
// 请求头
// ---------------------------------------------------------------------------
function buildHeaders(referer, extra = {}) {
  const h = {
    Accept: "application/json, text/plain, */*",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Origin: "https://www.uyanip.com",
    Referer: referer,
    "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    "User-Agent": pickUA(),
  };
  if (TOKEN_DATA && TOKEN_DATA.access_token) {
    h["Authorization"] = `bearer ${TOKEN_DATA.access_token}`;
  }
  Object.assign(h, extra);
  return h;
}

// ---------------------------------------------------------------------------
// 核心请求（含 401 刷新、退避、Cookie 管理）
// ---------------------------------------------------------------------------
async function _request(method, url, opts = {}) {
  const {
    referer = REFERER_DEFAULT,
    delay = true,
    retries = 3,
    extraHeaders = {},
    body,
    isForm = false,
    gbk = false,
    raw = false,
  } = opts;

  const host = new URL(url).host;
  let lastErr = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    if (delay) await humanDelay();

    const headers = buildHeaders(referer, extraHeaders);
    const ck = cookieHeaderFor(host);
    if (ck) headers["Cookie"] = ck;

    let resp;
    try {
      resp = await fetch(url, { method, headers, body });
    } catch (e) {
      lastErr = e;
      if (attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, (2 ** attempt) * 1000 + Math.random() * 2000));
        continue;
      }
      throw e;
    }

    const setCookies = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
    if (setCookies.length) storeCookies(setCookies);

    if (resp.status === 401) {
      let reauth = false;
      if (TOKEN_DATA.refresh_token) {
        try {
          await refreshToken();
          reauth = true;
        } catch (_) {}
      }
      if (!reauth) {
        try {
          await loginFromConfig();
          reauth = true;
        } catch (_) {}
      }
      if (reauth) {
        headers["Authorization"] = `bearer ${TOKEN_DATA.access_token}`;
        const ck2 = cookieHeaderFor(host);
        if (ck2) headers["Cookie"] = ck2;
        resp = await fetch(url, { method, headers, body });
        const sc2 = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
        if (sc2.length) storeCookies(sc2);
      }
    }

    if ([429, 502, 503, 504].includes(resp.status)) {
      await new Promise((r) => setTimeout(r, (2 ** attempt) * 1000 + Math.random() * 2000));
      continue;
    }

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    saveSession();

    if (raw) {
      const buf = Buffer.from(await resp.arrayBuffer());
      return {
        status: resp.status,
        contentType: resp.headers.get("content-type") || "",
        buffer: buf,
      };
    }

    const buf = Buffer.from(await resp.arrayBuffer());
    return parseBody(buf, gbk);
  }

  throw lastErr || new Error("request failed");
}

function parseBody(buf, gbk) {
  const utf8 = buf.toString("utf-8");
  // When GBK is suspected: if UTF-8 decoding produced replacement
  // characters, the payload was genuine GBK — decode it properly.
  if (gbk && utf8.includes("�")) {
    try {
      return JSON.parse(new TextDecoder("gb18030").decode(buf));
    } catch (_) {
      /* fall through */
    }
  }
  try {
    return JSON.parse(utf8);
  } catch (_) {
    return utf8;
  }
}

// ---------------------------------------------------------------------------
// 预热（模拟浏览器，非关键）
// ---------------------------------------------------------------------------
async function warmupSession() {
  const headers = buildHeaders(REFERER_DEFAULT);
  try {
    await fetch(HOME_URL, { headers });
    await pageLoadDelay();
    for (const suffix of _RESOURCE_SUFFIXES) {
      try {
        await fetch(HOME_URL + suffix, { headers });
      } catch (_) {}
      await pageLoadDelay();
    }
  } catch (_) {}
}

function initSession() {
  if (sessionInitialized) return;
  loadSession();
  sessionInitialized = true;
}

// ---------------------------------------------------------------------------
// RSA 加密（匹配 JSEncrypt，PKCS1 v1.5）
// ---------------------------------------------------------------------------
function rsaEncrypt(publicKeyB64, plaintext) {
  const formatted = publicKeyB64.match(/.{1,64}/g).join("\n");
  const pem = `-----BEGIN PUBLIC KEY-----\n${formatted}\n-----END PUBLIC KEY-----`;
  const encrypted = crypto.publicEncrypt(
    { key: pem, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(plaintext, "utf-8")
  );
  return encrypted.toString("base64");
}

// ---------------------------------------------------------------------------
// 登录 / 令牌
// ---------------------------------------------------------------------------
async function login(username, password) {
  clearSession();
  initSession();

  const pkResp = await _request("GET", `${API_BASE}/auth/auth/publicKey`, {
    delay: true,
    retries: 2,
    extraHeaders: { Authorization: PUBLIC_KEY_AUTH },
  });
  const pkData = pkResp;
  if (pkData.errCode !== 0) {
    throw new Error(`Public key fetch failed: ${pkData && pkData.data ? pkData.data : "unknown"}`);
  }
  const publicKey = pkData.data;

  const encUser = rsaEncrypt(publicKey, username);
  const encPass = rsaEncrypt(publicKey, password);

  const loginResp = await _request("POST", `${API_BASE}/auth/auth/login`, {
    delay: true,
    retries: 2,
    extraHeaders: { Authorization: LOGIN_AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ username: encUser, password: encPass }),
  });
  const result = loginResp;
  if (result.errCode !== 0) {
    throw new Error(`Login failed: ${result.data || "unknown"}`);
  }

  TOKEN_DATA = result.data;
  TOKEN_EXPIRY = Date.now() / 1000 + (result.data.expires_in || 3600) - 60;
  saveSession();
  return TOKEN_DATA;
}

async function loginFromConfig() {
  const username = process.env.UYANIP_USERNAME;
  const password = process.env.UYANIP_PASSWORD;
  if (!username || !password) {
    throw new Error("请在插件配置或环境变量中设置 UYANIP_USERNAME 和 UYANIP_PASSWORD");
  }
  return login(username, password);
}

async function refreshToken() {
  const refresh = TOKEN_DATA.refresh_token;
  if (!refresh) throw new Error("No refresh_token, please re-login");

  const resp = await _request("POST", `${API_BASE}/auth/oauth/token`, {
    delay: false,
    retries: 1,
    extraHeaders: { Authorization: LOGIN_AUTH },
    isForm: true,
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: "acme",
    }).toString(),
  });
  const data = resp;
  if (data.errCode === 0) {
    TOKEN_DATA = data.data;
    TOKEN_EXPIRY = Date.now() / 1000 + (data.data.expires_in || 3600) - 60;
    saveSession();
  } else {
    throw new Error(`Token refresh failed: ${data.data}`);
  }
}

async function ensureLogin() {
  initSession();
  if (isLoggedIn()) return;

  let user = CONFIG_USERNAME || process.env.UYANIP_USERNAME;
  let pass = CONFIG_PASSWORD || process.env.UYANIP_PASSWORD;

  if (user && pass) {
    try {
      if (!loginInFlight) {
        loginInFlight = (async () => {
          await login(user, pass);
        })().finally(() => { loginInFlight = null; });
      }
      await loginInFlight;
      return;
    } catch (e) {
      throw new Error(`自动登录失败: ${e.message}；也可手动调用 uyanip_login 重试`);
    }
  }

  throw new Error("未登录，请先调用 uyanip_login 或在配置中提供 UYANIP_USERNAME/UYANIP_PASSWORD");
}

// ---------------------------------------------------------------------------
// 专利号解析
// ---------------------------------------------------------------------------
function looksLikeAid(value) {
  if (/^CN\d{4}\d{8,9}\.\d$/.test(value)) return true;
  if (/^\d{4}\d{8,9}\.\d$/.test(value)) return true;
  if (/^\d{13}$/.test(value)) return true;
  return false;
}

function looksLikePubnumber(value) {
  const clean = value.trim();
  if (/^CN\d{5,9}[A-Z]$/.test(clean)) return true;
  if (/^[A-Z]{2}\d{5,12}[A-Z0-9]{0,4}$/.test(clean) && !clean.startsWith("CN")) return true;
  return false;
}

function normalizeAid(value) {
  let v = value.trim();
  if (v.startsWith("CN")) v = v.slice(2);
  if (/^\d{13}$/.test(v)) v = v.slice(0, 12) + "." + v.slice(12);
  if (!v.startsWith("CN")) v = "CN" + v;
  return v;
}

// ---------------------------------------------------------------------------
// 端点调用
// ---------------------------------------------------------------------------
async function getPatentByGetpic(aid) {
  await ensureLogin();
  let a = aid;
  if (!a.startsWith("CN")) a = `CN${a}`;
  const resp = await _request("POST", `${API_BASE}/search/search/getPic`, {
    referer: `${DETAIL_URL}?aid=${a}`,
    retries: 3,
    extraHeaders: { "Content-Type": "application/json" },
    body: JSON.stringify({ aid: a, fmsq: false }),
  });
  if (resp.errCode !== 0) throw new Error(`getPic failed: ${resp.data || "unknown"}`);
  return resp.data || {};
}

async function getPatentDetail(aid, pid) {
  await ensureLogin();
  let resp;
  if (pid) {
    resp = await _request("POST", `${API_BASE}/search/search/detail_pid`, {
      referer: `${DETAIL_URL}?pid=${pid}`,
      retries: 3,
      extraHeaders: { "Content-Type": "application/json" },
      body: JSON.stringify({ pid }),
    });
  } else {
    let a = aid;
    if (!a.startsWith("CN")) a = `CN${a}`;
    resp = await _request("POST", `${API_BASE}/search/search/detail`, {
      referer: `${DETAIL_URL}?aid=${a}`,
      retries: 3,
      extraHeaders: { "Content-Type": "application/json" },
      body: JSON.stringify({ aid: a }),
    });
  }
  if (resp.errCode !== 0) throw new Error(`Patent detail fetch failed: ${resp.data || "unknown data"}`);
  return resp.data || {};
}

async function fetchByPatentNo(patentNo) {
  await ensureLogin();
  const clean = patentNo.trim();
  let pid = "";
  let aid = "";
  if (looksLikePubnumber(clean)) pid = clean;
  else aid = normalizeAid(clean);

  const merged = {};
  try {
    const detailData = await getPatentDetail(aid, pid);
    Object.assign(merged, detailData);
    if (!aid) aid = detailData.aid || "";
  } catch (e) {
    /* non-fatal */
  }

  if (aid && !merged.foreign) {
    try {
      const getpicData = await getPatentByGetpic(aid);
      Object.assign(merged, getpicData);
    } catch (_) {
      /* non-fatal */
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// 文本字段提取
// ---------------------------------------------------------------------------
function getField(data, ...keys) {
  for (const key of keys) {
    let val = data[key] || (data.itemInfo && data.itemInfo[key]) || "";
    if (val) {
      if (typeof val === "object" && val !== null) {
        const text = val.instr || val.text || "";
        if (text) return typeof text === "string" ? text : "";
      } else if (typeof val === "string" && val.trim()) {
        return val.trim();
      }
    }
  }
  return "";
}

function getSpecText(data) {
  const t = getField(data, "specification", "specificationEng");
  if (t) return t;
  return getField(data, "specificationZh");
}

function extractBibliographic(data) {
  const keyMap = {
    aid: "申请号",
    applDate: "申请日",
    pubNumber: "公开（公告）号",
    pubDate: "公开（公告）日",
    title: "发明名称",
    applicant: "申请人（专利权人）",
    inventor: "发明人",
    ipc: "IPC分类号",
    mainIpc: "主分类号",
    address: "地址",
    agency: "代理机构",
    agent: "代理人",
    abs: "摘要",
    country: "申请国别",
    legalInfo: "法律状态",
    dbType: "专利类型",
    province: "省份",
  };

  const fallbackMap = {};
  if (data.foreign || !data.title) {
    fallbackMap.title = "titleEng";
    fallbackMap.abs = "absEng";
  }

  const item = data.itemInfo || {};
  const fields = {};
  for (const [engKey, cnKey] of Object.entries(keyMap)) {
    const fallback = fallbackMap[engKey];
    let val = data[engKey] || item[engKey] || "";
    if (!val && fallback) val = data[fallback] || item[fallback] || "";
    if (val == null) val = "";
    fields[cnKey] = String(val).trim();
  }
  return fields;
}

function extractDrawings(data) {
  const drawings = [];
  const seen = new Set();
  const picBase = "http://picnew.duyandb.com";

  const sources = [];
  for (const key of ["pictureLists", "designPictureLists"]) {
    const items = data[key] || [];
    if (Array.isArray(items)) {
      for (const i of items) if (typeof i === "string" || typeof i === "object") sources.push({ entry: i });
    }
  }

  const drawsUrl = data.draws;
  if (typeof drawsUrl === "string" && drawsUrl) {
    if (!seen.has(drawsUrl)) {
      seen.add(drawsUrl);
      drawings.push({ src: drawsUrl, width: 0, height: 0 });
    }
  }

  const item = data.itemInfo;
  if (item && typeof item === "object") {
    for (const key of ["pictureLists", "designPictureLists"]) {
      const items = item[key] || [];
      if (Array.isArray(items)) {
        for (const i of items) if (typeof i === "string" || typeof i === "object") sources.push({ entry: i });
      }
    }
  }

  for (const s of sources) {
    const entry = s.entry;
    let src;
    if (typeof entry === "string") src = entry;
    else src = entry.path || entry.src || entry.url || "";
    if (src && !src.startsWith("http")) src = `${picBase}/${src.replace(/^\//, "")}`;
    if (src && !seen.has(src)) {
      seen.add(src);
      drawings.push({
        src,
        width: entry && typeof entry === "object" ? entry.width || 0 : 0,
        height: entry && typeof entry === "object" ? entry.height || 0 : 0,
      });
    }
  }
  return drawings;
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------
async function fetchBibliographic(patentNo) {
  return extractBibliographic(await fetchByPatentNo(patentNo));
}

async function fetchClaims(patentNo) {
  const data = await fetchByPatentNo(patentNo);
  return getField(data, "claims", "claimsEng", "claimsZh");
}

async function fetchDescription(patentNo) {
  const data = await fetchByPatentNo(patentNo);
  return getSpecText(data);
}

async function fetchDrawings(patentNo) {
  const data = await fetchByPatentNo(patentNo);
  return extractDrawings(data);
}

async function fetchPatentContent(patentNo) {
  const data = await fetchByPatentNo(patentNo);
  return {
    patent_no: patentNo,
    bibliographic: extractBibliographic(data),
    claims: getField(data, "claims", "claimsEng", "claimsZh"),
    description: getSpecText(data),
    drawings: extractDrawings(data),
  };
}

async function fetchPatentPdf(patentNo) {
  const data = await fetchByPatentNo(patentNo);
  const pubNumber = data.pubNumber || "";
  const pdfKey = data.pdfKey || "";
  if (!pubNumber) throw new Error(`Could not resolve publication number for ${patentNo}`);
  if (!pdfKey) throw new Error(`No pdfKey available for ${patentNo}`);

  const url = `${API_BASE}/search/search/pdfByKey/download/${pubNumber}/${pdfKey}`;
  const r = await _request("GET", url, {
    referer: `${DETAIL_URL}?pid=${pubNumber}`,
    retries: 2,
    raw: true,
  });
  if (r.status !== 200 || !r.contentType.toLowerCase().startsWith("application/pdf")) {
    throw new Error(`Unexpected response: HTTP ${r.status} content-type=${r.contentType}`);
  }
  return r.buffer;
}

async function batchFetchPatents(patentNos) {
  const results = [];
  for (let i = 0; i < patentNos.length; i++) {
    try {
      results.push(await fetchPatentContent(patentNos[i]));
    } catch (e) {
      results.push({ patent_no: patentNos[i], error: String(e.message || e) });
    }
    if (i < patentNos.length - 1) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// 高级检索
// ---------------------------------------------------------------------------
const SEARCH_URL = `${API_BASE}/search/search/queryByExpInternational`;

const FIELD_PARAMS = [
  ["query", "KEYWORD"],
  ["title", "ZLMC"],
  ["abstract", "ZY"],
  ["claims", "QLYQ"],
  ["ipc", "IPC"],
  ["main_ipc", "MIPC"],
  ["applicant", "SQREN"],
  ["inventor", "FMR"],
  ["agency", "DLJG"],
  ["agent", "DLR"],
  ["pub_number", "GKH"],
  ["apply_number", "SQH"],
  ["priority_number", "YXQH"],
  ["pub_date", "GKR"],
  ["apply_date", "SQR"],
  ["legal_date", "SHOUQR"],
  ["first_applicant", "DYSQR"],
  ["first_inventor", "DYFMR"],
  ["current_assignee", "DQQLR"],
  ["current_agency", "DQDLJG"],
  ["address", "DZ"],
  ["current_agent", "DQDLR"],
  ["current_address", "DQQLRDZ"],
  ["priority_date", "YXQR"],
  ["earliest_priority_date", "ZZYXQR"],
  ["cpc", "CPC"],
  ["fterm", "FTERM4"],
  ["industry", "GMJJHY"],
  ["strategy_industry", "ZLXXFL"],
  ["cites", "YYZL"],
  ["cited_by", "BYYZL"],
  ["family", "JDTZ"],
  ["standard", "BZ"],
  ["standard_no", "BZH"],
  ["patent_award", "HJQK"],
  ["apply_type", "APPLY_TYPE"],
];

function normDate(value) {
  if ((typeof value === "number") && value > 0) {
    try {
      return new Date(value).toISOString().slice(0, 10);
    } catch (_) {
      return value;
    }
  }
  if (typeof value === "string") {
    const m = value.match(/^\d{4}-\d{2}-\d{2}/);
    if (m) return m[0];
  }
  return value;
}

async function searchPatents(params) {
  await ensureLogin();
  const {
    query, title, abstract, claims, ipc, main_ipc, applicant, inventor,
    agency, agent, pub_number, apply_number, priority_number, pub_date,
    apply_date, legal_date, first_applicant, first_inventor, current_assignee,
    current_agency, address, current_agent, current_address, priority_date,
    earliest_priority_date, cpc, fterm, industry, strategy_industry, cites,
    cited_by, family, standard, standard_no, patent_award, apply_type,
    country, exp, page = 1, page_size = 10,
  } = params;

  let expression;
  if (exp) {
    expression = exp;
  } else {
    const parts = [];
    for (const [pname, code] of FIELD_PARAMS) {
      const value = params[pname];
      if (value) parts.push(`${code}:(${value})`);
    }
    if (parts.length === 0) throw new Error("至少需要提供一个检索条件（query/exp 或某个字段）");
    expression = "AND " + parts.join(" AND ");
  }

  const body = {
    exp: expression,
    fromMode: 2,
    page: Math.max(1, parseInt(page, 10) || 1),
    pageSize: Math.max(1, Math.min(parseInt(page_size, 10) || 10, 50)),
  };

  if (country) {
    let codes;
    if (Array.isArray(country)) codes = country.join(" OR ");
    else codes = String(country).split(",").map((c) => c.trim()).filter(Boolean).join(" OR ");
    body.country = `AND GJ:(${codes})`;
  }

  const resp = await _request("POST", SEARCH_URL, {
    referer: `${HOME_URL}/search/keyword`,
    retries: 3,
    gbk: true,
    extraHeaders: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (resp.errCode !== 0) {
    throw new Error(`检索失败: errCode=${resp.errCode}, data=${resp.data}`);
  }

  const data = resp.data || {};
  const rawList = data.list || [];
  const results = rawList.map((item) => ({
    pubNumber: item.pubNumber,
    aid: item.aid,
    title: item.title,
    abstract: item.abs,
    applicant: item.applicant,
    inventor: item.inventor,
    agency: item.agencyName,
    applDate: normDate(item.applDate),
    pubDate: normDate(item.pubDate),
    ipc: item.ipc,
    mainIpc: item.mainIpc,
    legalStatus: item.legalStatus,
    dbType: item.dbType,
    country: item.country,
  }));

  return {
    total: data.total || 0,
    page: parseInt(page, 10) || 1,
    page_size: body.pageSize,
    results,
  };
}

// ---------------------------------------------------------------------------
// 工具注册（v2：setup(ctx) 中通过 ctx.tool.transform 注入）
// ---------------------------------------------------------------------------
const TOOL_NAMESPACE = "uyanip";

function toolDef(name, description, properties, required, execute) {
  return {
    name,
    description,
    input: {
      type: "object",
      properties,
      required: required || [],
      additionalProperties: false,
    },
    execute,
    options: { namespace: TOOL_NAMESPACE },
  };
}

const TOOLS = [
  toolDef(
    "login",
    "手动登录uyanip.com专利检索网站。如已在插件配置或环境变量中设置 UYANIP_USERNAME 和 UYANIP_PASSWORD，则启动时自动登录，无需手动调用。",
    {
      username: { type: "string", description: "登录账号（手机号或邮箱）" },
      password: { type: "string", description: "登录密码" },
    },
    ["username", "password"],
    async (args) => {
      try {
        const token = await login(args.username, args.password);
        return JSON.stringify(
          { message: "登录成功", expires_in: token.expires_in || "未知" },
          null,
          2
        );
      } catch (e) {
        return `登录失败: ${e.message}`;
      }
    }
  ),

  toolDef(
    "fetch_bibliographic",
    "获取专利著录项目信息，包括：申请号、申请日、公开（公告）号、公开（公告）日、发明名称、申请人（专利权人）、发明人、IPC分类号、分类号、地址、代理机构、代理人、摘要等。支持中国、美国、欧洲、日本、韩国等全球专利。",
    {
      patent_no: { type: "string", description: "专利号，支持申请号（如202410958014.8）或公开号（如CN115353203A、US20070101481A1、EP1234567A1）" },
    },
    ["patent_no"],
    async (args) => {
      try {
        return JSON.stringify(await fetchBibliographic(args.patent_no), null, 2);
      } catch (e) {
        return `获取著录项目失败: ${e.message}`;
      }
    }
  ),

  toolDef(
    "fetch_claims",
    "获取专利权利要求书全文。适用于分析专利保护范围、进行侵权比对、评估专利有效性的场景。",
    {
      patent_no: { type: "string", description: "专利号" },
    },
    ["patent_no"],
    async (args) => {
      try {
        const result = await fetchClaims(args.patent_no);
        return `专利 ${args.patent_no} - 权利要求书\n${"=".repeat(40)}\n\n${result}`;
      } catch (e) {
        return `获取权利要求书失败: ${e.message}`;
      }
    }
  ),

  toolDef(
    "fetch_description",
    "获取专利说明书全文，包含技术领域、背景技术、发明内容、附图说明、具体实施方式等部分。",
    {
      patent_no: { type: "string", description: "专利号" },
    },
    ["patent_no"],
    async (args) => {
      try {
        const result = await fetchDescription(args.patent_no);
        return `专利 ${args.patent_no} - 说明书\n${"=".repeat(40)}\n\n${result}`;
      } catch (e) {
        return `获取说明书失败: ${e.message}`;
      }
    }
  ),

  toolDef(
    "fetch_drawings",
    "获取专利附图，返回图片URL列表。适用于查看专利结构图、流程图、电路图等附图信息。",
    {
      patent_no: { type: "string", description: "专利号" },
    },
    ["patent_no"],
    async (args) => {
      try {
        return JSON.stringify(await fetchDrawings(args.patent_no), null, 2);
      } catch (e) {
        return `获取附图失败: ${e.message}`;
      }
    }
  ),

  toolDef(
    "fetch_patent_content",
    "一次性获取专利全部内容（著录项目 + 权利要求书 + 说明书 + 附图）。支持中国、美国、欧洲、日本、韩国等全球专利。",
    {
      patent_no: { type: "string", description: "专利号，支持申请号或公开号" },
    },
    ["patent_no"],
    async (args) => {
      try {
        return JSON.stringify(await fetchPatentContent(args.patent_no), null, 2);
      } catch (e) {
        return `获取专利 ${args.patent_no} 失败: ${e.message}`;
      }
    }
  ),

  toolDef(
    "batch_fetch_patents",
    "批量获取多个专利的全部内容。接收专利号列表，逐个获取，自动控制请求频率避免被限制。支持全球专利。",
    {
      patent_nos: { type: "array", items: { type: "string" }, description: "专利号列表，如 [\"CN115353203A\",\"US20070101481A1\"]" },
    },
    ["patent_nos"],
    async (args) => {
      const results = [];
      for (let i = 0; i < args.patent_nos.length; i++) {
        const no = args.patent_nos[i];
        try {
          results.push(await fetchPatentContent(no));
        } catch (e) {
          results.push({ patent_no: no, error: String(e.message || e) });
        }
        if (i < args.patent_nos.length - 1) {
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
      return JSON.stringify(results, null, 2);
    }
  ),

  toolDef(
    "fetch_patent_pdf",
    "获取专利PDF文件。返回base64编码的PDF文件内容。支持中国、美国、欧洲、日本、韩国等全球专利。",
    {
      patent_no: { type: "string", description: "专利号，支持申请号或公开号" },
    },
    ["patent_no"],
    async (args) => {
      try {
        const pdf = await fetchPatentPdf(args.patent_no);
        const b64 = pdf.toString("base64");
        return JSON.stringify(
          {
            patent_no: args.patent_no,
            pdf_base64: b64,
            file_size_bytes: pdf.length,
            filename: `${args.patent_no}.pdf`,
          },
          null,
          2
        );
      } catch (e) {
        return `获取PDF失败: ${e.message}`;
      }
    }
  ),

  toolDef(
    "search_patents",
    "高级检索：按关键词与字段（专利名称/摘要/权利要求/IPC/申请人/发明人/代理机构/公开号/申请号/优先权号/公开日/申请日/授权日/国家地区）检索全球专利，用于专利查新、侵权排查、技术追踪。不传 country 时检索全球；country 传代码数组如 [\"CN\",\"US\",\"EP\"]。日期范围用 '20200101 TO 20231231' 格式。传 exp 可直接写原始检索式（如 'AND KEYWORD:(锂电池) AND IPC:(H01M)'），覆盖字段拼接。",
    {
      query: { type: "string", description: "主要字段检索词（对应 KEYWORD）" },
      title: { type: "string", description: "专利名称" },
      abstract: { type: "string", description: "摘要" },
      claims: { type: "string", description: "权利要求" },
      ipc: { type: "string", description: "IPC分类号" },
      main_ipc: { type: "string", description: "IPC主分类号" },
      applicant: { type: "string", description: "申请(专利权)人" },
      inventor: { type: "string", description: "发明人" },
      agency: { type: "string", description: "代理机构" },
      agent: { type: "string", description: "代理人" },
      pub_number: { type: "string", description: "公开(公布)号" },
      apply_number: { type: "string", description: "申请号" },
      priority_number: { type: "string", description: "优先权号" },
      pub_date: { type: "string", description: "公开(公布)日范围，如 '20200101 TO 20231231'" },
      apply_date: { type: "string", description: "申请日范围，如 '20200101 TO 20231231'" },
      legal_date: { type: "string", description: "授权(公告)日范围" },
      first_applicant: { type: "string", description: "第一申请(专利权)人" },
      first_inventor: { type: "string", description: "第一发明人" },
      current_assignee: { type: "string", description: "当前权利人" },
      current_agency: { type: "string", description: "当前代理机构" },
      address: { type: "string", description: "地址" },
      current_agent: { type: "string", description: "当前代理人" },
      current_address: { type: "string", description: "当前地址" },
      priority_date: { type: "string", description: "优先权日范围" },
      earliest_priority_date: { type: "string", description: "最早优先权日范围" },
      cpc: { type: "string", description: "CPC分类号" },
      fterm: { type: "string", description: "F-Term检索词" },
      industry: { type: "string", description: "国民经济行业分类" },
      strategy_industry: { type: "string", description: "战略性新兴产业分类" },
      cites: { type: "string", description: "引用专利（填专利号）" },
      cited_by: { type: "string", description: "被引用专利（填专利号）" },
      family: { type: "string", description: "简单同族（填专利号）" },
      standard: { type: "string", description: "标准" },
      standard_no: { type: "string", description: "标准号" },
      patent_award: { type: "string", description: "专利奖，如 金奖/银奖/优秀奖" },
      apply_type: { type: "string", description: "申请方式" },
      country: { type: "array", items: { type: "string" }, description: "国家或地区代码数组，如 [\"CN\",\"US\",\"EP\"]" },
      exp: { type: "string", description: "原始检索式（高级用法），直接覆盖字段拼接" },
      page: { type: "number", description: "页码，从1开始，默认 1" },
      page_size: { type: "number", description: "每页数量，1-50，默认 10" },
    },
    [],
    async (args) => {
      try {
        const clean = {};
        for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null) clean[k] = v;
        return JSON.stringify(await searchPatents(clean), null, 2);
      } catch (e) {
        return `检索失败: ${e.message}`;
      }
    }
  ),
];

// ---------------------------------------------------------------------------
// v2 入口
// ---------------------------------------------------------------------------
export default {
  id: "uyanip",
  setup: async (ctx) => {
    const cfg = (ctx.options && typeof ctx.options === "object" ? ctx.options : {}) || {};
    const username = cfg.username || process.env.UYANIP_USERNAME;
    const password = cfg.password || process.env.UYANIP_PASSWORD;

    CONFIG_USERNAME = cfg.username || process.env.UYANIP_USERNAME || "";
    CONFIG_PASSWORD = cfg.password || process.env.UYANIP_PASSWORD || "";

    initSession();

    if (username && password) {
      try {
        await login(username, password);
      } catch (e) {
        // startup auto-login failed; user can login manually
      }
    }

    // NOTE: the transform callback runs inside the plugin host worker (its own
    // global scope), so any side effects / closures captured here are NOT seen
    // after `await` returns in this setup() scope. Sentinel + ID capture must
    // therefore happen inside the callback, not here.
    const registration = await ctx.tool.transform((editor) => {
      for (const t of TOOLS) {
        editor.add(t);
      }
      const ids = editor.list().map(({ id }) => id);
      const sentinel = process.env.UYANIP_VERIFY_SENTINEL;
      if (sentinel) {
        fs.writeFileSync(sentinel, JSON.stringify(ids, null, 2), "utf-8");
      }
    });

    return async () => {
      await registration.dispose();
    };
  },
};
