// core.mjs — 通用扫码登录（QR scan-login）适配器框架。
//
// 与具体网站解耦：每个网站只需要提供一个"provider 适配器"，描述：
//   - loginUrl():    用于生成二维码的登录 URL（二维码内容，用户扫码后打开）
//   - generateQr():  返回可直接扫码的二维码内容（默认就用 loginUrl()，某些网站有单独的二维码生成接口/短链）
//   - pollStatus():  后台轮询扫码/确认结果 → 返回 { state, token?, cookies?, headers?, user? }
//                    state: "pending" | "scanned" | "confirmed" | "expired" | "error"
//   - refresh?():    可选的 token 刷新（如 GitCode OAuth token 15 天过期可刷新）
//   - headers(token): 给定 token 生成鉴权请求头（用于任务/活动请求）
//
// 登录态（token/cookies/json）以 JSON 文件形式持久化在插件目录的 storage/<site>.json，
// 参考 uyanip 的 session.json 模式。这样扫码登录成功后，即使 opencode 重启也能复用会话。
//
// 本模块不依赖任何第三方包：只用 node:fs / node:path / node:crypto + 全局 fetch。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));

// 每个站点的运行状态（内存共享）。poll 定时器由 startPolling 管理。
const sessions = new Map();

export const SITE_STATE = {
  IDLE: "idle",
  WAITING: "waiting", // 已生成二维码，等待扫码
  SCANNED: "scanned", // 已扫码，等待确认
  CONFIRMED: "confirmed", // 已确认登录成功
  EXPIRED: "expired",
  ERROR: "error",
};

function storageDir(siteId) {
  const d = path.join(__dir, "storage");
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch {}
  return d;
}

function storagePath(siteId) {
  return path.join(storageDir(siteId), `${siteId}.json`);
}

