#!/usr/bin/env node
// ============================================================================
// NX Copilot MCP Server —— 把 NXRemoteServer.dll 的 HTTP JSON-RPC(:8123) 封装为标准 MCP 工具
//
// 零依赖 Node 单文件（Node >= 18，用原生 fetch）。stdio 传输（MCP 标准）。
// 注册到 opencode.json -> mcp.servers，任何 opencode 客户端（TUI/CLI/API/钉钉插件）
// 都能直接调用 NX 建模。
//
// 环境变量（在 opencode.json 的 environment 中配置）：
//   NX_HOST            默认 192.168.3.66
//   NX_PORT            默认 8123
//   NX_TIMEOUT_MS      每次调用超时，默认 60000（journal.run 编译较慢）
//
// 对应宿主 Dispatch 面（NXRemoteServer.cs, 2026-09-13 实测全通）：
//   server.ping / session.info / session.undo / session.redo
//   part.work / part.open / part.save / part.closeAll / part.newDisplay
//   model.tree / feature.block / feature.cylinder / feature.sphere
//   feature.suppress / feature.unsuppress / measure.distance
//   ui.message / journal.run
// ============================================================================
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";

const NX_HOST = process.env.NX_HOST || "192.168.3.66";
const NX_PORT = process.env.NX_PORT || "8123";
const BASE = `http://${NX_HOST}:${NX_PORT}`;
const TIMEOUT_MS = parseInt(process.env.NX_TIMEOUT_MS || "60000", 10);

