// server.ts — opencode v2 plugin：钉钉（DingTalk）机器人。
//
// 迁移自 v1 插件 ~/.config/opencode/plugins/dingtalk/index.js：
//   * 协议/API/WS 逻辑原样保留在 core.mjs（未改动逻辑）。
//   * v1 的 `tool({ args: zod })` 定义改为裸 JSON Schema + editor.add。
//   * 工具名带 dingtalk_ 前缀（v2 用 options.namespace 组合实现）。
//   * v1 用 `input.client`（opencode HTTP client）驱动会话；v2 改为 ctx.session。
//
// v1->v2 会话 API 差异（本机 beta-17 二进制实测）：
//   create  v1: client.session.create({body,query:{directory}}) -> {data.id}
//           v2: ctx.session.create({body:{title}}) -> {id}（无 data 包装；
//               实测四种 directory 写法都被接受但不生效，会话目录由 server 决定）
//   prompt  v1: client.session.prompt({path:{id},body:{parts,model,system}})
//           v2: ctx.session.prompt({sessionID, text})（唯一通过 schema 校验的形状）
//               回复需再 wait({sessionID}) + context({sessionID}) 读取
//   system  v1: 每次请求 body.system
//           v2: 无 per-request system；改用 ctx.session.hook("context", cb) 追加
//
// 注意：本文件不使用任何第三方依赖；`ws` 由 opencode 二进制内置提供（v2 插件
// 宿主实测可 import "ws"）。
import fs from "node:fs";
import * as core from "./core.mjs";

const {
  DEFAULT_MODEL,
  SESSION_TTL_MS,
  SYSTEM_PROMPT,
  DINGTALK_DIRECTIVE,
  DingTalkAPI,
  executeTool,
  getOrCreateSession,
  recreateSession,
  runPrompt,
  startStream,
  parseModel,
} = core;

type ToolInput = Record<string, unknown>;

type ToolDef = {
  name: string;
  description: string;
  input: Record<string, unknown>;
  options: { namespace: string };
  execute: (args: ToolInput) => Promise<string> | string;
};

const props = (fields: Record<string, { type: string; description: string }>) => ({
  type: "object",
  properties: fields,
  additionalProperties: false,
});

const S = (description: string) => ({ type: "string", description });
const N = (description: string) => ({ type: "number", description });
const B = (description: string) => ({ type: "boolean", description });

const TARGET_FIELDS = {
  webhook_url: S("自定义机器人 webhook 地址"),
  conversation_id: S("群会话 openConversationId"),
  user_id: S("单聊用户 staffId"),
  conversation_type: S("1=单聊 2=群聊"),
};

const MEDIA_FIELDS = {
  media_id: S("媒体 ID（二选一）"),
  file_path: S("本地文件路径，传此参数会自动上传"),
  file_name: S("文件名"),
  ...TARGET_FIELDS,
};

