// core.mjs — 钉钉机器人协议实现（自包含）。
// v2 迁移：工具注册与插件入口在 server.ts，本文件只保留协议逻辑。
// 已修复：真实回调帧 type 在顶层（frame.type 而非 headers.type）。
import { WebSocket } from "ws";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";


const __dir = path.dirname(fileURLToPath(import.meta.url));
function fileLog(line) {
  try {
    appendFileSync(path.join(__dir, "_debug.log"), new Date().toISOString() + " " + line + "\n");
  } catch (_) {}
}

const CARD_TEMPLATE_ID = "e84db5bd-8c5b-480e-a339-03cbad06c7bb.schema";
const TOKEN_URL = "https://oapi.dingtalk.com";
const API_BASE = "https://api.dingtalk.com";
const REGISTER_URL = "https://api.dingtalk.com/v1.0/gateway/connections/open";
const SUBSCRIBE_TOPIC = "/v1.0/im/bot/messages/get";
const SUBSCRIBE_TOPIC_GROUP = "/v1.0/im/bot/groupMessages/get";
const DEFAULT_MODEL = "opencode/big-pickle";

const CHUNK_SIZE = 4000;
const MAX_CHUNKS = 8;
const SESSION_TTL_MS = 30 * 60 * 1000;

const HELP_TEXT = [
  "**钉钉机器人命令列表**",
  "",
  "发送任意文本给我，我会用 AI 回复",
  "",
  "**命令:**",
  "- `/reset` / `/clear` - 重置当前会话",
  "- `/models` - 列出可用模型",
  "- `/model <provider/model>` - 切换当前会话模型",
  "- `/status` - 查看连接状态",
  "- `/help` - 显示此帮助",
  "- `/sendfile <本地路径>` - 发送本地文件",
  "- `中断` / `cancel` / `stop` - 中止当前处理",
].join("\n");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readFileBytes(filePath) {
  if (globalThis.Bun && Bun.file) {
    return new Uint8Array(await Bun.file(filePath).arrayBuffer());
  }
  const { readFile } = await import("node:fs/promises");
  return new Uint8Array(await readFile(filePath));
}

