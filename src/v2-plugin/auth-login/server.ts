// server.ts — opencode v2 插件：通用扫码登录（auth-login）。
//
// 一个与具体网站解耦的扫码登录框架：
//   * 生成二维码 → 渲染为 PNG（storage/<site>/qr-*.png）+ ASCII，让用户在
//     opencode web UI 里扫码（ASCII 直接显示；PNG 可用 read 工具在 UI 渲染）。
//   * 后台轮询扫码/确认状态，拿到 token/cookies 后持久化到 storage/<site>.json。
//   * 可配置的活动列表（自动签到/领积分），对每个活动自动发鉴权请求并汇总。
//
// 每个网站只需要一个"provider 适配器"（providers/<site>.mjs），描述二维码内容、
// 轮询接口、鉴权头。当前内置 GitCode；在 opencode.json 的插件 options 里配置站点
// 与活动列表即可。框架逻辑（core.mjs）与具体网站无关，接入新网站零改框架。
//
// 工具 ID = namespace(`auth_login`) + `_` + name，如 auth_login_login / auth_login_status。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as core from "./core.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));

type ToolInput = Record<string, unknown>;

type ToolDef = {
  name: string;
  description: string;
  input: Record<string, unknown>;
  options: { namespace: string };
  execute: (args: ToolInput) => Promise<string> | string | Promise<{ output: string }> | { output: string };
};

const props = (fields: Record<string, { type: string; description: string }>) => ({
  type: "object",
  properties: fields,
  additionalProperties: false,
});
const S = (description: string) => ({ type: "string", description });
const N = (description: string) => ({ type: "number", description });
const B = (description: string) => ({ type: "boolean", description });

// 站点配置（来自 opencode.json options.sites）与已加载的 provider。
let sites: Record<string, any> = {};
let providers: Record<string, any> = {};

async function loadProvider(siteId: string) {
  if (providers[siteId]) return providers[siteId];
  const file = path.join(__dir, "providers", `${siteId}.mjs`);
  if (!fs.existsSync(file)) {
    throw new Error(`未找到站点适配器 providers/${siteId}.mjs`);
  }
  const mod = await import(pathToFileURL(file).href);
  providers[siteId] = mod.default;
  return providers[siteId];
}

function siteOf(args: ToolInput): any {
  const id = String(args.site || "");
  if (!id) throw new Error("缺少参数 site");
  const cfg = sites[id];
  if (!cfg) {
    throw new Error(`未配置站点 "${id}"，请在 opencode.json 的插件 options.sites 中配置`);
  }
  return cfg;
}

// 每个工具的执行体，统一返回 { content: string }。
async function toolResult(fn: () => Promise<unknown>): Promise<{ content: string }> {
  try {
    const r = await fn();
    const content = typeof r === "string" ? r : JSON.stringify(r, null, 2);
    return { content };
  } catch (e: any) {
    return { content: JSON.stringify({ ok: false, error: e.message }, null, 2) };
  }
}

