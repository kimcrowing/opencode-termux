# nx-bridge 插件（v2）—— AI 遥控 NX 2606 建模的 MCP 桥

把局域网 Windows 上的 Siemens NX 2606 建模能力封装成 **MCP server**（stdio），
任何 opencode 客户端（TUI/CLI/API/钉钉插件）都能直接调用 NX 创建/查询/撤销建模特征。

- 链路：`opencode → MCP(stdin/stdout) → HTTP JSON-RPC(192.168.3.66:8123)` 桥接。
- 后端：NX 进程内常驻 `NXRemoteServer.dll`（startup 自动加载，双通道 HttpListener:8123 +
  .NET Remoting:8124，共用 `NxHost.Dispatch`，无鉴权）。**部署单一事实源 = 仓库
  `__dirname/host/` 三件套**：`NXRemoteServer.cs`（源）＋ `NXRemoteServer.dll`（**已在册**，
  2026-09-14 用户决策：其它电脑 clone 仓库直接取 dll 放 startup 即自动加载，无需本地 csc 重编）＋
  `build_remote.cmd`（csc v4.0.30319 编译命令，需要重编时用）。源头在 Windows 桌面
  `C:\Users\Kim\NXRemoteServer.cs` + `build_remote.cmd`。
- **真实渐开线齿形**：齿轮走 NX 自带 `CylinderGearBuilder`（GC 工具箱齿轮命令），完全由
  journal_run 一段代码生成，本插件不内置任何齿轮几何计算。

## 注册（把本插件挂到 opencode）

```jsonc
// opencode.json → mcp.servers
"mcp": {
  "servers": {
    "nx-bridge": {
      "type": "local",
      "command": ["node", "/绝对路径/src/v2-plugin/nx-bridge/mcp.mjs"],
      "environment": { "NX_HOST": "192.168.3.66", "NX_PORT": "8123" }
    }
  }
}
```

环境变量：`NX_HOST`（缺省 192.168.3.66）、`NX_PORT`（缺省 8123）、`NX_TIMEOUT_MS`（缺省 60000，
journal.run 编译慢时可调大）。

前置条件（Windows 侧一次性配置）：
1. NX 2606 启动即自动加载 `NXUserDir\startup\NXRemoteServer.dll`；
2. `netsh http add urlacl url=http://+:8123/ user=Everyone`（已做）+ 防火墙放行 8123（规则 NXBridge8123）。

## 工具列表（19 个，MCP 命名空间 `nx-bridge`（连字符）／execute 内调用 `tools["nx-bridge"]["工具名"]`）

| 工具 | 作用 |
|---|---|
| `server_ping` / `session_info` | 健康检查 / 会话信息（NX 版本、进程、工作部件） |
| `session_undo` / `session_redo` | 撤销 / 重做最近一次 AI 建模操作 |
| `part_work` / `part_new_display` / `part_open` / `part_save` / `part_close_all` | 部件管理 |
| `model_tree` | 实体列表 + 特征树（journalId/类型） |
| `feature_block` / `feature_cylinder` / `feature_sphere` | 基础体素 |
| `feature_suppress` / `feature_unsuppress` | 抑制 / 取消抑制 |
| `measure_distance` | 两点距离（mm） |
| `ui_message` | NX 弹窗 |
| **`journal_run`** | 在 NX 进程内编译执行 NXOpen C#（高级/复杂构建的万能口） |
| **`api_reference`** | 返回 `NX2606-build-apis.md` 全文（全部构建 API 签名，反射实测） |

## 标准工作流

1. 查状态：`server_ping` → `session_info` → `part_work` / `part_open`。
2. 简单体素用 `feature_block/cylinder/sphere`；复杂特征（齿轮/布尔挖孔/合并/命名/测量）用
   **`journal_run`**，编写前先 `api_reference` 取全部 API 签名。
3. 每步产物用 `model_tree` 校验；坐标/尺寸用 `measure_distance` / bbox（journal 内
   `uf.Modl.AskBoundingBox`）验证。
4. 做错即 `session_undo` 整体回滚（journal.run 单条自带 Undo 标记）。

## 实测坑（详见 AGENTS.md）

- **redo 脆弱**：`session_redo` 必须紧贴 `session_undo`，任何中间调用都清空 redo。
- **journal 编译错误在 stdout**：宿主 SplitErrors 只看 stderr → `compileErrors:[]` 是假象；
  修复需改宿主或本地 csc 复现（`~/usr/tmp/opencode/nx2606/journal_run.sh` 已内置闭环）。
- 齿轮内齿圈必须 `MachiningType=Shaping`；`Axis` 定位用 `points.CreatePoint` 不能 `SetOrigin`。