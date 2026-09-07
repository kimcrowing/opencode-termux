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
import { listOpencodeCredentials } from "./credential-sync.mjs";

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
// 每日自动任务调度（serve 存活期间定时检查日期变化，幂等补跑；dispose 时清理）。
const dailyTimers: ReturnType<typeof setInterval>[] = [];
const dailyRunning = new Map<string, boolean>();

async function runDailyOnce(cfg: any, provider: any) {
  const key = String(cfg.site || "");
  if (!key || dailyRunning.get(key)) return;
  dailyRunning.set(key, true);
  try {
    const merged = Object.assign({}, provider, { cfg });
    const r = await core.ensureDaily(merged, {});
    const n = (r.executed || []).length;
    if (n > 0) console.log(`[auth-login] daily ${key}: 执行 ${n} 个账户每日任务`);
  } catch (e: any) {
    console.error(`[auth-login] daily ${key} error: ${e.message}`);
  } finally {
    dailyRunning.delete(key);
  }
}

function startDailyScheduler(cfg: any, provider: any) {
  const intervalMin = Math.max(Number(cfg.dailyIntervalMin || 30) || 30, 5); // 至少 5 分钟
  const t = setInterval(() => runDailyOnce(cfg, provider), intervalMin * 60 * 1000);
  dailyTimers.push(t);
  // 启动后延迟 10s 首次执行（避让插件加载期；无 activities/无账户时 ensureDaily 自动跳过）
  setTimeout(() => runDailyOnce(cfg, provider), 10000);
}

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
      "account 缺省时写入账号池首个账户或注入所得的用户名。refreshToken 可选（刷新用），会随 cookies 持久化。" +
      "成功后 token 持久化，后续可跑活动；站点适配器支持时（如 codebuddy）同时同步进 opencode credential 表。",
    input: props({
      site: S("站点 id，如 gitcode"),
      token: S("access token"),
      refreshToken: S("refresh token（可选；存入 cookies.refresh_token 供 refresh() 续期使用）"),
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
        const r = await merged.manualToken(merged, {
          token: String(a.token || ""),
          refreshToken: a.refreshToken ? String(a.refreshToken) : undefined,
        });
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
        s.cookies = r.cookies || { access_token: r.token, refresh_token: (r as any).refreshToken || "" };
        s.headers = r.headers || { Authorization: `Bearer ${r.token}` };
        s.user = r.user || null;
        s.savedAt = Date.now();
        s.state = core.SITE_STATE.CONFIRMED;
        core.persistSession(siteId, accountId, s);
        // 方案 A：站点适配器支持时（codebuddy），把注入的 token 同步进 opencode credential 表
        const syncOut = { synced: false };
        if (typeof merged.syncCredentialSafe === "function") {
          try {
            const res = await merged.syncCredentialSafe({
              token: r.token,
              refresh: (r.cookies && r.cookies.refresh_token) || (r as any).refreshToken || "",
              label: accountId,
              makeActive: true,
            });
            syncOut.synced = true;
            syncOut.dbs = res && res.dbs;
          } catch {}
        }
        return { site: cfg.site, account: accountId, ok: true, loggedIn: true, user: s.user, syncedCredential: syncOut };
      }),
  },
  {
    name: "import_accounts",
    description:
      "从 opencode credential 表（opencode.db）导入某集成（integration_id）的现有 OAuth 凭据到本插件站点账号池。" +
      "典型场景：opencode 已登录过 codebuddy 多个账号（credential 表已有 access+refresh）→ 一键把全部账号加入 " +
      "auth-login 账号池，之后 auth_login_daily / run_activities 缺省遍历全部账户（多账户轮询切换）。",
    input: props({
      site: S("站点 id，如 codebuddy"),
      integration: S("opencode credential 表 integration_id（缺省用站点 id，如 codebuddy）"),
    }),
    options: { namespace: "auth_login" },
    execute: (a) =>
      toolResult(async () => {
        const cfg = siteOf(a);
        const provider = await loadProvider(cfg.site || (a.site as string));
        const siteId = provider.id || (a.site as string);
        const integration = String(a.integration || siteId);
        const creds = await listOpencodeCredentials(integration);
        if (!creds.length) {
          return {
            site: cfg.site,
            integration,
            ok: false,
            message: `credential 表中没有 integration_id="${integration}" 的 OAuth 凭据`,
          };
        }
        const imported = [];
        for (const c of creds) {
          const label = c.label || "default";
          // 用 provider.manualToken 构造会话（解出 user/headers/cookies）
          const r = await provider.manualToken(provider, { token: c.access, refreshToken: c.refresh });
          const s = core.getSession(siteId, label);
          s.token = r.token;
          s.cookies = r.cookies || { access_token: c.access, refresh_token: c.refresh };
          s.headers = r.headers || { Authorization: `Bearer ${c.access}` };
          s.user = r.user || null;
          s.savedAt = Date.now();
          s.state = core.SITE_STATE.CONFIRMED;
          core.persistSession(siteId, label, s);
          imported.push({
            account: label,
            loggedIn: true,
            expires: c.expires ? new Date(c.expires).toISOString() : null,
            activeInOpencode: c.active,
          });
        }
        return { site: cfg.site, integration, ok: true, imported };
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
    name: "daily",
    description:
      "【每日自动任务】对某站点账号池执行配置的每日活动（签到/领分/成长任务等），每天每账户最多一次（幂等）。" +
      "插件启动后会自动调度（serv开期间每 ~30 分钟检查日期变化补跑，重启丢失的当日任务下次启动补执行）；" +
      "此工具用于查看执行结果或手动触发。force=true 可无视当日已完成标记强制重跑。",
    input: props({
      site: S("站点 id，如 gitcode"),
      account: S("账户标识（user.username），可选；缺省对账号池全部账户执行"),
      force: B("true=忽略当日已完成标记强制重跑（默认 false）"),
    }),
    options: { namespace: "auth_login" },
    execute: (a) =>
      toolResult(async () => {
        const cfg = siteOf(a);
        const provider = await loadProvider(cfg.site || (a.site as string));
        const merged = Object.assign({}, provider, { cfg });
        const opts: any = {};
        if (a.account) opts.account = String(a.account);
        if (a.force) opts.force = true;
        return core.ensureDaily(merged, opts);
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

    // 【每日自动任务】对配置了每日活动的站点启动调度（默认开启；daily:false 关闭）。
    // 时序：注册完成后再启动，启动 10s 后首跑 + 每 ~30min 检查（ensureDaily 幂等，安全）。
    for (const [id, cfg] of Object.entries<any>(configured)) {
      const hasActivities = Array.isArray(cfg.activities) && cfg.activities.length > 0;
      if (!hasActivities || cfg.daily === false) continue;
      loadProvider(id)
        .then((provider) => startDailyScheduler(Object.assign({}, cfg, { site: cfg.site || id }), provider))
        .catch((e: any) => console.error(`[auth-login] daily scheduler ${id} init failed: ${e.message}`));
    }

    return async () => {
      for (const t of dailyTimers) clearInterval(t);
      dailyTimers.length = 0;
      await registration.dispose();
    };
  },
};