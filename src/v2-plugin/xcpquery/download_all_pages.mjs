// 独立脚本：下载文档的全部页（修复 getDownloadUrl 只取 ossLujingList[0] 的问题）
// 用法: node download_all_pages.mjs <patent_no> <rid> <ds> <wenjiandm> <输出前缀>
import fs from "node:fs";
import { setCredentials, ensureSession, cpqueryRequest } from "./core.mjs";
import { browserRequest } from "./cjs/browser.mjs";

const CNIPA = "https://cpquery.cponline.cnipa.gov.cn";

function loadEnv(name) {
  const f = `/data/data/com.termux/files/usr/var/service/opencode2/env/${name}`;
  try { return fs.readFileSync(f, "utf8").trim(); } catch (_) { return process.env[name]; }
}

const [patentNo, rid, ds, wenjiandm, outPrefix] = process.argv.slice(2);
if (!patentNo || !rid || !ds || !wenjiandm || !outPrefix) {
  console.error("用法: node download_all_pages.mjs <patentNo> <rid> <ds> <wenjiandm> <outPrefix>");
  process.exit(1);
}

setCredentials(loadEnv("CNIPA_USERNAME"), loadEnv("CNIPA_PASSWORD"));
await ensureSession();

// 获取文件信息（含全部 OSS 路径）
const body = { rid, ds, wenjiandm, zhuanlisqh: patentNo };
const fi = (await cpqueryRequest("POST", "/api/view/gn/fetch-file-infos", body)).data || {};
const list = fi.ossLujingList || [];
console.log(`ossLujingList 共 ${list.length} 项`);
list.forEach((o, i) => console.log(`  [${i}] ${o.osslujing}`));

if (!list.length) {
  console.error("没有可下载的 OSS 路径");
  process.exit(1);
}

// 逐个下载
const results = [];
for (let i = 0; i < list.length; i++) {
  const oss = list[i];
  const m = String(oss.osslujing || "").match(/\.(\w+)$/);
  const ext = m ? m[1].toLowerCase() : (fi.wenjianhzm || "pdf").toLowerCase();
  const params = new URLSearchParams({
    osslujing: oss.osslujing,
    wenjianhzm: ext,
    timestamp: String(oss.timestamp),
    sign: oss.sign,
    isDN: oss.isDN ? "true" : "false",
    ds: fi.ds || "",
    wenjiandm: fi.wenjiandm || "",
  });
  const url = `${CNIPA}/api/pcshoss/view/fetch-file?${params.toString()}`;
  const u = new URL(url);
  const pathAndQuery = u.pathname + u.search;
  console.log(`正在下载页 ${i + 1}/${list.length} (${ext})...`);
  const res = await browserRequest("GET", pathAndQuery, { headers: { Accept: "*/*" }, binary: true });
  if (res.status !== 200 || !res.body) {
    console.error(`下载失败: HTTP ${res.status}`);
    process.exit(1);
  }
  const buf = Buffer.from(res.body, "base64");
  const outFile = `${outPrefix}_${String(i + 1).padStart(2, "0")}.${ext}`;
  fs.writeFileSync(outFile, buf);
  console.log(`已保存: ${outFile} (${buf.length} bytes)`);
  results.push({ file: outFile, size: buf.length, ext });
}

console.log("全部完成:");
console.log(JSON.stringify(results, null, 2));