class DingTalkAPI {
  constructor(clientId, clientSecret, robotCode) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.robotCode = robotCode;
    this.accessToken = null;
    this.expiresAt = 0;
  }

  async getAccessToken() {
    if (this.accessToken && Date.now() < this.expiresAt) return this.accessToken;
    const url =
      TOKEN_URL +
      "/gettoken?appkey=" +
      encodeURIComponent(this.clientId) +
      "&appsecret=" +
      encodeURIComponent(this.clientSecret);
    const resp = await fetch(url);
    const data = await resp.json();
    if (!data.access_token) throw new Error("gettoken failed: " + (data.errmsg || "unknown"));
    const expiresIn = parseInt(data.expires_in || "7200", 10);
    this.accessToken = data.access_token;
    this.expiresAt = Date.now() + (expiresIn - 300) * 1000;
    return this.accessToken;
  }

  async _post(url, body, token) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-acs-dingtalk-access-token": token },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status + " " + (await resp.text()));
    return resp.json();
  }

  async _put(url, body, token) {
    const resp = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-acs-dingtalk-access-token": token },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status + " " + (await resp.text()));
    return resp.json();
  }

  async sendViaOpenapi(token, openConversationId, msgKey, msgParam) {
    return this._post(
      API_BASE + "/v1.0/robot/groupMessages/send",
      { robotCode: this.robotCode, openConversationId, msgKey, msgParam },
      token
    );
  }

  async sendViaOpenapiSingle(token, userId, msgKey, msgParam) {
    return this._post(
      API_BASE + "/v1.0/robot/oToMessages/batchSend",
      { robotCode: this.robotCode, userIds: [userId], msgKey, msgParam },
      token
    );
  }

  async sendMessage(token, target, content, markdown = true) {
    const msgKey = markdown ? "sampleMarkdown" : "sampleText";
    const msgParam = markdown
      ? JSON.stringify({ title: "AI回复", text: content })
      : JSON.stringify({ content });
    if (target.conversationType === "2") {
      return this.sendViaOpenapi(token, target.conversationId, msgKey, msgParam);
    }
    return this.sendViaOpenapiSingle(token, target.senderId, msgKey, msgParam);
  }

  async sendImage(token, target, mediaId) {
    const msgKey = "sampleImageMsg";
    const msgParam = JSON.stringify({ photoURL: mediaId });
    if (target.conversationType === "2") {
      return this.sendViaOpenapi(token, target.conversationId, msgKey, msgParam);
    }
    return this.sendViaOpenapiSingle(token, target.senderId, msgKey, msgParam);
  }

  async sendFile(token, target, mediaId, fileName, fileType) {
    const msgKey = "sampleFile";
    const msgParam = JSON.stringify({ mediaId, fileName, fileType });
    if (target.conversationType === "2") {
      return this.sendViaOpenapi(token, target.conversationId, msgKey, msgParam);
    }
    return this.sendViaOpenapiSingle(token, target.senderId, msgKey, msgParam);
  }

  async sendVoice(token, target, mediaId, durationMs) {
    const msgKey = "sampleAudio";
    const msgParam = JSON.stringify({ mediaId, duration: String(durationMs) });
    if (target.conversationType === "2") {
      return this.sendViaOpenapi(token, target.conversationId, msgKey, msgParam);
    }
    return this.sendViaOpenapiSingle(token, target.senderId, msgKey, msgParam);
  }

  async sendVideo(token, target, videoMediaId, picMediaId, durationSec, videoType, height, width) {
    const msgKey = "sampleVideo";
    const msgParam = JSON.stringify({
      duration: String(durationSec),
      videoMediaId,
      videoType: videoType || "mp4",
      picMediaId,
      height: height ? String(height) : undefined,
      width: width ? String(width) : undefined,
    });
    if (target.conversationType === "2") {
      return this.sendViaOpenapi(token, target.conversationId, msgKey, msgParam);
    }
    return this.sendViaOpenapiSingle(token, target.senderId, msgKey, msgParam);
  }

  async uploadMedia(token, filePath, mediaType) {
    const bytes = await readFileBytes(filePath);
    const fileName = String(filePath).split(/[\\/]/).pop() || "file";
    const size = bytes.length;
    const boundary = "----" + Math.random().toString(16).slice(2, 18);
    const enc = new TextEncoder();
    const head = enc.encode(
      "--" +
        boundary +
        '\r\nContent-Disposition: form-data; name="media"; filename="' +
        fileName +
        '"; filelength="' +
        size +
        '"\r\nContent-Type: application/octet-stream\r\n\r\n'
    );
    const tail = enc.encode("\r\n--" + boundary + "--\r\n");
    const body = new Uint8Array(head.length + bytes.length + tail.length);
    body.set(head, 0);
    body.set(bytes, head.length);
    body.set(tail, head.length + bytes.length);
    const url =
      TOKEN_URL + "/media/upload?access_token=" + encodeURIComponent(token) + "&type=" + mediaType;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=" + boundary },
      body,
    });
    const data = await resp.json();
    if (!data.media_id) throw new Error("media upload failed: " + (data.errmsg || "unknown"));
    return data.media_id;
  }

  _thinkingCardData() {
    return {
      cardParamMap: {
        content: "",
        lastMessage: "AI 思考中",
        query: "",
        preparations: "[]",
        charts: "[]",
        config: '{"autoLayout":true}',
      },
    };
  }

  async createThinkingCard(token, conversationId, conversationType, userId) {
    const outTrackId = "card_" + Date.now() + "_" + Math.random().toString(16).slice(2, 10);
    const pickTrackId = (result) =>
      (result && result.result && (result.result.outTrackId || result.result.out_track_id)) || outTrackId;
    if (conversationType === "2") {
      const result = await this._post(
        API_BASE + "/v1.0/card/instances/createAndDeliver",
        {
          cardTemplateId: CARD_TEMPLATE_ID,
          outTrackId,
          cardData: this._thinkingCardData(),
          imGroupOpenSpaceModel: {
            supportForward: true,
            lastMessageI18n: { ZH_CN: "AI 回复" },
            searchSupport: { searchIcon: "", searchDesc: "AI 回复" },
          },
          imGroupOpenDeliverModel: { robotCode: this.robotCode },
          openSpaceId: "dtv1.card//IM_GROUP." + conversationId,
        },
        token
      );
      return pickTrackId(result);
    }
    if (userId) {
      const result = await this._post(
        API_BASE + "/v1.0/card/instances/createAndDeliver",
        {
          userId,
          cardTemplateId: CARD_TEMPLATE_ID,
          outTrackId,
          callbackType: "STREAM",
          cardData: this._thinkingCardData(),
          imRobotOpenSpaceModel: {
            supportForward: true,
            lastMessageI18n: { ZH_CN: "AI 回复" },
            searchSupport: { searchIcon: "", searchDesc: "AI 回复" },
          },
          imRobotOpenDeliverModel: { spaceType: "IM_ROBOT", robotCode: this.robotCode },
          openSpaceId: "dtv1.card//im_robot." + userId,
          userIdType: 1,
        },
        token
      );
      return pickTrackId(result);
    }
    return "";
  }

  async finalizeCard(token, outTrackId, content, isError = false) {
    await this._put(
      API_BASE + "/v1.0/card/streaming",
      {
        outTrackId,
        guid: Date.now() + "_" + Math.random().toString(16).slice(2, 10),
        key: "content",
        content,
        isFull: true,
        isFinalize: true,
        isError,
      },
      token
    );
  }
}