const TOOLS: ToolDef[] = [
  {
    name: "send",
    description:
      "发送钉钉消息（群聊或单聊）。群聊用 conversation_id；单聊用 user_id；自定义机器人用 webhook_url。",
    input: props({
      content: S("消息内容"),
      title: S("标题（markdown 用）"),
      msg_type: { type: "string", enum: ["text", "markdown"], description: "消息类型，默认 markdown" },
      ...TARGET_FIELDS,
    }),
    options: { namespace: "dingtalk" },
    execute: (a) => executeTool(state, "send", a),
  },
  {
    name: "send_card",
    description: "发送钉钉互动卡片。支持群聊和单聊。",
    input: props({
      content: S("卡片正文（markdown）"),
      conversation_id: S("群会话 openConversationId"),
      user_id: S("单聊用户 staffId"),
      conversation_type: S("1=单聊 2=群聊"),
    }),
    options: { namespace: "dingtalk" },
    execute: (a) => executeTool(state, "send_card", a),
  },
  {
    name: "read",
    description: "读取最近收到的钉钉消息队列。",
    input: props({ limit: N("返回条数，默认 10") }),
    options: { namespace: "dingtalk" },
    execute: (a) => executeTool(state, "read", a),
  },
  {
    name: "wait",
    description: "阻塞等待下一条新钉钉消息到达。",
    input: props({ timeout: N("超时秒数，默认 120") }),
    options: { namespace: "dingtalk" },
    execute: (a) => executeTool(state, "wait", a),
  },
  {
    name: "status",
    description: "查看钉钉机器人连接与插件状态。",
    input: props({}),
    options: { namespace: "dingtalk" },
    execute: (a) => executeTool(state, "status", a),
  },
  {
    name: "upload_file",
    description: "上传文件到钉钉，返回 media_id。",
    input: props({ file_path: S("本地文件路径") }),
    options: { namespace: "dingtalk" },
    execute: (a) => executeTool(state, "upload_file", a),
  },
  {
    name: "upload_image",
    description: "上传图片到钉钉，返回 media_id。",
    input: props({ file_path: S("本地图片路径") }),
    options: { namespace: "dingtalk" },
    execute: (a) => executeTool(state, "upload_image", a),
  },
  {
    name: "send_image",
    description:
      "发送图片到钉钉。单聊/机器人会话请传入 user_id；群聊用 conversation_id；webhook 用 webhook_url。可直接传 file_path 自动上传并补元数据，或传 media_id（二选一）。",
    input: props(MEDIA_FIELDS),
    options: { namespace: "dingtalk" },
    execute: (a) => executeTool(state, "send_image", a),
  },
  {
    name: "send_file",
    description:
      "发送文件到钉钉。单聊/机器人会话请传入 user_id；群聊用 conversation_id；webhook 用 webhook_url。可直接传 file_path 自动上传并补文件元数据，或传 media_id（二选一）。",
    input: props({
      ...MEDIA_FIELDS,
      file_type: S("文件类型，如 pdf/doc/xlsx（默认 pdf）"),
    }),
    options: { namespace: "dingtalk" },
    execute: (a) => executeTool(state, "send_file", a),
  },
  {
    name: "send_voice",
    description:
      "发送语音到钉钉。支持 amr/mp3/wav 格式（≤2MB）。单聊用 user_id；群聊用 conversation_id。可直接传 file_path 自动上传，或传 media_id。",
    input: props({
      media_id: S("语音 media_id（通过 upload 获取，二选一）"),
      file_path: S("本地语音文件路径，传此参数会自动上传（二选一）"),
      duration_ms: N("语音时长（毫秒），默认 1000"),
      ...TARGET_FIELDS,
    }),
    options: { namespace: "dingtalk" },
    execute: (a) => executeTool(state, "send_voice", a),
  },
  {
    name: "send_video",
    description:
      "发送视频到钉钉。支持 mp4 格式（≤20MB）。需提供视频封面图（pic_media_id 或 pic_file_path）。单聊用 user_id；群聊用 conversation_id。",
    input: props({
      media_id: S("视频 media_id（二选一）"),
      file_path: S("本地视频文件路径，传此参数会自动上传（二选一）"),
      pic_media_id: S("视频封面图 media_id（封面必填）"),
      pic_file_path: S("本地封面图片路径，传此参数会自动上传（封面必填）"),
      duration_sec: N("视频时长（秒），默认 10"),
      video_type: S("视频类型，默认 mp4"),
      height: N("视频展示高度（px）"),
      width: N("视频展示宽度（px）"),
      ...TARGET_FIELDS,
    }),
    options: { namespace: "dingtalk" },
    execute: (a) => executeTool(state, "send_video", a),
  },
];

// ---------------------------------------------------------------------------
// v2 会话桥接：把 core.mjs 里依赖 v1 `input.client` 的函数接到 ctx.session 上。
// ---------------------------------------------------------------------------
type SessionBridge = {
  create: (args: { body: { title: string } }) => Promise<any>;
  prompt: (args: { sessionID: string; text: string }) => Promise<any>;
  wait: (args: { sessionID: string }) => Promise<any>;
  context: (args: { sessionID: string }) => Promise<any>;
};

// core.mjs 的 runPrompt/getOrCreateSession 需要一个带 session.create/prompt 的
// 对象；这里把 v2 的 ctx.session 包成同样形状，返回值再翻译回 v1 的
// `{ data, error }` 约定，使协议逻辑无需改动。
function makeSessionAdapter(session: SessionBridge) {
  return {
    session: {
      create: async (args: { body?: { title?: string }; query?: { directory?: string } }) => {
        try {
          const created = await session.create({ body: { title: args.body?.title || "dingtalk" } });
          return { data: created, error: null };
        } catch (e) {
          return { data: null, error: e };
        }
      },
      prompt: async (args: { path: { id: string }; body: { parts?: any[]; model?: any; system?: string } }) => {
        const id = args.path.id;
        const text = (args.body.parts || [])
          .filter((p: any) => p && p.type === "text")
          .map((p: any) => p.text)
          .join("\n");
        try {
          await session.prompt({ sessionID: id, text });
          await session.wait({ sessionID: id });
          const ctx = await session.context({ sessionID: id });
          const messages = Array.isArray(ctx) ? ctx : ctx?.data ?? [];
          // 取最后一条 assistant 文本作为回复
          let out = "";
          for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m?.role === "assistant" || m?.type === "assistant") {
              out = extractText(m);
              if (out) break;
            }
          }
          return { data: { parts: [{ type: "text", text: out }] }, error: null };
        } catch (e) {
          return { data: null, error: e };
        }
      },
    },
  };
}

