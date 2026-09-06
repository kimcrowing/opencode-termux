# xcpquery 插件使用说明（v2）

CNIPA 国家知识产权局专利审查信息查询（cpquery.cponline.cnipa.gov.cn），
迁移自 v1 插件 `~/.config/opencode/plugins/xcpquery/index.js`（110 机器上验证可用）。

## 凭据

经 runit `env/` 目录或插件配置注入：`CNIPA_USERNAME` / `CNIPA_PASSWORD`
（国知局公开查询账号）。凭据不在任何 git 仓库中。

## 工具列表

| 工具 | 作用 |
|---|---|
| `search_patent` | 按号码检索专利（申请号/公开号） |
| `get_case_summary` | 案件概要（申请信息/费用/发文/公告） |
| `get_examination_tree` | 审查信息目录树（申请文件/中间文件/通知书/复审文件/无效文件） |
| `list_documents` | 递归列出全部可下载文档（含 rid/ds/wenjiandm 下载参数） |
| `download_document` | 按 rid/ds/wenjiandm 下载文档为 base64 |
| `get_section_text` | 栏目文本（申请信息/费用信息/发文信息/公告信息） |
| `get_scjd_tree` | 复审无效审查决定目录树（国内专用） |

## 标准工作流（以下载意见陈述书为例）

专利 `2024106091101`（重庆三峰御临环保，驳回后提起复审，代理 北京同恒源/李弱萱）。

### 1. 检索确认案件

```
search_patent(patent_no="2024106091101", scope="domestic")
get_case_summary(patent_no="2024106091101", scope="domestic")
```

### 2. 列出文档（获取下载参数）

```
list_documents(patent_no="2024106091101", scope="domestic")
```

返回 `documents` 数组，每项含 `name/rid/ds/wenjiandm/path`：

```
[中间文件] 中间文件/2026-05-25  意见陈述书  | rid=102026046383934 ds=ZJWJ   wenjiandm=100012
[中间文件] 中间文件/2025-12-31  意见陈述书  | rid=102026037313818 ds=ZJWJ   wenjiandm=100012
[通知书]   通知书/2026-05-28  驳回决定      | rid=10110680665096089 ds=TZS  wenjiandm=210407
[通知书]   通知书/2025-10-29  第一次审查意见通知书 | rid=10110680637159664 ds=TZS wenjiandm=210401
```

`ds` 取值：`SQWJ`=申请文件、`ZJWJ`=中间文件（含意见陈述书/权利要求书修改等）、`TZS`=通知书。

### 3. 下载文档

```
download_document(
  patent_no="2024106091101",
  rid="102026037313818",       # 取 list_documents 返回的 rid，不要手工编造
  ds="ZJWJ",
  wenjiandm="100012",
  scope="domestic",
)
```

返回 `{content: base64, mime, filename}`，base64 解码后即 PDF。

### 4. 已知参数模板（实测可用）

意见陈述书（第一次答复，2025-12-31）：
- `rid=102026037313818, ds=ZJWJ, wenjiandm=100012`

意见陈述书（2026-05-25）：
- `rid=102026046383934, ds=ZJWJ, wenjiandm=100012`

注意：同一文件类型下不同日期的文件 rid 不同，`rid` 必须与目标日期文件对应。

## 已知坑（实测）

1. **`list_documents` 偶发失败**：审查信息后端有瑞数 WAF（412 挑战 + 400/404 伪装）。
   - 已做分类级容错：单个分类（尤其 scjd 复审无效审查决定/无效文件 wxwj）查询失败
     只记 `warnings`，不中断整体列表；WAF 重解后一般可恢复。
   - 若整体失败（如 `412 anti-bot challenge failed`），稍等 10-30 秒重试即可；
     会话冷却后一般第二次成功。
2. **`scjd`（复审无效审查决定）对无审查决定的案件返回 400 空 body**：这是该栏目
   无数据的真实响应，不是错误——`emptyOk` 已将其视同空栏目，列表照常返回。
3. **`download_document` 更稳**：不需要遍历整棵树，直接按 rid/ds/wenjiandm 拉取，
   成功率远高于 list_documents。**优先 workflow：list_documents 成功后立即按它给的
   参数 download_document**；list_documents 失败时可直接用 get_case_summary 找线索
   或稍后重试。
4. 审查信息随案件进度更新，调查时注意查看发文信息中的最新通知书
   （`get_section_text(section="发文信息")`）。

## 参考：110 机器的 v1 实现

- v1 插件：`~/.config/opencode/plugins/xcpquery/index.js`（110 机器）
- 成功下载脚本：`deliverable_timed.mjs`、`dump_all.mjs`（v1 目录），其核心就是
  `download_document` 直连（不依赖 list_documents 完整遍历）。
- 诊断脚本：`diag_400.mjs` / `probe_fileinfo.mjs` / `list_tzs.mjs` / `diag_dl.mjs`
  （针对 2024106091101 的调查过程）。