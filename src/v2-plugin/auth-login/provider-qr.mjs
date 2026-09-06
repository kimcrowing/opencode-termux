// provider-qr.mjs — 把二维码文本渲染为 PNG 文件 + ASCII 文本。
//
// 依赖同目录下的 qr.js（矩阵生成）与 png.js（PNG 编码，零依赖）。
// 输出落盘到 storage/<site>/qr-<ts>.png，返回也是 ASCII（方便任何 UI 直接显示）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));

export async function renderQrToFile(siteId, text) {
  const { makeQr } = await import("./qr.js");
  const { matrixToPng } = await import("./png.js");

  const qr = makeQr(text, "M");
  const matrix = qr.toMatrix();
  const png = matrixToPng(matrix, 8, 4);

  const dir = path.join(__dir, "storage", String(siteId));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `qr-${Date.now()}.png`);
  fs.writeFileSync(file, png);

  return { path: file, ascii: qr.toASCII(1) };
}