// ---------------------------------------------------------------------------
// 工具定义（JSON Schema，供 tools/list）
// ---------------------------------------------------------------------------
const TOOLS = {
  server_ping: {
    description: "NX 桥接服务健康检查。返回 pong/NX 版本号。",
    params: {},
    run: () => rpc("server.ping", {}),
  },
  session_info: {
    description: "NX 会话信息：NX 版本、进程号、服务地址、请求计数、当前工作部件。",
    params: {},
    run: () => rpc("session.info", {}),
  },
  session_undo: {
    description: "撤销最近一次 AI 建模操作（等价 Ctrl+Z）。返回 undone 布尔值。⚠️ 撤销后 redo 数据处于待重做态：在调用 session_redo 之前穿插任何其他工具（哪怕 model.tree / part_work / server_ping 只读）都会使 redo 失效，返回 redone=false。需要“撤销后确认再重做”时，先重做后查询；或接受无法重做的事实。",
    params: {},
    run: () => rpc("session.undo", {}),
  },
  session_redo: {
    description: "重做最近一次被撤销的 AI 建模操作（等价 Ctrl+Y）。返回 redone 布尔值。⚠️ 必须紧跟在 session_undo 之后调用——中间穿插任何其他 NXOpen 调用（含只读查询）会使 redo 数据失效（NX Open 程序上下文固有行为，实测 2026-09-13）。",
    params: {},
    run: () => rpc("session.redo", {}),
  },
  part_work: {
    description: "查询当前工作部件信息（fullPath/name/units/modified）。无部件时返回 null。",
    params: {},
    run: () => rpc("part.work", {}),
  },
  part_new_display: {
    description: "新建并显示一个毫米制空部件（已在 NX 中没有的部分）。会切换为当前工作部件。",
    params: {
      name: { type: "string", description: "部件名，缺省 RemoteModel", default: "RemoteModel" },
    },
    required: [],
    run: (a) => rpc("part.newDisplay", { name: a.name }),
  },
  part_open: {
    description: "打开已有部件文件并设为当前显示。file 为完整路径（如 D:\\models\\plate.prt）。",
    params: {
      file: { type: "string", description: "部件完整路径" },
    },
    required: ["file"],
    run: (a) => rpc("part.open", { file: a.file }),
  },
  part_save: {
    description: "保存所有已修改的打开部件。",
    params: {},
    run: () => rpc("part.save", {}),
  },
  part_close_all: {
    description: "关闭所有已打开部件（不保存未保存的修改）。",
    params: {},
    run: () => rpc("part.closeAll", {}),
  },
  model_tree: {
    description: "当前工作部件的模型树：部件信息 + 实体列表（面/边数）+ 特征列表（name/type/journalId）。",
    params: {},
    run: () => rpc("model.tree", {}),
  },
  feature_block: {
    description: "创建方块特征（带 Undo 标记，可 Ctrl+Z）。origin 为左下角点 [x,y,z]，length 为各向尺寸（毫米）。返回特征 journalId。",
    params: {
      origin: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3, description: "左下角 [x,y,z]，毫米" },
      lengthX: { type: "number", description: "X 向尺寸，毫米" },
      lengthY: { type: "number", description: "Y 向尺寸，毫米" },
      lengthZ: { type: "number", description: "Z 向尺寸，毫米" },
      name: { type: "string", description: "特征名（可选）" },
    },
    required: ["origin", "lengthX", "lengthY", "lengthZ"],
    run: (a) => rpc("feature.block", {
      origin: a.origin, lengthX: a.lengthX, lengthY: a.lengthY, lengthZ: a.lengthZ, name: a.name,
    }),
  },
  feature_cylinder: {
    description: "创建圆柱特征。origin 为底面圆心 [x,y,z]，direction 为轴向（缺省 [0,0,1]），diameter/height 毫米。带 Undo 标记。",
    params: {
      origin: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3, description: "底面圆心 [x,y,z]" },
      direction: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3, description: "轴向向量，缺省 [0,0,1]" },
      diameter: { type: "number", description: "直径，毫米" },
      height: { type: "number", description: "高度，毫米" },
      name: { type: "string", description: "特征名（可选）" },
    },
    required: ["origin", "diameter", "height"],
    run: (a) => rpc("feature.cylinder", {
      origin: a.origin, direction: a.direction || [0, 0, 1],
      diameter: a.diameter, height: a.height, name: a.name,
    }),
  },
  feature_sphere: {
    description: "创建球体特征。origin 为球心 [x,y,z]，diameter 直径毫米。带 Undo 标记。",
    params: {
      origin: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3, description: "球心 [x,y,z]" },
      diameter: { type: "number", description: "直径，毫米" },
      name: { type: "string", description: "特征名（可选）" },
    },
    required: ["origin", "diameter"],
    run: (a) => rpc("feature.sphere", { origin: a.origin, diameter: a.diameter, name: a.name }),
  },
  feature_suppress: {
    description: "抑制（隐藏）特征。featureId 用 model.tree 查得的 journalId（如 BLOCK(0)）。带 Undo 标记。",
    params: {
      featureId: { type: "string", description: "特征的 journalId，如 BLOCK(0)" },
    },
    required: ["featureId"],
    run: (a) => rpc("feature.suppress", { featureId: a.featureId }),
  },
  feature_unsuppress: {
    description: "取消抑制（恢复显示）特征。featureId 用 model.tree 查得的 journalId。带 Undo 标记。",
    params: {
      featureId: { type: "string", description: "特征的 journalId，如 BLOCK(0)" },
    },
    required: ["featureId"],
    run: (a) => rpc("feature.unsuppress", { featureId: a.featureId }),
  },
  measure_distance: {
    description: "计算两个点之间的欧氏距离（毫米）。坐标间距离；面/边/实体距离请用 journal_run。",
    params: {
      p1: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3, description: "点1 [x,y,z]" },
      p2: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3, description: "点2 [x,y,z]" },
    },
    required: ["p1", "p2"],
    run: (a) => rpc("measure.distance", { p1: a.p1, p2: a.p2 }),
  },
  ui_message: {
    description: "在 NX 界面弹出一个信息对话框（阻塞等待用户点确定）。text 为显示文本。",
    params: {
      text: { type: "string", description: "弹窗文本" },
    },
    required: ["text"],
    run: (a) => rpc("ui.message", { text: a.text }),
  },
  journal_run: {
    description:
      "在 NX 进程内编译并执行一段 NXOpen C# 语句（高级能力，如布尔减孔、特征构建器调用等内置方法未覆盖的操作）。" +
      "code 是语句序列，宿主已预置 using System/Collections.Generic/NXOpen、静态变量 theSession(theUI) 与 string RESULT。" +
      "把结果赋给 RESULT 即作为返回值；编译/运行错误会原样返回（可据此修正代码重试）。执行期间 NX UI 会短暂繁忙。\n" +
      "⚠️ 编写构建代码前先调用 api_reference 工具获取 NX 2606 全部构建 API 签名（反射实测）：包括 Block/Cylinder/Cone/Sphere/Extrude/Revolve 与 CylinderGearBuilder（真实渐开线齿轮）、布尔三通道（BooleanOption / CreateUnite·Subtract·Intersect / BooleanBuilder）、HoleFeatureBuilder 属性方法与枚举值、journal.run 用法与实测坑。",
    params: {
      code: { type: "string", description: "NXOpen C# 语句序列（不是完整类）" },
    },
    required: ["code"],
    run: (a) => rpc("journal.run", { code: a.code }),
  },
  api_reference: {
    description:
      "返回 NX 2606 全部建模特征构建 API 与签名参考文档（Markdown 原文）：" +
      "FeatureCollection 入口方法（含布尔 CreateUniteFeature/CreateSubtractFeature/CreateIntersectFeature）、" +
      "Builder 基类协议（Commit/Destroy/Validate…）、布尔三通道（BooleanOption/三方法/BooleanBuilder）、" +
      "各 Builder 属性方法详表（Block/Cylinder/Cone/Sphere/Extrude/Revolve/CylinderGear 齿轮/Hole…）、全部枚举值、" +
      "特征命名 SetName 与 bbox 测量、journal.run 使用规范与实测坑。所有签名经 2606.3002 反射 dump 取证。\n" +
      "—— 【工具内固化 · 正确调用路径（2026-09-13 实测盖章）】本插件以 MCP server 形态接入时：" +
      "namespace 是连字符 `nx-bridge`（不是下划线 `nx_bridge`）；SDK/CLI 侧调用走 `tools[\"nx-bridge\"][\"工具名\"]` 字典路径，" +
      "execute（Code Mode）里同理 `tools[\"nx-bridge\"][\"server_ping\"]`（连字符命名空间 + 连字符工具名 server_ping），" +
      "不要用下划线扁平名 `nx_bridge_server_ping`。19 工具全名单与 journal_run 的 {code} 单参、api_reference 自证法见文档 §0。",
    params: {},
    run: () => {
      const p = new URL("./NX2606-build-apis.md", import.meta.url);
      return { __raw: readFileSync(p, "utf8") };
    },
  },
};