const TOOLS: ToolDef[] = [
  {
    name: "sites",
    description:
      "列出已配置的扫码登录站点（来自 opencode.json 插件 options.sites）及其活动列表。",
    input: props({}),
    options: { namespace: "auth_login" },
    execute: (a) =>
      toolResult(async () => {
        const list = Object.entries(sites).map(([id, cfg]) => ({
          site: id,
          name: cfg.name || id,
          activities: (cfg.activities || []).map((x: any) => x.name),
        }));
        return { sites: list };
      }),
  },
  {
    name: "login",
    description:
      "发起某网站的扫码登录：生成二维码（PNG 落盘 + 返回 ASCII 与文件路径），并在后台轮询扫码确认。调用后请把二维码呈现给用户，等用户扫码确认后调用 auth_login_status 查结果。",
    input: props({
      site: S("站点 id，如 gitcode"),
    }),
    options: { namespace: "auth_login" },
    execute: (a) =>
      toolResult(async () => {
        const cfg = siteOf(a);
        const provider = await loadProvider(cfg.site || (a.site as string));
        const providerWithCfg = Object.assign({}, provider, { cfg });
        const r = await core.startLogin(providerWithCfg, {});
        return { ...r, qrPath: r.qrPath || "" };
      }),
  },
  {
    name: "status",
    description: "查询某网站当前的登录状态（未登录/等待扫码/已扫码/已确认/已过期），以及是否持有 token。",
    input: props({
      site: S("站点 id，如 gitcode"),
    }),
    options: { namespace: "auth_login" },
    execute: (a) =>
      toolResult(async () => {
        const cfg = siteOf(a);
        const provider = await loadProvider(cfg.site || (a.site as string));
        return core.getStatus(Object.assign({}, provider, { cfg }));
      }),
  },
  {
    name: "token",
    description: "获取某网站当前的有效 access token（若已登录）。",
    input: props({
      site: S("站点 id，如 gitcode"),
    }),
    options: { namespace: "auth_login" },
    execute: (a) =>
      toolResult(async () => {
        const cfg = siteOf(a);
        const provider = await loadProvider(cfg.site || (a.site as string));
        const s = core.getStatus(Object.assign({}, provider, { cfg }));
        if (!s.token) return { site: s.site, loggedIn: false, token: null };
        return { site: s.site, loggedIn: true, token: s.token };
      }),
  },
  {
    name: "refresh",
    description: "刷新某网站的 token（若站点适配器支持；如 GitCode OAuth token 过 15 天可刷新）。",
    input: props({
      site: S("站点 id，如 gitcode"),
    }),
    options: { namespace: "auth_login" },
    execute: (a) =>
      toolResult(async () => {
        const cfg = siteOf(a);
        const provider = await loadProvider(cfg.site || (a.site as string));
        return core.forceRefresh(Object.assign({}, provider, { cfg }));
      }),
  },
  {
    name: "logout",
    description: "清除某网站的本地登录态（token/cookies），并停止二维码轮询。",
    input: props({
      site: S("站点 id，如 gitcode"),
    }),
    options: { namespace: "auth_login" },
    execute: (a) =>
      toolResult(async () => {
        const cfg = siteOf(a);
        const provider = await loadProvider(cfg.site || (a.site as string));
        return core.logout(Object.assign({}, provider, { cfg }));
      }),
  },
  {
    name: "manual_token",
    description:
      "手动注入某网站的 access token（用于 OAuth 授权码流程完成登录，或把抓包得到的 token 直接写入本地登录态）。成功后 token 持久化，后续可跑活动。",
    input: props({
      site: S("站点 id，如 gitcode"),
      token: S("access token"),
    }),
    options: { namespace: "auth_login" },
    execute: (a) =>
      toolResult(async () => {
        const cfg = siteOf(a);
        const provider = await loadProvider(cfg.site || (a.site as string));
        const merged = Object.assign({}, provider, { cfg });
        if (!merged.manualToken) {
          return { site: cfg.site, ok: false, message: "该站点适配器未实现 manualToken()" };
        }
        const r = await merged.manualToken(merged, { token: String(a.token || "") });
        // 写入 core 会话
        const s = core.getSession(provider.id || a.site);
        s.token = r.token;
        s.headers = r.headers || { Authorization: `Bearer ${r.token}` };
        s.user = r.user || null;
        s.savedAt = Date.now();
        s.state = core.SITE_STATE.CONFIRMED;
        core.persistSession(siteOf(a).site || (a.site as string), s);
        return { site: cfg.site, ok: true, loggedIn: true, user: s.user };
      }),
  },
  {
    name: "run_activities",
    description:
      "对某网站执行配置的自动签到/活动列表（每个活动按定义发一条鉴权请求）。返回逐项结果。",
    input: props({
      site: S("站点 id，如 gitcode"),
    }),
    options: { namespace: "auth_login" },
    execute: (a) =>
      toolResult(async () => {
        const cfg = siteOf(a);
        const provider = await loadProvider(cfg.site || (a.site as string));
        const activities = Array.isArray(cfg.activities) ? cfg.activities : [];
        if (!activities.length) {
          return { site: cfg.site, ok: false, message: "该站点未配置任何活动" };
        }
        return core.runActivities(Object.assign({}, provider, { cfg }), activities);
      }),
  },
  {
    name: "render_qr",
    description:
      "把任意文本渲染成二维码（PNG 落盘 + ASCII 返回）。用于把非登录字符串（如某链接）也生成二维码。",
    input: props({
      text: S("要编码成二维码的文本"),
      site: S("站点 id（用于决定落盘目录），可选"),
    }),
    options: { namespace: "auth_login" },
    execute: (a) =>
      toolResult(async () => {
        const text = String(a.text || "");
        if (!text) throw new Error("缺少参数 text");
        const { renderQrToFile } = await import("./provider-qr.mjs");
        const out = await renderQrToFile(String(a.site || "misc"), text);
        return { text, path: out.path, ascii: out.ascii };
      }),
  },
  {
    name: "qr_image_path",
    description:
      "返回某站点最近一次生成的二维码 PNG 文件路径，供模型用 read 工具读取后在 web UI 直接渲染显示。",
    input: props({
      site: S("站点 id，如 gitcode"),
    }),
    options: { namespace: "auth_login" },
    execute: (a) =>
      toolResult(async () => {
        const cfg = siteOf(a);
        const provider = await loadProvider(cfg.site || (a.site as string));
        const s = core.getSession(provider.id || a.site);
        return { site: cfg.site, qrPath: s.qrPath || "" };
      }),
  },
];

export default {
  id: "auth-login",
  setup: async (ctx: any) => {
    const options = (ctx.options && typeof ctx.options === "object" ? ctx.options : {}) || {};
    const configured = (options.sites && typeof options.sites === "object" ? options.sites : {}) || {};
    sites = configured;
    // 每个站点配置补上 site 字段与默认活动
    for (const [id, cfg] of Object.entries<any>(configured)) {
      cfg.site = cfg.site || id;
      cfg.activities = cfg.activities || [];
    }

    const registration = await ctx.tool.transform((editor: any) => {
      for (const t of TOOLS) {
        const base = t.execute;
        editor.add({
          ...t,
          execute: async (...a: any[]) => {
            const r = await base(...a);
            if (r && typeof r === "object" && !Array.isArray(r) && typeof (r as { content?: unknown }).content === "string") {
              return r;
            }
            return { content: typeof r === "string" ? r : JSON.stringify(r) };
          },
        });
      }
      const sentinel = process.env.AUTH_LOGIN_VERIFY_SENTINEL;
      if (sentinel) {
        const ids = editor.list().map(({ id }: { id: string }) => id);
        fs.writeFileSync(sentinel, JSON.stringify(ids, null, 2), "utf-8");
      }
    });

    return async () => {
      await registration.dispose();
    };
  },
};
