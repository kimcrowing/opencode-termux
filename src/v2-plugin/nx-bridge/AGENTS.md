# nx-bridge 插件（AI 遥控 NX 2606）专属须知

> 全局/本机 termux 通用事实见 `~/.config/opencode/AGENTS.md`；本仓库根 AGENTS.md 记构建/CI 专属。
> 本文件只记 `src/v2-plugin/nx-bridge/` 的专属结论。完整建模项目文档在
> `~/.config/opencode/project/nx-copilot/AGENTS.md`（本插件源头脑）。

## 1. 定位与架构

- **插件形态**：MCP server（`mcp.mjs`，Node 单文件零依赖，stdio 传输）。与同目录其他 v2 插件
  （opencode 原生 plugin 形态）不同——nx-bridge 注册在 `opencode.json → mcp.servers`，靠 MCP 协议接入。
  `api_reference` 返回 `./NX2606-build-apis.md`（相对本文件 URL，已实测）。
- **后端宿主**：NX 2606.3002 进程内 `NXRemoteServer.dll`（startup 自动加载 `UGII_USER_DIR` 单一机制），
  HttpListener:8123 `POST /rpc`，JSON-RPC + `{"method":{...}}`，无鉴权；写操作带 Undo 标记
  （`WithUndo` 每次 `SetUndoMark` 前 `EnableRedo(true)`）。
- 本机已注册的完整工具目录见 `README.md`。**源码在仓库；部署副本参考
  `~/.config/opencode/plugins/xcpquery` 等方式**（本机 nx-bridge 直接引用仓库内 mcp.mjs）。

## 2. 关键实测结论（2026-09-13 全链）

1. **双通道宿主**：HTTP :8123 + Remoting :8124 共用 `NxHost.Dispatch`；主线程调度用隐藏
   WinForms Control.Invoke；无 journal 模态锁。
2. **redo 脆弱性矩阵**：`session.redo` 必须**紧跟** `session.undo`，中间穿插任何 NXOpen 调用
   （含只读 model.tree / server.ping）都会清空 redo（NX Open 程序上下文固有行为）。连续多次
   undo 后连续 redo 安全。
3. **journal.run 编译错误输出在 stdout**（`---OUT---` 有 error、`---ERR---` 空），宿主
   `SplitErrors(stderr)` 只读 stderr → 任何编译失败都返回 `compileErrors:[]`。**这是宿主 bug，
   修法=改 NXRemoteServer.cs 读 stdout+stderr 后重部署重启 NX（未做，需用户确认）**。
   临时闭环：`~/usr/tmp/opencode/nx2606/journal_run.sh`（失败自动去 Windows 抓最新临时
   `journal_*.cs`，显式 csc 编译 5 个 NXOpen*.dll 回显真实错误，无需重启 NX）。
4. **建模方式定案**：NX 自带齿轮特征 `CylinderGearBuilder` 生成真实渐开线齿形（非手工样条）。
   入口 `work.Features.GCToolsFeatureCollection.CreateCylinderGearBuilder(null)`；内齿圈必须
   `MachiningType=EnumMachiningType.Shaping`；定位 `builder.Axis.Point = work.Points.CreatePoint(...)`、
   `Axis.Direction = work.Directions.CreateDirection(...)`（`Axis.SetOrigin` 对智能对象报错）。
5. **布尔 API**：`CylinderBuilder` 布尔属性名是 **`BooleanOption`**（`NXOpen.GeometricUtilities.BooleanOperation`，
   `Type{get;set}` + `SetTargetBodies(Body[])`）；体合并也可直接用
   `CreateUniteFeature(target, retainTarget, tools, retainTool, allowNonAssoc, out, out)`（多 tool 建议分步）。
6. **特征命名**：`Feature.SetName(string)`（`Name` 只读）；bbox 用 `uf.Modl.AskBoundingBox(body.Tag, double[6])`。
7. **mjs 引号坑**：description 里中文引号误用 ASCII `"` 会截断字符串导致整体语法错误——mjs 改动后
   必跑 `node --check mcp.mjs`（2026-09-13 曾因此踩坑修复 session_undo 描述）。

## 3. 二级行星减速器成品（本插件可复现的最大案例，2026-09-13）

- `C:\ProgramData\PlanetReducer.prt`，m=2、压力角 20°、齿宽 12；传动比 ≈12.83:1。
- 传动链：输入轴→一级太阳轮24T→一级行星轮18T×3(固定齿圈60T)→**一级行星架=二级太阳轮一体**
  →二级行星轮15T×3(固定齿圈48T)→二级行星架(+输出轴)。
- 结构件已全部创建+Unite+命名并保存（输入轴、两级行星架、一体固定壳=两齿圈+Ø126连接筒，
  见 `NX2606-build-apis.md` §4.7 齿根圆推导）。
- journal 源脚本：`~/usr/tmp/opencode/nx2606/_*.cs`（stage_all 齿轮 / shells / unite / name / bbox）。

## 4. 待办（未做，需用户确认）

- 修复宿主 `SplitErrors`（journal 编译错误回显）；需要改 `C:\Users\Kim\NXRemoteServer.cs` +
  重编译 + 重启 NX。
- MCP 工具在本会话（Code Mode）运行时空缺问题 = opencode serve 表现，一般重启 serve/新会话即恢复。