const SYSTEM_PROMPT = `你是一个部署在钉钉（DingTalk）里的 AI 助手机器人，由 opencode 驱动。

【运行环境与约束】
- 你通过钉钉消息与用户交流：用户发来的文本、图片、文件、语音、视频会作为你的输入。
- 你的纯文本回复会被机器人自动发送回钉钉对话，你不需要、也不应该用工具去发送普通文本回复。
- 但当你需要主动给用户发送「文件」「图片」「语音」「视频」时，纯文本回复无法携带它们，必须调用钉钉工具：
  · 发送文件：用 dingtalk_upload_file 上传（或直接给 dingtalk_send_file 传 file_path）后再调用 dingtalk_send_file 发送。
  · 发送图片：用 dingtalk_upload_image 上传后再调用 dingtalk_send_image 发送。
  · 发送语音：用 dingtalk_send_voice（传 file_path 自动上传，或传 media_id），需填 duration_ms（毫秒）。
  · 发送视频：用 dingtalk_send_video（传 file_path 自动上传），视频必须同时提供封面图（pic_file_path 或 pic_media_id）。
  · 也可调用 dingtalk_send 发送 markdown/文本消息、dingtalk_send_card 发送互动卡片。
- 发送目标通常会被自动解析为最近一次对话，一般无需手动指定；只有要发往特定会话时才填 conversation_id / user_id。
- 用户发来的图片/文件/视频/语音会以形如 [图片消息] downloadCode="..." 的占位文本传入，你可据此用工具回传或处理。
- 你还可以用 dingtalk_read / dingtalk_wait 读取或等待消息，用 dingtalk_status 查看连接状态。

【行为准则】
- 用简洁、直接的中文回复。
- 需要交付文件、图片、语音或视频时，务必调用上述钉钉工具，不要只在文本里描述“已生成/已发送”。`;

const DINGTALK_DIRECTIVE = `[钉钉机器人指令]
你是钉钉机器人，用户通过钉钉与你对话，你的回复会自动发回钉钉。
当用户让你“发送 / 发给我 / 传给我 / 把…发给我”图片、文件、语音或视频时，你必须真正用工具把文件发出去：
  1) 先确定文件路径（可用 opencode 的文件工具如 Glob/Read 定位，例如桌面文件通常在用户桌面目录）；
  2) 再调用对应工具发送：
     - 图片 → dingtalk_send_image
     - 文件 → dingtalk_send_file
     - 语音 → dingtalk_send_voice（需 duration_ms，毫秒）
     - 视频 → dingtalk_send_video（必须提供封面图 pic_file_path 或 pic_media_id）
     均可直接传 file_path 自动上传。
绝不要只在文字里说“已发送/这是图片”而不实际调用工具。用户发来的图片/文件/视频/语音以 [图片消息]/[文件消息]/[视频消息]/[语音消息] 占位文本传入时，若用户希望回传，同样用上述工具发送。`;

function parseModel(str) {
  if (!str) return null;
  const s = String(str).trim();
  if (!s.includes("/")) return null;
  const parts = s.split("/");
  const p = parts[0];
  const m = parts[1];
  if (!p || !m) return null;
  return { providerID: p.trim(), modelID: m.trim() };
}

function chunkText(text, size, max) {
  const t = text || "";
  const out = [];
  for (let i = 0; i < t.length; i += size) {
    out.push(t.slice(i, i + size));
    if (out.length >= max) break;
  }
  return out.length ? out : [""];
}

