#!/usr/bin/env node
/**
 * 京东「评价领京豆」固化脚本（PC club.jd.com 链路，免 h5st）
 *
 * 链路（2026-09-09 无头抓包 + node 直测双实证）：
 *   1. GET https://club.jd.com/myJdcomments/myJdcomment.action?sort=0 （待评价列表，服务端渲染）
 *      提取全部待评价订单 ruleid（orderVoucher.action?ruleid=xxx）
 *   2. GET https://club.jd.com/myJdcomments/orderVoucher.action?ruleid=<oid> （评价表单页）
 *      提取 orderId（元素 o-info-orderinfo 的 oId 属性）+ productId（item.jd.com/<pid>.html）
 *   3. POST https://club.jd.com/myJdcomments/saveProductComment.action
 *      参数：orderId / productId / score=5 / content=<双重urlencode>/ saveStatus=1 / anonymousFlag=1
 *      响应 {"success":true,"resultCode":"1"} = 评价成功，京豆约一天到账
 *
 * 实测记录：
 *   - 回力裤 3555458004465923（浏览器）→ success，页面提示「京豆将于一天左右返到你的账户中」
 *   - 十月稻田 3575458002035437（纯脚本直连）→ {"acc":"1","success":true,"resultCode":"1"}
 *   - 无需先做服务调查（insertRestSurvey）/ 安装评价（saveInstallComment），直接 POST 商品评价即成功
 *
 * 用法：node jd_comment_bean.cjs [--account loon520] [--dry-run] [--debug]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ACCT_DIR = path.join(__dirname, '../../src/v2-plugin/auth-login/storage/jd/accounts');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? (process.argv[i + 1] || def) : def;
}
const ACCOUNT = arg('account', 'loon520');
const DRY = process.argv.includes('--dry-run');
const DEBUG = process.argv.includes('--debug');

async function loadCookies() {
  const file = path.join(ACCT_DIR, ACCOUNT + '.json');
  const acct = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ck = Object.entries(acct.cookies || {}).map(([k, v]) => `${k}=${v}`).join('; ');
  if (!ck || !acct.cookies || !acct.cookies.thor) throw new Error('账号 cookie 缺失或无 thor: ' + file);
  return ck;
}

async function get(url, ck, referer) {
  const res = await fetch(url, { headers: { 'Cookie': ck, 'User-Agent': UA, ...(referer ? { 'Referer': referer } : {}) } });
  const html = await res.text();
  if (res.status !== 200) throw new Error('HTTP ' + res.status + ' @ ' + url);
  return html;
}

async function listPendingOrders(ck) {
  const html = await get('https://club.jd.com/myJdcomments/myJdcomment.action?sort=0', ck, 'https://club.jd.com/');
  const ruleids = [...new Set([...html.matchAll(/orderVoucher\.action\?ruleid=(\d+)/g)].map(m => m[1]))];
  return ruleids;
}

async function orderInfo(ruleid, ck) {
  const html = await get(`https://club.jd.com/myJdcomments/orderVoucher.action?ruleid=${ruleid}`, ck,
    'https://club.jd.com/myJdcomments/myJdcomment.action?sort=0');
  const orderId = (html.match(/o-info-orderinfo[^>]*oId="(\d+)"/) || html.match(/oId="(\d+)"/) || [])[1];
  const productId = (html.match(/item\.jd\.com\/(\d+)\.html/) || [])[1];
  const name = (html.replace(/<script[\s\S]*?<\/script>/g, '').match(/<a[^>]*item\.jd\.com[^>]*>([\s\S]*?)<\/a>/) || [])[1];
  const productName = name ? name.replace(/<[^>]+>/g, '').trim().slice(0, 60) : '';
  if (!orderId || !productId) throw new Error(`无法提取 orderId/productId @ ruleid=${ruleid}`);
  return { ruleid, orderId, productId, productName };
}

async function submitComment(info, content, ck) {
  // 与浏览器一致：content 双重 urlencode（submitService encodeURIComponent + jQuery 序列化）
  const body = 'orderId=' + info.orderId +
    '&productId=' + info.productId +
    '&score=5' +
    '&content=' + encodeURIComponent(encodeURIComponent(content)) +
    '&saveStatus=1' +
    '&anonymousFlag=1';
  const res = await fetch('https://club.jd.com/myJdcomments/saveProductComment.action', {
    method: 'POST',
    headers: {
      'Cookie': ck, 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': `https://club.jd.com/myJdcomments/orderVoucher.action?ruleid=${info.ruleid}`,
      'X-Requested-With': 'XMLHttpRequest'
    },
    body
  });
  const txt = await res.text();
  let j = null; try { j = JSON.parse(txt); } catch (e) {}
  return { http: res.status, raw: txt, json: j };
}

const DEFAULT_CONTENT = '产品品质不错，包装完好，日期新鲜，物流速度快，客服态度好，性价比高，好评！';

async function main() {
  const ck = await loadCookies();
  console.log(`账号: ${ACCOUNT} | 模式: ${DRY ? 'DRY-RUN' : 'REAL'}`);
  const ruleids = await listPendingOrders(ck);
  console.log('待评价订单: ' + (ruleids.length ? ruleids.join(', ') : '(无)'));
  if (!ruleids.length) { console.log('没有待评价订单'); return; }

  const results = [];
  for (const ruleid of ruleids) {
    try {
      const info = await orderInfo(ruleid, ck);
      console.log(`\n[${ruleid}] ${info.productName || ''} | productId=${info.productId}`);
      if (DRY) { console.log('  (dry-run) 跳过提交'); results.push({ ...info, status: 'dry-run' }); continue; }
      const r = await submitComment(info, DEFAULT_CONTENT, ck);
      const ok = r.json && (r.json.success === true || String(r.json.resultCode) === '1');
      console.log(`  HTTP:${r.http} | 响应: ${r.raw.slice(0, 120)} | ${ok ? '✅ 评价成功' : '❌ 可能失败'}`);
      if (DEBUG) console.log('  body: orderId=' + info.orderId + '&productId=' + info.productId + '&score=5&content=' + encodeURIComponent(encodeURIComponent(DEFAULT_CONTENT)).slice(0, 80) + '...&saveStatus=1&anonymousFlag=1');
      results.push({ ...info, status: ok ? 'ok' : 'fail', resp: r.raw });
    } catch (e) {
      console.log(`\n[${ruleid}] 错误: ${e.message}`);
      results.push({ ruleid, status: 'error', err: e.message });
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log('\n==== 汇总 ====');
  for (const r of results) console.log(` ${r.status === 'ok' ? '✅' : '❌'} ${r.ruleid} ${r.productName || ''} ${r.status === 'error' ? r.err : ''}`);
  const ok = results.filter(r => r.status === 'ok').length;
  console.log(`成功 ${ok}/${results.length}（京豆约一天后到账）`);
  if (DRY) console.log('（dry-run 未实际提交）');
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });