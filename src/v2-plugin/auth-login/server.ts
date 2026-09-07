// server.ts — opencode v2 插件：通用扫码登录（auth-login）。
//
// 一个与具体网站解耦的扫码登录框架：
//   * 生成二维码 → 渲染为 PNG（storage/<site>/qr-*.png）+ ASCII，让用户在
//     opencode web UI 里扫码（ASCII 直接显示；PNG 可用 read 工具在 UI 渲染）。
//   * 后台轮询扫码/确认状态，拿到 token/cookies 后持久化到 storage/<site>/accounts/<user>.json。
//   * 【账号池】每个站点可维护多个账户（一次扫码成功 = 一个账户）：
//       login mode=add（默认）新扫码加入池；mode=update 对指定账户重新扫码续期/换 token。
//       run_activities 可指定单账户（account 参数）或遍历全部账户（缺省）。
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
      "列出已配置的扫码登录站点（来自 opencode.json 插件 options.sites）及其活动列表、账号池概览。",
    input: props({}),
    options: { namespace: "auth_login" },
    execute: (a) =>
      toolResult(async () => {
        const list = Object.entries(sites).map(([id, cfg]) => ({
          site: id,
          name: cfg.name || id,
          activities: (cfg.activities || []).map((x: any) => x.name),
          accounts: core.listAccounts(id).map((x: any) => ({
            account: x.account,
            user: x.user,
            loggedIn: x.loggedIn,
          })),
        }));
        return { sites: list };
      }),
  },
  {
    name: "login",
    description:
      "发起某网站的扫码登录：生成二维码（PNG 落盘 + 返回 ASCII 与文件路径），并在后台轮询扫码确认。" +
      "【两种场景】mode=add（默认）新增账户入账号池；mode=update 对指定 account 重新扫码以更新/续期其 token。" +
      "调用后请把二维码呈现给用户，等用户扫码确认后调用 auth_login_status 查结果。",
    input: props({
      site: S("站点 id，如 gitcode"),
      mode: S("扫码场景：add=新增账户（默认）；update=更新指定已有账户（重新扫码覆盖其 token）"),
      account: S("账户标识（user.username）。update 模式必填；add 模式可选（不填则确认后自动以用户名入池）"),
    }),
    options: { namespace: "auth_login" },
    execute: (a) =>
      toolResult(async () => {
        const cfg = siteOf(a);
        const provider = await loadProvider(cfg.site || (a.site as string));
        const providerWithCfg = Object.assign({}, provider, { cfg });
        const opts: any = {};
        if (a.mode) opts.mode = String(a.mode);
        if (a.account) opts.account = String(a.account);
        const r = await core.startLogin(providerWithCfg, opts);
        return { ...r, qrPath: r.qrPath || "" };
      }),
  },
  {
    name: "accounts",
    description:
      "列出某站点账号池中的全部账户（一次成功扫码登录 = 一个账户），含登录用户、保存时间与登录状态。多账户时活动执行默认遍历全部账户。",
    input: props({
      site: S("站点 id，如 gitcode"),
    }),
    options: { namespace: "auth_login" },
    execute: (a) =>
      toolResult(async () => {
        const cfg = siteOf(a);
        const provider = await loadProvider(cfg.site || (a.site as string));
        return { site: cfg.site, accounts: core.listAccounts(provider.id || (a.site as string)) };
      }),
  },
  {
    name: "status",
    description:
      "查询某网站的登录状态。不传 account 返回账号池全部账户状态；传 account 只返回该账户（未登录/等待扫码/已扫码/已确认/已过期）及是否持有 token。",
    input: props({
      site: S("站点 id，如 gitcode"),
      account: S("账户标识（user.username），可选；缺省返回站点全部账户状态"),
    }),
    options: { namespace: "auth_login" },
    execute: (a) =>
      toolResult(async () => {
        const cfg = siteOf(a);
        const provider = await loadProvider(cfg.site || (a.site as string));
        const merged = Object.assign({}, provider, { cfg });
        return a.account ? core.getStatus(merged, String(a.account)) : core.getStatus(merged);
      }),
  },
  {
    name: "token",
    description:
      "获取某网站指定账户（缺省账号池首个）当前的有效 access token（若已登录）。多账户未指定 account 时只列账户登录态、不打印 token。",
    input: props({
      site: S("站点 id，如 gitcode"),
      account: S("账户标识（user.username），可选；缺省取账号池首个账户"),
    }),
    options: { namespace: "auth_login" },
    execute: (a) =>
      toolResult(async () => {
        const cfg = siteOf(a);
        const provider = await loadProvider(cfg.site || (a.site as string));
        const merged = Object.assign({}, provider, { cfg });
        const st = a.account ? core.getStatus(merged, String(a.account)) : core.getStatus(merged);
        if (st.accounts && Array.isArray(st.accounts)) {
          // 未指定账户且账号池多账户：只列账户与登录态，不打印 token
          return {
            site: st.site,
            accounts: st.accounts.map((x: any) => ({
              account: x.account,
              loggedIn: !!x.token,
              user: x.user,
            })),
          };
        }
        if (!st.token) return { site: st.site, account: st.account || "", loggedIn: false, token: null };
        return { site: st.site, account: st.account || "", loggedIn: true, token: st.token, user: st.user };
      }),
  },
  {
    name: "refresh",
    description: "刷新某站点指定账户（缺省账号池首个）的 token（若站点适配器支持；如 GitCode OAuth token 过 15 天可刷新）。",
    input: props({
      site: S("站点 id，如 gitcode"),
      account: S("账户标识（user.username），可选；缺省取账号池首个账户"),
    }),
    options: { namespace: "auth_login" },
    execute: (a) =>
      toolResult(async () => {
        const cfg = siteOf(a);
        const provider = await loadProvider(cfg.site || (a.site as string));
        const merged = Object.assign({}, provider, { cfg });
        return core.forceRefresh(merged, a.account ? String(a.account) : undefined);
      }),
  },
  {
    name: "logout",
    description:
      "清除某网站的本地登录态（token/cookies）并停止二维码轮询。有 account 只清该账户；缺省清空该站点账号池全部账户。",
    input: props({
      site: S("站点 id，如 gitcode"),
      account: S("账户标识（user.username），可选；缺省清空全站账号池"),
    }),
    options: { namespace: "auth_login" },
    execute: (a) =>
      toolResult(async () => {
        const cfg = siteOf(a);
        const provider = await loadProvider(cfg.site || (a.site as string));
        const merged = Object.assign({}, provider, { cfg });
        return core.logout(merged, a.account ? String(a.account) : undefined);
      }),
  },
  {
    name: "manual_token",
    description:
      "手动注入某网站的 access token 到指定账户（用于 OAuth 授权码流程完成登录，或把抓包得到的 token 直接写入本地登录态）。" +
      "account 缺省时写入账号池首个账户或注入所得的用户名。成功后 token 持久化，后续可跑活动。",
    input: props({
      site: S("站点 id，如 gitcode"),
      token: S("access token"),
      account: S("目标账户标识（user.username），可选；缺省取账号池首个账户，池空则用 token 对应用户名"),
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
        // 确定账户槽位：优先 a.account → 账号池首个 → provider 解析出的用户名 → default
        const siteId = provider.id || (a.site as string);
        let accountId = a.account ? String(a.account) : "";
        if (!accountId) {
          const ids = core.accountIds(siteId);
          accountId = ids[0] || (r.user && (r.user.username || r.user.name)) || "default";
        }
        // 写入 core 会话（指定账户槽）
        const s = core.getSession(siteId, accountId);
        s.token = r.token;
        s.headers = r.headers || { Authorization: `Bearer ${r.token}` };
        s.user = r.user || null;
        s.savedAt = Date.now();
        s.state = core.SITE_STATE.CONFIRMED;
        core.persistSession(siteId, accountId, s);
        return { site: cfg.site, account: accountId, ok: true, loggedIn: true, user: s.user };
      }),
  },
  {
    name: "run_activities",
    description:
      "对某网站执行配置的自动签到/活动列表（每个活动按定义发一条鉴权请求），返回逐项结果。" +
      "有 account 只执行该账户；缺省遍历账号池全部账户。",
    input: props({
      site: S("站点 id，如 gitcode"),
      account: S("账户标识（user.username），可选；缺省对所有账户执行活动"),
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
        const opts = a.account ? { account: String(a.account) } : {};
        return core.runActivities(Object.assign({}, provider, { cfg }), activities, opts);
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
      "返回某站点指定账户（缺省账号池首个）最近一次生成的二维码 PNG 文件路径，供模型用 read 工具读取后在 web UI 直接渲染显示。",
    input: props({
      site: S("站点 id，如 gitcode"),
      account: S("账户标识（user.username），可选；缺省取账号池首个账户"),
    }),
    options: { namespace: "auth_login" },
    execute: (a) =>
      toolResult(async () => {
        const cfg = siteOf(a);
        const provider = await loadProvider(cfg.site || (a.site as string));
        const siteId = provider.id || (a.site as string);
        const s = core.getSession(siteId, a.account ? String(a.account) : undefined);
        return { site: cfg.site, account: s._accountId || "", qrPath: s.qrPath || "" };
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