function extractInbound(body) {
  const t = body.msgtype || "";
  if (t === "text") return (body.text && body.text.content ? body.text.content : "").trim();
  if (t === "audio") {
    const c = body.content || body.audio || {};
    const rec = c.recognition || body.recognition || "";
    if (String(rec).trim()) return String(rec).trim();
    return (
      '[语音消息] downloadCode="' +
      (c.downloadCode || body.downloadCode || "") +
      '" duration="' +
      (c.duration || body.duration || "") +
      '"'
    );
  }
  if (t === "richText") {
    const els = body.content?.richText || body.content?.rich_text || body.richText || body.rich_text || [];
    const parts = [];
    for (const e of els) {
      if (e && e.text) parts.push(e.text);
      else if (e && (e.downloadCode || e.download_code || e.pictureDownloadCode)) {
        parts.push(
          '[图片消息] downloadCode="' + (e.downloadCode || e.download_code || e.pictureDownloadCode || "") + '"'
        );
      }
    }
    return parts.length ? parts.join("") : null;
  }
  if (t === "picture" || t === "image") {
    const c = body.content || body.picture || {};
    return (
      '[图片消息] downloadCode="' +
      (c.downloadCode || c.download_code || c.pictureDownloadCode || body.downloadCode || "") +
      '"'
    );
  }
  if (t === "file") {
    const c = body.content || body.file || {};
    return (
      '[文件消息] fileName="' +
      (c.fileName || c.file_name || body.fileName || "未知") +
      '" downloadCode="' +
      (c.downloadCode || c.download_code || body.downloadCode || "") +
      '" fileId="' +
      (c.fileId || c.file_id || body.fileId || "") +
      '"'
    );
  }
  if (t === "video") {
    const c = body.content || body.video || {};
    return (
      '[视频消息] videoType="' +
      (c.videoType || c.video_type || body.videoType || "未知") +
      '" downloadCode="' +
      (c.downloadCode || c.download_code || body.downloadCode || "") +
      '" duration="' +
      (c.duration || body.duration || "") +
      '"'
    );
  }
  return null;
}

function targetFrom(state, msg) {
  const conversationType = String(msg.conversationType || "2");
  const conversationId = msg.conversationId || msg.openConversationId || "";
  const senderStaffId = msg.senderStaffId || msg.senderId || "";
  if (msg.webhook_url) return { type: "webhook", webhook_url: msg.webhook_url, conversationType, useCard: false };
  if (conversationType === "2") {
    return { type: "group", conversationType: "2", conversationId, senderId: senderStaffId, senderStaffId, useCard: state.useCard };
  }
  return { type: "single", conversationType: "1", conversationId: conversationId || senderStaffId, senderId: senderStaffId, senderStaffId, useCard: state.useCard };
}

async function listModels(state) {
  const { data, error } = await state.ctxClient.config.get();
  if (error || !data) return [];
  const providers = data.providers || {};
  const out = [];
  for (const pid of Object.keys(providers)) {
    const p = providers[pid];
    const models = (p && p.models) || {};
    for (const mid of Object.keys(models)) {
      const m = models[mid];
      out.push({ providerID: pid, modelID: mid, name: (m && m.name) || mid });
    }
  }
  return out;
}

async function resolveModelRef(state, ref) {
  const models = await listModels(state).catch(() => []);
  const r = String(ref).trim();
  if (r.includes("/")) {
    const segs = r.split("/");
    const p = segs[0];
    const m = segs[1];
    let found = models.find((x) => x.providerID === p && x.modelID === m);
    if (!found) {
      found = models.find(
        (x) => x.providerID.toLowerCase() === p.toLowerCase() && x.modelID.toLowerCase() === m.toLowerCase()
      );
    }
    return found ? found.providerID + "/" + found.modelID : null;
  }
  const f = models.find((x) => x.modelID === r || x.modelID.toLowerCase() === r.toLowerCase());
  return f ? f.providerID + "/" + f.modelID : null;
}

async function getOrCreateSession(state, dtConvId) {
  const existing = state.conversations.get(dtConvId);
  if (existing && Date.now() - existing.createdAt < SESSION_TTL_MS) return existing;
  const { data, error } = await state.ctxClient.session.create({
    body: { title: "DingTalk " + (dtConvId || "default") },
    query: { directory: state.directory },
  });
  if (error || !data) throw new Error("session.create failed: " + JSON.stringify(error));
  const entry = {
    sessionId: data.id,
    model: (existing && existing.model) || state.defaultModel,
    createdAt: Date.now(),
    dtConvId,
  };
  state.sessions.add(entry.sessionId);
  state.conversations.set(dtConvId, entry);
  return entry;
}

async function recreateSession(state, dtConvId) {
  const old = state.conversations.get(dtConvId);
  const { data, error } = await state.ctxClient.session.create({
    body: { title: "DingTalk " + (dtConvId || "default") },
    query: { directory: state.directory },
  });
  if (error || !data) throw new Error("recreate failed: " + JSON.stringify(error));
  const entry = {
    sessionId: data.id,
    model: (old && old.model) || state.defaultModel,
    createdAt: Date.now(),
    dtConvId,
  };
  state.sessions.add(entry.sessionId);
  state.conversations.set(dtConvId, entry);
  return entry;
}

async function runPrompt(state, dtConvId, content) {
  const entry = await getOrCreateSession(state, dtConvId);
  const model = parseModel(entry.model);
  const full = DINGTALK_DIRECTIVE + "\n\n" + content;
  let res = await state.ctxClient.session.prompt({
    path: { id: entry.sessionId },
    body: { parts: [{ type: "text", text: full }], model: model || undefined, system: state.systemPrompt },
  });
  if (res.error) {
    const re = await recreateSession(state, dtConvId);
    res = await state.ctxClient.session.prompt({
      path: { id: re.sessionId },
      body: { parts: [{ type: "text", text: full }], model: model || undefined, system: state.systemPrompt },
    });
    if (res.error) throw new Error("prompt failed: " + JSON.stringify(res.error));
  }
  const parts = (res.data && res.data.parts) || [];
  return parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

async function sendWebhook(state, webhookUrl, content, markdown = true) {
  const body = markdown
    ? { msgtype: "markdown", markdown: { title: "AI回复", text: content } }
    : { msgtype: "text", text: { content } };
  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error("webhook send HTTP " + resp.status);
  return resp.json().catch(() => ({}));
}

async function sendReply(state, target, text) {
  fileLog("sendReply target=" + JSON.stringify(target) + " textlen=" + (text ? text.length : 0));
  const token = await state.api.getAccessToken().catch(() => null);
  if (!token) {
    fileLog("sendReply: no token");
    state.log("error", "no token to send reply");
    return;
  }
  if (target.webhook_url) {
    await sendWebhook(state, target.webhook_url, text || "(空)", true).catch((e) => {
      fileLog("sendReply webhook fail: " + e.message);
      state.log("error", "webhook send: " + e.message);
    });
    fileLog("sendReply webhook done");
    return;
  }
  if (target.useCard) {
    const otid = await state.api
      .createThinkingCard(token, target.conversationId, target.conversationType, target.senderId)
      .catch(() => "");
    if (otid) {
      await state.api
        .finalizeCard(token, otid, text || "(空)", false)
        .catch((e) => state.log("error", "finalize card: " + e.message));
      return;
    }
  }
  const chunks = chunkText(text || "(空)", CHUNK_SIZE, MAX_CHUNKS);
  for (const c of chunks) {
    await state.api.sendMessage(token, target, c, true).catch((e) => state.log("error", "send msg: " + e.message));
  }
}

async function processAI(state, dtConvId, content, target) {
  let outTrackId = "";
  let token = null;
  if (target.useCard) {
    try {
      token = await state.api.getAccessToken();
      outTrackId = await state.api.createThinkingCard(
        token,
        target.conversationId,
        target.conversationType,
        target.senderId
      );
    } catch (e) {
      state.log("warn", "create thinking card failed, fallback: " + e.message);
      outTrackId = "";
    }
  }
  try {
    fileLog("processAI target=" + JSON.stringify(target) + " useCard=" + target.useCard + " webhook=" + (target.webhook_url || ""));
    const reply = await runPrompt(state, dtConvId, content);
    fileLog("processAI got reply len=" + (reply ? reply.length : 0) + " text=" + (reply || "").slice(0, 200));
    if (outTrackId && token) {
      try {
        await state.api.finalizeCard(token, outTrackId, reply || "(空回复)", false);
        return;
      } catch (e) {
        state.log("warn", "finalize card failed: " + e.message);
        outTrackId = "";
      }
    }
    await sendReply(state, target, reply || "(空回复)");
  } catch (e) {
    state.log("error", "AI处理失败: " + e.message);
    const errMsg = "⚠️ 处理失败：" + e.message;
    if (outTrackId && token) {
      try {
        await state.api.finalizeCard(token, outTrackId, errMsg, true);
        return;
      } catch (_) {}
    }
    await sendReply(state, target, errMsg);
  }
}

async function handleSendfile(state, fpath, target) {
  try {
    const token = await state.api.getAccessToken();
    const mediaId = await state.api.uploadMedia(token, fpath, "file");
    const fileName = String(fpath).split(/[\\/]/).pop() || "file";
    const ext = (fpath.split(".").pop() || "file").toLowerCase();
    await state.api.sendFile(token, target, mediaId, fileName, ext);
    await sendReply(state, target, "✅ 文件已发送: " + fileName);
  } catch (e) {
    await sendReply(state, target, "❌ 文件发送失败: " + e.message);
  }
}

async function handleCommand(state, command, msg, target) {
  const dtConvId = msg.conversationId || msg.openConversationId || msg.senderId || "";
  if (command === "/reset" || command === "/clear" || command === "新会话") {
    state.conversations.delete(dtConvId);
    const entry = await getOrCreateSession(state, dtConvId).catch((e) => ({ sessionId: "失败:" + e.message }));
    await sendReply(state, target, "[新会话] 已重置\n会话 ID: " + (entry.sessionId || "失败"));
    return;
  }
  if (command === "/status") {
    await sendReply(
      state,
      target,
      "连接: " +
        (state.currentWs ? "已连接" : "未连接") +
        "\n会话数: " +
        state.conversations.size +
        "\n默认模型: " +
        state.defaultModel +
        "\n卡片模式: " +
        state.useCard
    );
    return;
  }
  if (command === "/help") {
    await sendReply(state, target, HELP_TEXT);
    return;
  }
  if (command.startsWith("/sendfile ")) {
    const fpath = command.slice(10).trim().replace(/^["']|["']$/g, "");
    await handleSendfile(state, fpath, target);
    return;
  }
  if (command === "/models") {
    const models = await listModels(state).catch(() => []);
    const text = models.length
      ? "可用模型:\n" + models.map((m) => "- " + m.providerID + "/" + m.modelID + " (" + (m.name || m.modelID) + ")").join("\n")
      : "（无可用模型）";
    await sendReply(state, target, text);
    return;
  }
  if (command.startsWith("/model ")) {
    const ref = command.slice(7).trim();
    const resolved = await resolveModelRef(state, ref);
    if (!resolved) {
      await sendReply(state, target, "未找到模型: " + ref + "\n发送 /models 查看可用模型（格式：/model provider/model）");
      return;
    }
    const entry = await getOrCreateSession(state, dtConvId).catch(() => null);
    if (!entry) {
      await sendReply(state, target, "创建 opencode 会话失败，无法切换模型");
      return;
    }
    entry.model = resolved;
    state.conversations.set(dtConvId, entry);
    await sendReply(state, target, "已切换模型为: " + resolved);
    return;
  }
  if (command === "中断" || command === "cancel" || command === "stop") {
    const entry = state.conversations.get(dtConvId);
    let result = "无正在进行的会话";
    if (entry) {
      const r = await state.ctxClient.session
        .abort({ path: { id: entry.sessionId } })
        .catch((e) => ({ error: String(e) }));
      result = r && r.error ? "中止失败: " + JSON.stringify(r.error) : "已发送中止信号";
    }
    await sendReply(state, target, "[中止] " + result);
    return;
  }
}

async function onCallback(state, body) {
  try {
    fileLog("onCallback raw body: " + JSON.stringify(body).slice(0, 2000));
    const conversationId = body.conversationId || body.openConversationId || "";
    const conversationType = String(body.conversationType || body.conversation_type || "2");
    const senderId = body.senderId || body.senderStaffId || "";
    const senderStaffId = body.senderStaffId || body.sender_staff_id || "";
    const webhook = body.sessionWebhook || body.session_webhook || state.lastConv.webhook_url || "";
    const target = targetFrom(state, {
      conversationType,
      conversationId,
      openConversationId: conversationId,
      senderId,
      senderStaffId,
    });
    state.lastConv.conversationId = conversationId || state.lastConv.conversationId;
    state.lastConv.senderId = senderStaffId || senderId || state.lastConv.senderId;
    state.lastConv.conversationType = conversationType;
    state.lastConv.webhook_url = webhook || state.lastConv.webhook_url;

    const content = extractInbound(body);
    if (content == null) return;
    const dtConvId = conversationId || senderId;
    const trimmed = content.trim();

    state.inbound.push({ ts: Date.now(), msg: body });
    if (state.inbound.length > 100) state.inbound.shift();
    while (state.waiters.length) {
      const w = state.waiters.shift();
      try {
        w(trimmed);
      } catch (_) {}
    }

    if (trimmed.startsWith("/") || trimmed === "中断" || trimmed === "cancel" || trimmed === "stop") {
      await handleCommand(
        state,
        trimmed,
        { conversationId, openConversationId: conversationId, senderId, conversationType, sessionWebhook: webhook },
        target
      );
      return;
    }
    const prev = state.msgQueue.get(dtConvId) || Promise.resolve();
    const next = prev
      .then(() => processAI(state, dtConvId, content, target))
      .catch((e) => state.log("error", "queue proc error: " + e.message));
    state.msgQueue.set(dtConvId, next);
  } catch (e) {
    state.log("error", "onCallback error: " + e.message);
  }
}

function resolveToolTarget(state, args) {
  if (args.webhook_url) return { type: "webhook", webhook_url: args.webhook_url, conversationType: "2", useCard: false };
  let conversationType = args.conversation_type || state.lastConv.conversationType || "1";
  const conversationId = args.conversation_id || state.lastConv.conversationId || "";
  const senderId = args.user_id || state.lastConv.senderId || "";
  if (args.conversation_id) conversationType = "2";
  else if (args.user_id && !args.conversation_id) conversationType = "1";
  if (!conversationId && !senderId) {
    throw new Error("缺少目标：请提供 conversation_id/user_id 或 webhook_url，或先发起一次钉钉会话");
  }
  return targetFrom(state, {
    conversationType,
    conversationId,
    openConversationId: conversationId,
    senderId,
    senderStaffId: senderId,
  });
}

async function executeTool(state, name, args) {
  switch (name) {
    case "send": {
      const target = resolveToolTarget(state, args);
      const markdown = (args.msg_type || "markdown") !== "text";
      if (target.webhook_url) {
        await sendWebhook(state, target.webhook_url, args.content, markdown);
        return "ok";
      }
      const token = await state.api.getAccessToken();
      await state.api.sendMessage(token, target, args.content, markdown);
      return "ok";
    }
    case "send_card": {
      const target = resolveToolTarget(state, args);
      const token = await state.api.getAccessToken();
      const otid = await state.api.createThinkingCard(token, target.conversationId, target.conversationType, target.senderId);
      if (!otid) throw new Error("创建卡片失败");
      await state.api.finalizeCard(token, otid, args.content || "(空)", false);
      return JSON.stringify({ out_track_id: otid });
    }
    case "read": {
      const limit = args.limit || 10;
      const items = state.inbound.slice(-limit).map((x) => ({ ts: x.ts, msgtype: x.msg.msgtype, body: x.msg }));
      return JSON.stringify(items, null, 2);
    }
    case "wait": {
      const timeout = (args.timeout || 120) * 1000;
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(""), timeout);
        state.waiters.push((msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
    }
    case "status": {
      return JSON.stringify(
        {
          connected: !!state.currentWs,
          sessions: state.conversations.size,
          tokenOk: !!state.api.accessToken,
          defaultModel: state.defaultModel,
          useCard: state.useCard,
        },
        null,
        2
      );
    }
    case "upload_file": {
      const token = await state.api.getAccessToken();
      const mediaId = await state.api.uploadMedia(token, args.file_path, "file");
      return JSON.stringify({ media_id: mediaId });
    }
    case "upload_image": {
      const token = await state.api.getAccessToken();
      const mediaId = await state.api.uploadMedia(token, args.file_path, "image");
      return JSON.stringify({ media_id: mediaId });
    }
    case "send_image": {
      const target = resolveToolTarget(state, args);
      const token = await state.api.getAccessToken();
      let mediaId = args.media_id;
      if (args.file_path) mediaId = await state.api.uploadMedia(token, args.file_path, "image");
      if (!mediaId) throw new Error("需要 media_id 或 file_path");
      await state.api.sendImage(token, target, mediaId);
      return "ok";
    }
    case "send_file": {
      const target = resolveToolTarget(state, args);
      const token = await state.api.getAccessToken();
      let mediaId = args.media_id;
      let fileName = args.file_name || "";
      let fileType = args.file_type || "pdf";
      if (args.file_path) {
        mediaId = await state.api.uploadMedia(token, args.file_path, "file");
        fileName = fileName || String(args.file_path).split(/[\\/]/).pop();
        const ext = (String(args.file_path).split(".").pop() || "file").toLowerCase();
        fileType = args.file_type || ext || "file";
      }
      if (!mediaId) throw new Error("需要提供 media_id 或 file_path");
      await state.api.sendFile(token, target, mediaId, fileName, fileType);
      return "ok";
    }
    case "send_voice": {
      const target = resolveToolTarget(state, args);
      const token = await state.api.getAccessToken();
      let mediaId = args.media_id;
      if (args.file_path) mediaId = await state.api.uploadMedia(token, args.file_path, "voice");
      if (!mediaId) throw new Error("需要 media_id 或 file_path");
      const durationMs = args.duration_ms || args.duration || 1000;
      await state.api.sendVoice(token, target, mediaId, durationMs);
      return "ok";
    }
    case "send_video": {
      const target = resolveToolTarget(state, args);
      const token = await state.api.getAccessToken();
      let mediaId = args.media_id;
      if (args.file_path) mediaId = await state.api.uploadMedia(token, args.file_path, "video");
      if (!mediaId) throw new Error("需要 media_id 或 file_path");
      let picMediaId = args.pic_media_id;
      if (args.pic_file_path) picMediaId = await state.api.uploadMedia(token, args.pic_file_path, "image");
      if (!picMediaId) throw new Error("视频需要封面图：请提供 pic_media_id 或 pic_file_path");
      const durationSec = args.duration_sec || args.duration || 10;
      await state.api.sendVideo(
        token,
        target,
        mediaId,
        picMediaId,
        durationSec,
        args.video_type,
        args.height,
        args.width
      );
      return "ok";
    }
    default:
      throw new Error("unknown tool: " + name);
  }
}

function ack(ws, messageId) {
  const payload = {
    code: 200,
    headers: { contentType: "application/json", messageId: messageId },
    message: "OK",
    data: "",
  };
  try {
    ws.send(JSON.stringify(payload));
  } catch (_) {}
}

async function handleFrame(state, raw, ws) {
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch (_) {
    return;
  }
  const headers = frame.headers || {};
  const kind = frame.type || headers.type;
  const messageId = headers.messageId;
  let data = frame.data || {};

  if (kind === "SYSTEM") {
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch (_) { data = {}; }
    }
    if (data && data.type === "ping") ack(ws, messageId);
    else if (data && data.type === "disconnect") state.log("info", "server requested disconnect: " + (data.reason || ""));
    return;
  }

  if (kind === "CALLBACK") {
    ack(ws, messageId);
    // 钉钉 stream 回调帧的 data 是 JSON 字符串，需先 parse 成对象
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch (e) { state.log("warn", "callback data parse failed: " + e.message); return; }
    }
    const msg = data && data.msgtype ? data : frame.msgtype ? frame : null;
    if (msg) await onCallback(state, msg);
    else state.log("warn", "callback without msgtype: " + String(raw).slice(0, 300));
    return;
  }
}

function connectWs(state, endpoint, ticket) {
  return new Promise((resolve) => {
    const url = endpoint + (endpoint.indexOf("?") >= 0 ? "&" : "?") + "ticket=" + encodeURIComponent(ticket);
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      state.log("error", "ws construct failed: " + e.message);
      resolve();
      return;
    }
    state.currentWs = ws;
    ws.onopen = () => state.log("info", "DingTalk WS connected");
    ws.onmessage = (ev) => handleFrame(state, ev.data, ws);
    ws.onerror = (err) => state.log("error", "DingTalk WS error: " + (err && err.message ? err.message : String(err)));
    ws.onclose = () => {
      state.currentWs = null;
      state.log("info", "DingTalk WS closed");
      resolve();
    };
  });
}

async function runOnce(state) {
  const resp = await fetch(REGISTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: state.clientId,
      clientSecret: state.clientSecret,
      subscriptions: [
        { topic: SUBSCRIBE_TOPIC, type: "CALLBACK" },
        { topic: SUBSCRIBE_TOPIC_GROUP, type: "CALLBACK" },
      ],
      ua: "dingtalk-opencode-plugin",
    }),
  });
  const data = await resp.json();
  if (!data.endpoint || !data.ticket) throw new Error("register failed: " + JSON.stringify(data));
  await connectWs(state, data.endpoint, data.ticket);
}

async function startStream(state) {
  while (!state.closing) {
    try {
      await runOnce(state);
    } catch (e) {
      state.log("error", "stream loop error: " + (e && e.message ? e.message : String(e)));
    }
    await sleep(3000);
  }
}

function start(state) {
  if (state.clientId && state.clientSecret) {
    startStream(state);
  } else {
    state.log("warn", "DingTalk 未配置 clientId/clientSecret，不启动收消息 WS");
  }
}


// ---------------------------------------------------------------------------
// v2 tool layer surface: everything the v2 plugin entry needs from the v1
// protocol implementation. The v1 `tool({ args: zod })` definitions and the
// `server(input, options)` factory live in server.ts.
export {
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
};