function toolSchema(name) {
  const t = TOOLS[name];
  const properties = {};
  for (const [k, v] of Object.entries(t.params)) {
    properties[k] = v;
  }
  const schema = { type: "object", properties };
  if (t.required && t.required.length) schema.required = t.required;
  return schema;
}

// ---------------------------------------------------------------------------
// HTTP JSON-RPC 调用（NX 宿主 :8123）
// ---------------------------------------------------------------------------
async function rpc(method, params) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(`${BASE}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctl.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error(`NX 调用超时（${TIMEOUT_MS}ms）。宿主机 ${NX_HOST}:${NX_PORT} 响应过慢，命令可能正在执行，稍后可用 model.tree 查询结果。`);
    }
    throw new Error(`NX 服务不可达：${NX_HOST}:${NX_PORT} 连接失败（${e.message}）。请确认 NX 已启动且加载了 NXRemoteServer.dll（netstat 8123 监听）。`);
  } finally {
    clearTimeout(timer);
  }

  let data;
  try {
    data = await resp.json();
  } catch {
    throw new Error(`NX 响应非 JSON（HTTP ${resp.status}）。`);
  }
  if (data.error) {
    const m = data.error.message || "未知错误";
    const d = data.error.detail ? `（${data.error.detail}）` : "";
    throw new Error(`${m}${d}`);
  }
  return data.result;
}

// ---------------------------------------------------------------------------
// MCP stdio 传输（每行一条 JSON-RPC 消息）
// ---------------------------------------------------------------------------
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

async function handleRequest(msg) {
  const { id, method } = msg;
  if (method === "initialize") {
    const clientVersion = (msg.params && msg.params.protocolVersion) || "2024-11-05";
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: clientVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "nx-bridge", version: "1.0.0" },
      },
    });
    return;
  }
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: Object.entries(TOOLS).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: toolSchema(name),
        })),
      },
    });
    return;
  }
  if (method === "tools/call") {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    const tool = TOOLS[name];
    if (!tool) {
      sendError(id, -32602, `未知工具: ${name}`);
      return;
    }
    try {
      const result = await tool.run(args);
      const raw =
        result && typeof result === "object" && result.__raw !== undefined
          ? result.__raw
          : JSON.stringify(result);
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: raw }],
        },
      });
    } catch (e) {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `错误: ${e.message}` }],
          isError: true,
        },
      });
    }
    return;
  }
  // 未知方法/通知：有 id 才应答
  if (id !== undefined && id !== null) {
    sendError(id, -32601, `Method not found: ${method}`);
  }
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // 忽略无法解析的行
  }
  if (msg && msg.method) {
    handleRequest(msg).catch((e) => sendError(msg.id ?? null, -32603, e.message));
  }
});