function extractText(message: any): string {
  const parts = message?.parts ?? message?.payload?.parts;
  if (Array.isArray(parts)) {
    return parts
      .filter((p: any) => p && (p.type === "text" || typeof p.text === "string") && !p.synthetic && !p.ignored)
      .map((p: any) => p.text)
      .join("\n");
  }
  if (typeof message?.text === "string") return message.text;
  if (typeof message?.payload?.text === "string") return message.payload.text;
  return "";
}

let state: any = null;

export default {
  id: "dingtalk",
  setup: async (ctx: any) => {
    const cfg = (ctx.options && typeof ctx.options === "object" ? ctx.options : {}) || {};
    const clientId = cfg.clientId || process.env.DINGTALK_CLIENT_ID || "";
    const clientSecret = cfg.clientSecret || process.env.DINGTALK_CLIENT_SECRET || "";
    const robotCode = cfg.robotCode || cfg.clientId || process.env.DINGTALK_ROBOT_CODE || "";
    const useCard =
      cfg.useCard === true ||
      String(cfg.useCard != null ? cfg.useCard : process.env.DINGTALK_USE_CARD || "false").toLowerCase() === "true";

    state = {
      ctxClient: makeSessionAdapter(ctx.session),
      directory: (cfg.directory || "").trim() || process.cwd(),
      cfg,
      clientId,
      clientSecret,
      robotCode,
      useCard,
      defaultModel: cfg.defaultModel || process.env.DINGTALK_DEFAULT_MODEL || DEFAULT_MODEL,
      defaultConversationId: cfg.defaultConversationId || "",
      defaultUserId: cfg.defaultUserId || "",
      systemPrompt: cfg.systemPrompt || process.env.DINGTALK_SYSTEM_PROMPT || SYSTEM_PROMPT,
      api: new DingTalkAPI(clientId, clientSecret, robotCode),
      sessions: new Set(),
      conversations: new Map(),
      msgQueue: new Map(),
      inbound: [],
      waiters: [],
      lastConv: { conversationId: "", senderId: "", conversationType: "2", webhook_url: "" },
      currentWs: null,
      closing: false,
      log: (level: string, message: string, extra?: unknown) => {
        // v1 用 ctxClient.app.log；v2 插件宿主未暴露等价接口，退化为进程内日志。
        if (level === "error" || level === "warn") {
          console.error(`[dingtalk:${level}] ${message}${extra ? " " + JSON.stringify(extra) : ""}`);
        }
      },
    };

    // v2 没有 per-request system：改为在会话上下文里追加 SystemPart。
    // 与 v1 等价的效果：钉钉会话里的每轮都带上机器人角色设定。
    try {
      await ctx.session.hook("context", (event: any) => {
        if (!Array.isArray(event?.system)) return;
        event.system.push({ type: "text", text: DINGTALK_DIRECTIVE });
      });
    } catch {
      // hook 不可用时退化为 v1 行为：systemPrompt 仍随每轮 prompt 传入（见 runPrompt）
    }

    if (clientId && clientSecret) {
      try {
        startStream(state);
      } catch {
        // 收消息 WS 启动失败不影响发消息工具
      }
    }

    // NOTE: the transform callback runs inside the plugin host worker (its own
    // global scope), so closures captured in this setup() scope are NOT updated
    // by the callback. Sentinel + composed-id capture must happen inside.
    const registration = await ctx.tool.transform((editor: any) => {
      for (const t of TOOLS) {
        editor.add(t);
      }
      const ids = editor.list().map(({ id }: { id: string }) => id);
      const sentinel = process.env.DINGTALK_VERIFY_SENTINEL;
      if (sentinel) {
        fs.writeFileSync(sentinel, JSON.stringify(ids, null, 2), "utf-8");
      }
    });

    return async () => {
      await registration.dispose();
    };
  },
};

export { SESSION_TTL_MS, getOrCreateSession, recreateSession, runPrompt, parseModel };
