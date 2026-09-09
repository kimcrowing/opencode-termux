#!/usr/bin/env node
/**
 * 京东「晒单领京豆」固化脚本（PC club.jd.com 链路，免 h5st/免无头浏览器）
 *
 * 链路（2026-09-09 无头 + 纯 node 双实证，5 单全部提交移除）：
 *   1. GET https://club.jd.com/myJdcomments/myJdcomment.action?sort=1 （待晒单列表，服务端渲染）
 *      提取每个商品的 imgContainer_<orderId>_<productId>（id 属性即参数对）
 *   2. 程序生成纯色 PNG（node zlib 手写编码，无需外部图片）
 *      → POST https://club.jd.com/myJdcomments/ajaxUploadImage.action （multipart: PHPSESSID + Filedata）
 *      响应为纯文本路径（如 jfs/t1/.../xxx.jpg），拼 URL: //img30.360buyimg.com/shaidan/ + 路径
 *   3. POST https://club.jd.com/myJdcomments/saveShowOrder.action
 *      参数：orderId / productId / imgs=<图片URL，urlencode> / saveStatus=3
 *      → 响应 {"success":false,"resultCode":"24","error":"系统异常请稍后再试"} 是**成功受理**
 *        （实测：每次 24 后订单即从待晒单列表移除，5/5 全移除；京豆审核后约一天到账）
 *
 * 实测记录：
 *   - 红卫羊脂皂 3595458016191925 / 福东海 3595458016189989 / 海尔 3581458011664304 /
 *     十月稻田 3575458002035437 / 回力 3555458004465923 全部提交并移除
 *   - 空 imgs 提交会真失败（resultCode 24 但订单不移除 → 已用该现象做成功判定基准）
 *   - 上传接口必须带 multipart 参数 PHPSESSID（来自 cookie），否则/空值上传仍成功
 *   - cookie 用 auth-login 存储的账号 cookie 即足够，无需实时刷新
 *
 * 用法：node jd_photo_bean.cjs [--account loon520] [--dry-run] [--debug]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ACCT_DIR = path.join(__dirname, '../../src/v2-plugin/auth-login/storage/jd/accounts');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const LIST_URL = 'https://club.jd.com/myJdcomments/myJdcomment.action?sort=1';
const UPLOAD_URL = 'https://club.jd.com/myJdcomments/ajaxUploadImage.action';
const SUBMIT_URL = 'https://club.jd.com/myJdcomments/saveShowOrder.action';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? (process.argv[i + 1] || def) : def;
}
const ACCOUNT = arg('account', 'loon520');
const DRY = process.argv.includes('--dry-run');
const DEBUG = process.argv.includes('--debug');
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---- 手写 PNG（纯色块，无外部图片依赖）----
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function makePng(w, h, [r, g, b]) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(h * (1 + w * 3));
  let o = 0;
  for (let y = 0; y < h; y++) { raw[o++] = 0; for (let x = 0; x < w; x++) { raw[o++] = r; raw[o++] = g; raw[o++] = b; } }
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
}
const COLORS = [[180, 120, 60], [90, 140, 220], [80, 180, 80], [200, 90, 140], [120, 60, 180]];

async function loadCookies() {
  const file = path.join(ACCT_DIR, ACCOUNT + '.json');
  const acct = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cookies = { ...(acct.cookies || {}) };
  if (!cookies.thor) throw new Error('账号 cookie 缺失或无 thor: ' + file);
  const ckStr = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const mergeSetCookie = (res) => {
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const s of sc) { const [pair] = s.split(';'); const i = pair.indexOf('='); if (i > 0) cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
  };
  return { cookies, ckStr, mergeSetCookie };
}

async function getList(ctx) {
  const res = await fetch(LIST_URL, { headers: { 'Cookie': ctx.ckStr(), 'User-Agent': UA, 'Referer': 'https://club.jd.com/' } });
  ctx.mergeSetCookie(res);
  const html = await res.text();
  const pairs = [...html.matchAll(/id="imgContainer_(\d+)_(\d+)"/g)].map(m => ({ orderId: m[1], productId: m[2] }));
  return { pairs, html };
}

async function uploadImage(ctx, png) {
  const fd = new FormData();
  fd.append('PHPSESSID', ctx.cookies.PHPSESSID || '');
  fd.append('Filedata', new Blob([png], { type: 'image/png' }), 'photo_' + Date.now() + '.png');
  const res = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: { 'Cookie': ctx.ckStr(), 'User-Agent': UA, 'Referer': LIST_URL },
    body: fd
  });
  ctx.mergeSetCookie(res);
  const t = (await res.text()).trim();
  if (res.status !== 200 || t.startsWith('e2') || t.startsWith('http')) throw new Error('图片上传失败: HTTP ' + res.status + ' resp=' + t.slice(0, 80));
  return '//img30.360buyimg.com/shaidan/' + t;
}

async function submitPhoto(ctx, info, imgUrl) {
  const body = 'orderId=' + info.orderId + '&productId=' + info.productId +
    '&imgs=' + encodeURIComponent(imgUrl) + '&saveStatus=3';
  const res = await fetch(SUBMIT_URL, {
    method: 'POST',
    headers: {
      'Cookie': ctx.ckStr(), 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': LIST_URL, 'X-Requested-With': 'XMLHttpRequest', 'Origin': 'https://club.jd.com'
    },
    body
  });
  ctx.mergeSetCookie(res);
  const txt = await res.text();
  let j = null; try { j = JSON.parse(txt); } catch (e) {}
  // resultCode 24 = 成功受理（订单随即从列表移除）；以「列表减少」为成功判定
  return { http: res.status, raw: txt, json: j };
}

async function main() {
  log(`=== 京东晒单领京豆 ===`);
  const ctx = await loadCookies();
  log(`账号: ${ACCOUNT} | 模式: ${DRY ? 'DRY-RUN' : 'REAL'}`);
  const list0 = await getList(ctx);
  log(`待晒单 ${list0.pairs.length} 单: ${list0.pairs.map(p => p.orderId).join(',') || '(无)'}`);
  if (!list0.pairs.length) { log('没有待晒单商品'); return; }

  const results = [];
  let before = list0.pairs.length;
  for (let i = 0; i < list0.pairs.length && before > 0; i++) {
    const cur = await getList(ctx);
    if (!cur.pairs.length) { log('待晒单已清空'); break; }
    const info = cur.pairs[0];
    if (DRY) { log(`  [${info.orderId}/${info.productId}] (dry-run) 跳过`); results.push({ ...info, status: 'dry-run' }); continue; }
    const png = makePng(640, 640, COLORS[i % COLORS.length]);
    const imgUrl = await uploadImage(ctx, png);
    if (DEBUG) log(`  [${info.orderId}] 图片: ${imgUrl.slice(-70)}`);
    const r = await submitPhoto(ctx, info, imgUrl);
    // 成功判定：提交后列表数量减少（resultCode 24 恒为成功受理的假象）
    await new Promise(res => setTimeout(res, 1500));
    const after = await getList(ctx);
    const removed = after.pairs.length < before;
    const msg = removed ? '✅ 已受理（订单移除，京豆约一天后到账）' : '❌ 未移除（可能真失败）';
    log(`  [${info.orderId}/${info.productId}] HTTP:${r.http} resp:${r.raw.slice(0, 90)} | ${msg} | 剩余 ${after.pairs.length}`);
    if (DEBUG) log(`  body: orderId=${info.orderId}&productId=${info.productId}&imgs=${imgUrl.slice(-40)}&saveStatus=3`);
    results.push({ ...info, status: removed ? 'ok' : 'fail', resp: r.raw });
    before = after.pairs.length;
    if (!removed) { log('  列表未减少，停止（避免死循环）'); break; }
  }

  log(`\n==== 汇总 ====`);
  for (const r of results) log(` ${r.status === 'ok' ? '✅' : r.status === 'dry-run' ? '⏭️' : '❌'} ${r.orderId}/${r.productId} ${r.status === 'fail' ? r.resp : ''}`);
  const ok = results.filter(r => r.status === 'ok').length;
  log(`受理 ${ok}/${results.length}（京豆约一天后到账）`);
  if (DRY) log('（dry-run 未实际提交）');
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });