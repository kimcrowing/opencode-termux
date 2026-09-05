// server.ts — opencode v2 plugin：CNIPA 专利审查信息查询（cpquery）。
//
// 迁移自 v1 插件 ~/.config/opencode/plugins/xcpquery/index.js：
//   * 协议/WAF/登录逻辑原样保留在 core.mjs（未改动逻辑）。
//   * v1 的 `tool({ args: zod })` 定义改为裸 JSON Schema + editor.add。
//   * 工具名带 xcpquery_ 前缀（v2 用 options.namespace 组合实现）。
//
// 注意：本文件不使用任何第三方依赖，浏览器自动化依赖 cjs/ 目录（同 v1）。
import fs from "node:fs";
import * as core from "./core.mjs";

const {
  ensureSession,
  searchPatent,
  searchPatentForeign,
  navigateDetail,
  navigateDetailForeign,
  formatCaseSummary,
  formatCaseSummaryForeign,
  getAllDocuments,
  getAllDocumentsForeign,
  downloadDocument,
  downloadDocumentForeign,
  detectFileExtension,
  getExaminationChildren,
  getScjdTree,
  FOREIGN_DOC_CATEGORY_LABELS,
  FOREIGN_DOC_CATEGORIES,
  SECTION_API,
  NODE_IDS,
  FOREIGN_DETAIL_ENDPOINT,
  FOREIGN_DOCS_ENDPOINT,
  foreignDetailBody,
  cpqueryRequest,
  _isForeign,
  _toText,
} = core;

type ToolInput = Record<string, unknown>;

type ToolDef = {
  name: string;
  description: string;
  input: Record<string, unknown>;
  options: { namespace: string };
  execute: (args: ToolInput) => Promise<string>;
};

// v2 用裸 JSON Schema 描述入参（v1 的 zod 在 v2 侧不可用）。
const props = (fields: Record<string, { type: string; description: string }>) => ({
  type: "object",
  properties: fields,
  additionalProperties: false,
});

const SCOPE_FIELD = {
  type: "string",
  enum: ["domestic", "foreign"],
  description: "domestic=中国专利审查信息; foreign=多国(IP5)",
};

const COMMON_FIELDS = {
  patent_no: { type: "string", description: "专利号/公开号" },
  scope: SCOPE_FIELD,
  country: { type: "string", description: "foreign 专用: CN/EP/JP/KR/US/ALL" },
  shenqinglsh: { type: "string", description: "foreign 专用: 申请流水号" },
  shenqinglx: { type: "string", description: "foreign 专用: 文献类型 kind code, 如 A/B2" },
};

