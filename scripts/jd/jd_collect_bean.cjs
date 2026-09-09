#!/usr/bin/env node
/**
 * 京东购物返豆（订单京豆）自动领取脚本
 *
 * 2026-09-09 打通链路的固化版本：
 *  - 免签名链路（实测全部接口无需 h5st）：
 *    manualCollectIndex  → 查待领取订单（orderList 里 collectStatus=0 的可领）
 *    getManualCollectOrderList → 领取历史
 *    manualCollectBeans  → 执行领取（body 传 orderIdList）
 *  - 接口：api.m.jd.com/client.action?functionId=manualCollectBeans&appid=ld&client=wh5
 *  - 登录态：auth-login 存储的 thor PC cookie
 *  - 实测样本：2026-09-09 领 63+5=68 豆，余额 376→444
 *
 * 用法：node jd_collect_bean.cjs [--account 用户名] [--dry-run] [--debug]
 *   默认处理 storage/jd/accounts/ 下全部账号。
 */
'use strict';

const fs = require('fs');
const path = require('path');

process.on('uncaughtException', (e) => { console.error('[uncaught]', e.stack || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('[unhandledRejection]', e.stack || e); process.exit(1); });

// ---------- 配置 ----------
const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes('--dry-run');
const ONLY_ACCOUNT = (() => { const i = ARGS.indexOf('--account'); return i >= 0 ? ARGS[i + 1] : null; })();
const DEBUG = ARGS.includes('--debug');

const STORAGE = '/data/data/com.termux/files/home/.config/opencode/projects/opencode-termux/src/v2-plugin/auth-login/storage/jd/accounts';

// 无头浏览器实测抓到的 UA（Android 手机，页面真实请求）
const H5_UA = 'Mozilla/5.0 (Linux; Android 11; Redmi K40) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const REFERER = 'https://h5.m.jd.com/babelDiy/Zeus/8YJckyCsVr9ZiLBT6hDWS2ngjS3/index.html';

function log(...a) { console.log(new Date().toISOString(), ...a); }

// ---------- 账号读取 ----------
function loadAccounts() {
  if (!fs.existsSync(STORAGE)) { log('[!] 账号存储目录不存在:', STORAGE); return []; }
  const files = fs.readdirSync(STORAGE).filter((f) => f.endsWith('.json'));
  const accs = [];
  for (const f of files) {
    try {
      const a = JSON.parse(fs.readFileSync(path.join(STORAGE, f), 'utf8'));
      if (!a.cookies || !Object.keys(a.cookies).length) { log('[!] 跳过空账号文件', f); continue; }
      const pin = (a.user && a.user.username) || a.cookies.pin || a.cookies.pt_pin || f.replace('.json', '');
      if (ONLY_ACCOUNT && pin !== ONLY_ACCOUNT) continue;
      accs.push({ file: f, pin, cookies: a.cookies });
    } catch (e) { log('[!] 读取失败:', f, e.message); }
  }
  return accs;
}

// ---------- 接口调用 ----------
async function callWh5(acc, functionId, bodyObj) {
  const ck = Object.entries(acc.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const t = Date.now();
  // uuid 优先取 __jdu（页面实测用 __jdu 值），否则用固定样本
  const uuid = acc.cookies.__jdu || '17889182012391376541285';
  const url = `https://api.m.jd.com/client.action?functionId=${functionId}` +
    `&body=${encodeURIComponent(JSON.stringify(bodyObj))}` +
    `&appid=ld&clientVersion=1.0.0&client=wh5&jsonp=cb${t}&uuid=${uuid}&area=1_2802_54747_0`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': H5_UA,
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Referer': REFERER,
      'Cookie': ck,
    },
  });
  const text = await resp.text();
  // 去掉 jsonp 包裹
  const m = text.match(/^[^(]*\((.*)\)\s*;?\s*$/s);
  let parsed;
  try { parsed = JSON.parse(m ? m[1] : text); } catch (e) { parsed = { raw: text.slice(0, 300) }; }
  return { status: resp.status, parsed };
}