export function loadSession(siteId) {
  try {
    const p = storagePath(siteId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

function saveSession(siteId, data) {
  try {
    fs.writeFileSync(storagePath(siteId), JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    // 写失败不阻断登录流程，仅记录
    console.error(`[auth-login] save session ${siteId} failed: ${e.message}`);
  }
}

// 供外部（如手动注入 token 后）把内存会话 state 持久化到磁盘。
export function persistSession(siteId, s) {
  saveSession(siteId, {
    token: s.token,
    cookies: s.cookies,
    headers: s.headers,
    user: s.user,
    savedAt: s.savedAt,
  });
}

function getSession(siteId) {
  if (!sessions.has(siteId)) {
    const saved = loadSession(siteId);
    sessions.set(siteId, {
      state: SITE_STATE.IDLE,
      token: saved?.token ?? null,
      cookies: saved?.cookies ?? null,
      headers: saved?.headers ?? null,
      user: saved?.user ?? null,
      savedAt: saved?.savedAt ?? null,
      pollTimer: null,
      lastPollAt: 0,
      lastError: "",
      qrText: "",
      qrPath: "",
      pollCount: 0,
    });
  }
  return sessions.get(siteId);
}

/**
 * 通用扫码登录流程。并发安全：同一站点重复调用会复用一个进行中的流程。
 * @param {object} site  站点适配器（见本文头部注释）
 * @param {object} opts  { wait?: boolean, timeoutSec?: number }
 * @returns {Promise<object>} 状态摘要 + （可选）二维码内容/文件路径
 */
export async function startLogin(site, opts = {}) {
  const s = getSession(site.id);

  // 已登录（未过期）直接返回
  if (s.state === SITE_STATE.CONFIRMED && s.token) {
    return summarize(site, s, true);
  }

  // 获得二维码内容
  let qrText;
  try {
    qrText = site.generateQr ? await site.generateQr(s) : await site.loginUrl(s);
  } catch (e) {
    s.state = SITE_STATE.ERROR;
    s.lastError = `生成二维码失败: ${e.message}`;
    return summarize(site, s, false);
  }
  s.qrText = typeof qrText === "string" ? qrText : "(provider 直供图片二维码)";

  // 渲染 PNG + ASCII，落盘到 storage/<site>/qr-<ts>.png
  const { renderQrToFile } = await import("./provider-qr.mjs");
  let qrPath = "";
  let qrAscii = "";
  try {
    if (qrText && typeof qrText === "object") {
      // 站点适配器直接提供二维码图片（如微信小程序码，本地无法重编码）：
      //   { base64: "iVBOR..." }  → 落盘 PNG
      //   { path: "/abs/qr.png" } → 直接引用文件
      const dir = path.join(__dir, "storage", String(site.id));
      fs.mkdirSync(dir, { recursive: true });
      if (qrText.base64) {
        const buf = Buffer.from(String(qrText.base64).replace(/^data:image\/png;base64,/, ""), "base64");
        qrPath = path.join(dir, `qr-${Date.now()}.png`);
        fs.writeFileSync(qrPath, buf);
      } else if (qrText.path) {
        qrPath = String(qrText.path);
      }
      qrAscii = typeof qrText.ascii === "string" ? qrText.ascii : `[${site.id}] 扫码登录二维码已生成（图片路径：${qrPath}）`;
    } else {
      const out = await renderQrToFile(site.id, qrText);
      qrPath = out.path;
      qrAscii = out.ascii;
    }
  } catch (e) {
    s.lastError = `二维码渲染失败: ${e.message}`;
  }
  s.qrPath = qrPath;
  s.state = SITE_STATE.WAITING;

  startPolling(site, s);
  return { ...summarize(site, s, false), qrPath, qrAscii, qrText };
}

function summarize(site, s, loggedIn) {
  return {
    site: site.id,
    state: s.state,
    loggedIn: !!loggedIn || !!s.token,
    token: s.token,
    user: s.user,
    savedAt: s.savedAt,
    qrPath: s.qrPath,
    lastError: s.lastError,
  };
}

function startPolling(site, s) {
  if (s.pollTimer) return; // 已有定时器
  const intervalMs = site.pollIntervalMs || 2000;
  const poll = async () => {
    if (s.state === SITE_STATE.CONFIRMED || s.state === SITE_STATE.EXPIRED) {
      stopPolling(s);
      return;
    }
    try {
      const r = await site.pollStatus(s);
      s.lastPollAt = Date.now();
      s.pollCount++;
      if (r.state === SITE_STATE.CONFIRMED) {
        s.token = r.token ?? s.token;
        s.cookies = r.cookies ?? s.cookies;
        s.headers = r.headers ?? s.headers;
        s.user = r.user ?? s.user;
        s.savedAt = Date.now();
        s.state = SITE_STATE.CONFIRMED;
        saveSession(site.id, {
          token: s.token,
          cookies: s.cookies,
          headers: s.headers,
          user: s.user,
          savedAt: s.savedAt,
        });
        stopPolling(s);
      } else if (r.state === SITE_STATE.SCANNED) {
        s.state = SITE_STATE.SCANNED;
      } else if (r.state === SITE_STATE.EXPIRED) {
        s.state = SITE_STATE.EXPIRED;
        s.lastError = "二维码已过期";
        stopPolling(s);
      } else if (r.state === SITE_STATE.ERROR) {
        s.lastError = r.message || "轮询出错";
      }
    } catch (e) {
      s.lastError = `轮询异常: ${e.message}`;
    }
  };
  s.pollTimer = setInterval(poll, intervalMs);
  poll(); // 立即先轮询一次
}

function stopPolling(s) {
  if (s.pollTimer) {
    clearInterval(s.pollTimer);
    s.pollTimer = null;
  }
}

export function getStatus(site) {
  const s = getSession(site.id);
  return summarize(site, s, s.state === SITE_STATE.CONFIRMED);
}

export async function forceRefresh(site, opts = {}) {
  const s = getSession(site.id);
  if (!s.token && !s.cookies) {
    return { site: site.id, ok: false, message: "尚未登录，无 token 可刷新" };
  }
  if (!site.refresh) {
    return { site: site.id, ok: false, message: "该站点适配器未实现 refresh()" };
  }
  try {
    const r = await site.refresh(s, opts);
    if (r.token || r.cookies) {
      s.token = r.token ?? s.token;
      s.cookies = r.cookies ?? s.cookies;
      s.headers = r.headers ?? r.headers;
      s.user = r.user ?? r.user;
      s.savedAt = Date.now();
      s.state = SITE_STATE.CONFIRMED;
      saveSession(site.id, {
        token: s.token,
        cookies: s.cookies,
        headers: s.headers,
        user: s.user,
        savedAt: s.savedAt,
      });
      return { site: site.id, ok: true, loggedIn: true, token: s.token };
    }
    return { site: site.id, ok: false, message: r.message || "刷新失败" };
  } catch (e) {
    return { site: site.id, ok: false, message: `刷新异常: ${e.message}` };
  }
}

export async function logout(site) {
  const s = getSession(site.id);
  stopPolling(s);
  s.state = SITE_STATE.IDLE;
  s.token = null;
  s.cookies = null;
  s.headers = null;
  s.user = null;
  s.savedAt = null;
  s.qrPath = "";
  s.lastError = "";
  try {
    if (fs.existsSync(storagePath(site.id))) fs.unlinkSync(storagePath(site.id));
  } catch {}
  return { site: site.id, ok: true, loggedIn: false };
}

/**
 * 执行站点配置的活动列表（自动签到/领积分等）。
 * @param {object} site 站点适配器
 * @param {Array}  activityDefs 活动定义数组（来自配置）
 * @returns {Promise<object>} 逐项结果
 */
export async function runActivities(site, activityDefs = []) {
  const s = getSession(site.id);
  const results = [];
  for (const def of activityDefs || []) {
    const item = { name: def.name, id: def.id || def.name, ok: false, message: "" };
    try {
      if (!s.token && !s.cookies) throw new Error("未登录，无法执行活动");
      const call = site.executeActivity
        ? () => site.executeActivity(s, def)
        : () => genericActivityCall(s, def);
      const r = await call();
      item.ok = !!r;
      item.data = r;
      item.message = r?.message || (r ? "ok" : "无响应");
    } catch (e) {
      item.message = e.message;
    }
    results.push(item);
  }
  return { site: site.id, results };
}

// 通用活动请求：按其定义的 method/path/headers/body 发一条鉴权请求。
async function genericActivityCall(s, def) {
  const headers = Object.assign({}, s.headers || {});
  if (s.token) headers["Authorization"] = `Bearer ${s.token}`;
  for (const [k, v] of Object.entries(def.headers || {})) headers[k] = v;
  const res = await fetch(`${def.baseUrl || ""}${def.path}`, {
    method: def.method || "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, headers),
    body: def.body ? JSON.stringify(def.body) : undefined,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = await res.text().catch(() => "");
  }
  return { status: res.status, body };
}

export { getSession };