const TOOLS: ToolDef[] = [
  {
    name: "search_patent",
    description:
      "按号码检索专利。scope=domestic 查询中国专利审查信息；scope=foreign 查询多国发明专利审查信息(IP5: CN/EP/JP/KR/US)。foreign 时 country 可为 CN/EP/JP/KR/US/ALL，number_type 为 申请号/公开号/优先权号，doc_type 为文献类型 kind code（按公开号检索时必填）。",
    input: props({
      patent_no: { type: "string", description: "专利号/公开号" },
      scope: SCOPE_FIELD,
      country: { type: "string", description: "foreign 专用: CN/EP/JP/KR/US/ALL" },
      number_type: { type: "string", description: "foreign 专用: 申请号/公开号/优先权号" },
      doc_type: { type: "string", description: "foreign 专用: 文献类型 kind code, 如 B2/A1" },
    }),
    options: { namespace: "xcpquery" },
    execute: async (a) => {
      try {
        if (_isForeign(a))
          return _toText(
            await searchPatentForeign(a.patent_no, a.country || "CN", a.number_type || "公开号", a.doc_type || ""),
          );
        return _toText(await searchPatent(a.patent_no));
      } catch (e) {
        return `search_patent 失败: ${e.message}`;
      }
    },
  },
  {
    name: "get_case_summary",
    description:
      "获取案件概要。scope=domestic(申请信息/费用/发文/公告) 或 scope=foreign(多国栏目)。foreign 时 shenqinglsh/申请流水号 与 shenqinglx/文献类型 可显式提供以避免重新推导。",
    input: props(COMMON_FIELDS),
    options: { namespace: "xcpquery" },
    execute: async (a) => {
      try {
        if (_isForeign(a)) {
          const country = a.country || "US";
          const summary = await navigateDetailForeign(a.patent_no, country, a.shenqinglsh, a.shenqinglx);
          return formatCaseSummaryForeign(a.patent_no, summary, country);
        }
        return formatCaseSummary(a.patent_no, await navigateDetail(a.patent_no));
      } catch (e) {
        return `get_case_summary 失败: ${e.message}`;
      }
    },
  },
  {
    name: "list_documents",
    description:
      "递归列出所有可用文档，返回 documents 数组。国内项含 rid/ds/wenjiandm（传给 download_document）；国外项含可直接下载的 uri。",
    input: props(COMMON_FIELDS),
    options: { namespace: "xcpquery" },
    execute: async (a) => {
      try {
        const docs = _isForeign(a)
          ? await getAllDocumentsForeign(a.patent_no, a.country || "US", a.shenqinglsh, a.shenqinglx)
          : await getAllDocuments(a.patent_no, true);
        return _toText({ patent_no: a.patent_no, count: docs.length, documents: docs });
      } catch (e) {
        return `list_documents 失败: ${e.message}`;
      }
    },
  },
  {
    name: "download_document",
    description:
      "下载专利文档为 base64。国内：提供 list_documents 返回的 rid/ds/wenjiandm（is_scjd/anjianbh 用于复审无效审查决定）；国外：提供 list_documents 返回的 uri（rid/ds 不适用）。",
    input: props({
      patent_no: { type: "string", description: "专利号/公开号" },
      uri: { type: "string", description: "foreign 专用: 来自 list_documents 的文档 uri" },
      rid: { type: "string", description: "国内: list_documents 返回的 rid" },
      ds: { type: "string", description: "国内: list_documents 返回的 ds" },
      wenjiandm: { type: "string", description: "国内: 文件代码" },
      scope: SCOPE_FIELD,
      country: { type: "string", description: "foreign 专用: CN/EP/JP/KR/US" },
      is_scjd: { type: "boolean", description: "是否为复审无效审查决定文档" },
      anjianbh: { type: "string", description: "复审无效案件编号（is_scjd 时用）" },
    }),
    options: { namespace: "xcpquery" },
    execute: async (a) => {
      try {
        let data;
        if (_isForeign(a)) {
          if (!a.uri) return "国外下载需要 list_documents 返回的 uri 字段（rid/ds 不适用）。";
          data = await downloadDocumentForeign(a.uri);
        } else {
          data = await downloadDocument(a.patent_no, a.rid, a.ds, a.wenjiandm, a.is_scjd, a.anjianbh);
        }
        const ext = detectFileExtension(data);
        const mimes: Record<string, string> = {
          pdf: "application/pdf",
          png: "image/png",
          jpg: "image/jpeg",
          gif: "image/gif",
          xml: "application/xml",
          bin: "application/octet-stream",
        };
        const rid = a.rid || "foreign";
        return _toText({
          content: data.toString("base64"),
          encoded: true,
          mime: mimes[ext] || "application/octet-stream",
          filename: `${rid}.${ext}`,
        });
      } catch (e) {
        return `download_document 失败: ${e.message}`;
      }
    },
  },
  {
    name: "get_section_text",
    description:
      "获取案件信息栏目文本（申请信息/费用信息/发文信息/公告信息）。foreign 走多国栏目。",
    input: props({
      patent_no: { type: "string", description: "专利号" },
      section: { type: "string", description: "栏目名称" },
      scope: SCOPE_FIELD,
      country: { type: "string", description: "foreign 专用: CN/EP/JP/KR/US" },
      shenqinglsh: { type: "string", description: "foreign 专用: 申请流水号" },
      shenqinglx: { type: "string", description: "foreign 专用: 文献类型 kind code, 如 A/B2" },
    }),
    options: { namespace: "xcpquery" },
    execute: async (a) => {
      try {
        const section = a.section;
        if (_isForeign(a)) {
          const country = a.country || "US";
          const labelToCat = Object.fromEntries(
            Object.entries(FOREIGN_DOC_CATEGORY_LABELS).map(([k, v]) => [v, k]),
          );
          if (["申请信息", "著录", "bibliographic", "sqxx"].includes(section)) {
            const body = foreignDetailBody(a.patent_no, country, a.shenqinglsh, a.shenqinglx);
            return _toText(await cpqueryRequest("POST", FOREIGN_DETAIL_ENDPOINT, body));
          }
          const cat = labelToCat[section];
          const body = foreignDetailBody(a.patent_no, country, a.shenqinglsh, a.shenqinglx);
          const payload = (await cpqueryRequest("POST", FOREIGN_DOCS_ENDPOINT, body)).data || {};
          return _toText(cat ? payload[cat] : payload);
        }
        if (!SECTION_API[section]) return `Unknown section. Choose: ${Object.keys(SECTION_API).join("/")}`;
        await ensureSession();
        await cpqueryRequest("POST", "/api/view/gn/obtain-init-treenodes", { zhuanlisqh: a.patent_no });
        return _toText(
          await cpqueryRequest("POST", SECTION_API[section], {
            zhuanlisqh: a.patent_no,
            nodeId: NODE_IDS[section],
          }),
        );
      } catch (e) {
        return `get_section_text 失败: ${e.message}`;
      }
    },
  },
  {
    name: "get_examination_tree",
    description: "获取审查信息目录树（审查信息子目录）。foreign 返回多国审查信息栏目树。",
    input: props(COMMON_FIELDS),
    options: { namespace: "xcpquery" },
    execute: async (a) => {
      try {
        if (_isForeign(a)) {
          const country = a.country || "US";
          const body = foreignDetailBody(a.patent_no, country, a.shenqinglsh, a.shenqinglx);
          const payload = (await cpqueryRequest("POST", FOREIGN_DOCS_ENDPOINT, body)).data || {};
          const out = {};
          for (const cat of FOREIGN_DOC_CATEGORIES) {
            const items = payload[cat] || [];
            out[FOREIGN_DOC_CATEGORY_LABELS[cat] || cat] = { category: cat, count: items.length, isLeaf: true };
          }
          return _toText(out) + "\n\n提示: 用 list_documents(scope=foreign) 获取每类文档的下载 uri";
        }
        const children = await getExaminationChildren(a.patent_no);
        const tree = {};
        for (const [nm, node] of Object.entries(children))
          tree[nm] = { nodeId: node.nodeId, url: node.url, isLeaf: node.isLeaf };
        return _toText(tree) + "\n\n提示: 非叶子节点(复审文件/无效文件)需进一步查询子目录";
      } catch (e) {
        return `get_examination_tree 失败: ${e.message}`;
      }
    },
  },
  {
    name: "get_scjd_tree",
    description: "获取复审无效审查决定目录树（国内专用），展示复审/无效案件及其文档信息。",
    input: props({ patent_no: { type: "string", description: "专利号" } }),
    options: { namespace: "xcpquery" },
    execute: async (a) => {
      try {
        return _toText(await getScjdTree(a.patent_no));
      } catch (e) {
        return `get_scjd_tree 失败: ${e.message}`;
      }
    },
  },
];

export default {
  id: "xcpquery",
  setup: async (ctx) => {
    const cfg = (ctx.options && typeof ctx.options === "object" ? ctx.options : {}) || {};
    const username = cfg.username || process.env.CNIPA_USERNAME;
    const password = cfg.password || process.env.CNIPA_PASSWORD;

    // 与 v1 一致：启动时若配置了凭据就自动登录（含验证码），失败则由工具在使用时重试。
    if (username && password) {
      try {
        await ensureSession();
      } catch {
        // startup auto-login failed; tools retry on use
      }
    }

    // NOTE: the transform callback runs inside the plugin host worker (its own
    // global scope), so closures captured in this setup() scope are NOT updated
    // by the callback. Sentinel + composed-id capture must happen inside.
    const registration = await ctx.tool.transform((editor) => {
      for (const t of TOOLS) {
        editor.add(t);
      }
      const ids = editor.list().map(({ id }) => id);
      const sentinel = process.env.XCPQUERY_VERIFY_SENTINEL;
      if (sentinel) {
        fs.writeFileSync(sentinel, JSON.stringify(ids, null, 2), "utf-8");
      }
    });

    return async () => {
      await registration.dispose();
    };
  },
};