// ---------- 主流程 ----------
async function collectBeans(acc) {
  log(`--- 账号 [${acc.pin}] 开始 ---`);
  // 1) 查待领取订单
  const idx = await callWh5(acc, 'manualCollectIndex', { rnClient: '1' });
  if (DEBUG) log('[index resp]', JSON.stringify(idx.parsed).slice(0, 500));
  if (idx.status !== 200 || String(idx.parsed.code) !== '0') {
    return { pin: acc.pin, ok: false, reason: `index 失败 status=${idx.status} code=${idx.parsed.code}`, raw: JSON.stringify(idx.parsed).slice(0, 200) };
  }
  const data = idx.parsed.data || {};
  const orderList = data.orderList || [];
  const claimable = orderList.filter((o) => Number(o.collectStatus) === 0);
  log(`待领取订单 ${claimable.length}/${orderList.length} | 余额 ${data.balanceBeans} 豆`);
  if (!claimable.length) {
    return { pin: acc.pin, ok: true, claimed: 0, reason: '无可领取京豆', balance: data.balanceBeans };
  }
  for (const o of claimable) {
    log(`  可领: 订单 ${o.orderIdStr} +${o.orderJpeasNum} 豆 (截止 ${new Date(o.collectDeadline).toISOString()})`);
  }
  if (DRY_RUN) {
    log('[dry-run] 跳过实际领取');
    return { pin: acc.pin, ok: true, claimed: claimable.length, dry: true, balance: data.balanceBeans };
  }
  // 2) 执行领取
  const orderIdList = claimable.map((o) => String(o.orderIdStr));
  const cl = await callWh5(acc, 'manualCollectBeans', { orderIdList });
  if (DEBUG) log('[collect resp]', JSON.stringify(cl.parsed).slice(0, 400));
  if (cl.status !== 200 || String(cl.parsed.code) !== '0') {
    return { pin: acc.pin, ok: false, reason: `领取失败 code=${cl.parsed.code}`, raw: JSON.stringify(cl.parsed).slice(0, 200) };
  }
  const sum = claimable.reduce((s, o) => s + Number(o.orderJpeasNum || 0), 0);
  log(`✅ 领取成功 (${orderIdList.length} 单, 预计 +${sum} 豆): collectStatus=${cl.parsed.data && cl.parsed.data.collectStatus}`);
  // 3) 领取后复查
  await new Promise((r) => setTimeout(r, 1500));
  const idx2 = await callWh5(acc, 'manualCollectIndex', { rnClient: '1' });
  const remain = ((idx2.parsed.data || {}).orderList || []).filter((o) => Number(o.collectStatus) === 0);
  const balance2 = (idx2.parsed.data || {}).balanceBeans;
  log(`复查: 剩余待领 ${remain.length} 单, 余额 ${balance2} 豆`);
  return { pin: acc.pin, ok: true, claimed: claimable.length, beans: sum, balanceAfter: balance2 };
}

// ---------- main ----------
(async () => {
  log('=== 京东购物返豆领取 ===');
  log('时间:', new Date().toString());
  const accs = loadAccounts();
  if (!accs.length) { log('[!] 没有可用账号'); process.exit(1); }
  log('账号数:', accs.length);
  log('');

  const results = [];
  for (const acc of accs) {
    try {
      const r = await collectBeans(acc);
      results.push(r);
      log(r.ok ? (r.claimed ? '✅ 完成' : 'ℹ️ ' + r.reason) : '❌ 失败: ' + (r.reason || ''), '\n');
    } catch (e) {
      results.push({ pin: acc.pin, ok: false, err: e.message });
      log('❌ 异常:', e.message, '\n');
    }
    if (accs.length > 1) await new Promise((r) => setTimeout(r, 3000));
  }

  log('=== 汇总 ===');
  for (const r of results) log((r.ok ? '✅' : '❌'), r.pin, r.ok ? (r.claimed ? `领 ${r.claimed} 单${r.beans ? ' +' + r.beans + '豆' : ''}` : r.reason) : (r.reason || r.err || '失败'));
  const ok = results.filter((r) => r.ok).length;
  log(`成功 ${ok}/${results.length}`);
  process.exit(ok > 0 ? 0 : 3);
})();