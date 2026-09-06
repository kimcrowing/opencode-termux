// providers/gitcode.mjs — GitCode (AtomGit) 扫码登录 + 签到活动适配器。
//
// GitCode 是 GitLab 系（国内 AtomGit）。它的网页端扫码登录走内部 SPA 接口，
// 无公开文档且字段随前端版本变动；因此本适配器做成【配置驱动】：
//   * 二维码内容 / 轮询接口 / 鉴权头的 URL、method、字段路径，都可在
//     opencode.json 的插件 options.sites.gitcode 里覆盖；抓包确认后填配置即可，
//     无需改插件代码。
//   * 提供了"可配置活动列表"：对每个活动发一条鉴权 GET/POST。
//
// 【登录形态】
//   方式 A（稳定）— OAuth 授权码：二维码内容 = GitCode OAuth 授权页 URL；
//     用户用手机扫码 → 打开授权页登录 → 授权后跳转 redirect_uri 带 code。
//     这是公开且稳定的接口。
//   方式 B（待抓包）— 纯扫码：若抓包拿到 GitCode 的 qrcode 生成接口与 scene
//     轮询接口，改用 sites.gitcode.qr.* 覆盖。
//
// 鉴权头：GitCode REST API v5 支持 `Authorization: Bearer <token>` 或
// `PRIVATE-TOKEN: <token>`。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { SITE_STATE } from "../core.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));

const API_BASE = "https://api.gitcode.com/api/v5";

// token 存储路径（由 core.startLogin 确认登录态后，手动注入也写到这里）。
function tokenFile(siteId) {
  return path.join(__dir, "storage", String(siteId), "token.txt");
}

export default {
  id: "gitcode",
  name: "GitCode",
  apiBase: API_BASE,
  pollIntervalMs: 3000,
  qrTimeoutMs: 120000,

  // 二维码内容：优先用配置里的 qr.generate；否则回退 OAuth 授权页。
  async loginUrl(s) {
    const cfg = s.cfg || {};
    const oauth = cfg.oauth || {};
    if (cfg.qr && cfg.qr.enabled) {
      if (!cfg.qr.generate_url) {
        throw new Error(
          "GitCode 纯扫码接口未配置(qr.generate_url)。请在 opencode.json 配置 sites.gitcode.qr.*，" +
            "或改用 OAuth 方式（配置 sites.gitcode.oauth）。"
        );
      }
      return buildUrl(cfg.qr.generate_url, cfg.qr.generate_params || {}, cfg.qr.separator || "?");
    }
    const base = oauth.authorize_url || "https://gitcode.com/oauth/authorize";
    const p = new URLSearchParams();
    p.set("client_id", oauth.client_id || "");
    p.set("redirect_uri", oauth.redirect_uri || "http://127.0.0.1/callback");
    p.set("response_type", "code");
    p.set("scope", oauth.scope || "read_user read_api");
    p.set("state", oauth.state || crypto.randomBytes(8).toString("hex"));
    return `${base}?${p.toString()}`;
  },

  // 轮询扫码/确认状态。
  // 纯扫码模式：调用 qr.check_url，按 qr.state_map 映射。
  // OAuth 模式：没有独立轮询，返回 pending（用户确认后由 manual token 注入）。
  async pollStatus(s) {
    const cfg = s.cfg || {};
    if (cfg.qr && cfg.qr.enabled && cfg.qr.check_url) {
      const url = buildUrl(cfg.qr.check_url, { scene_id: String(s.sceneId || "") }, cfg.qr.separator || "?");
      const res = await fetch(url, { headers: cfg.qr.headers || {} });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
      const stateVal = getPath(json, cfg.qr.state_path || "data.state");
      const map = cfg.qr.state_map || {
        scanned: "scanned",
        confirmed: "confirmed",
        expired: "expired",
      };
      if (stateVal === map.confirmed) {
        const token = getPath(json, cfg.qr.token_path || "data.token");
        try {
          fs.writeFileSync(tokenFile(this.id), String(token || ""), "utf-8");
        } catch {}
        return { state: SITE_STATE.CONFIRMED, token, cookies: json };
      }
      if (stateVal === map.scanned) return { state: SITE_STATE.SCANNED };
      if (stateVal === map.expired) return { state: SITE_STATE.EXPIRED };
      return { state: SITE_STATE.WAITING };
    }
    // OAuth 模式
    return { state: SITE_STATE.WAITING };
  },

  // 手动注入 token（OAuth 模式下用户拿到 code/token 后调用；或已抓包拿到 token）。
  async manualToken(s, opts) {
    const cfg = s.cfg || {};
    const token = opts?.token;
    if (!token) throw new Error("需要 token 参数");
    const headers = { Authorization: `Bearer ${token}` };
    let user = null;
    try {
      const res = await fetch((cfg.api_base || API_BASE) + "/user", { headers });
      if (res.ok) {
        const j = await res.json();
        user = j && j.data ? j.data : j;
      }
    } catch {}
    try {
      fs.writeFileSync(tokenFile(this.id), token, "utf-8");
    } catch {}
    return { token, user, headers };
  },

  // OAuth code → token 交换（POST /oauth/token）。
  async exchangeCode(s, code) {
    const cfg = s.cfg || {};
    const oauth = cfg.oauth || {};
    const body = new URLSearchParams();
    body.set("client_id", oauth.client_id || "");
    body.set("client_secret", oauth.client_secret || "");
    body.set("code", code);
    body.set("grant_type", "authorization_code");
    body.set("redirect_uri", oauth.redirect_uri || "http://127.0.0.1/callback");
    const tokenUrl = oauth.token_url || "https://gitcode.com/oauth/token";
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const j = await res.json();
    if (!j.access_token) throw new Error(`OAuth token 交换失败: ${JSON.stringify(j)}`);
    return j.access_token;
  },

  // 鉴权请求头
  headers(token) {
    return token ? { Authorization: `Bearer ${token}` } : {};
  },
};

function buildUrl(url, params, sep) {
  const qs = new URLSearchParams(params).toString();
  return qs ? `${url}${sep}${qs}` : url;
}

function getPath(obj, pathStr) {
  if (!obj || !pathStr) return undefined;
  return String(pathStr)
    .split(".")
    .reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
