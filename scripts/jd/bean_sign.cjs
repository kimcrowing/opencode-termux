#!/usr/bin/env node
/**
 * 京东天天领京豆（beanDailySign）自动签到脚本
 *
 * 2026-09-09 打通链路的固化版本：
 *  - 签名：jdpro kr 模式 krh5st（js_security_v3 → h5st 5.3，tk06 token，isvObfuscator 实时取 token）
 *  - 接口：api.m.jd.com/client.action?functionId=bff_rightsCenter_interaction（2026 年天天领豆真实接口，
 *    旧 signBeanAct 已迁移，返回 402「活动现在挤不进去呀」）
 *  - 参数：appid=signed_wh5，body=beanDailySign 五字段（scene/activityCode/businessScenario/commonScene/assignmentId）
 *  - 登录态：auth-login 存储的 thor PC cookie（api.m.jd.com 接受）
 *  - 时段：活动每天 10:00-21:00，其余时间返回 1714001「请稍后再试」
 *
 * 用法：node bean_sign.cjs [--account 用户名] [--skip-time-check] [--debug]
 *   默认处理 storage/jd/accounts/ 下全部账号。
 */
'use strict';

const fs = require('fs');
const path = require('path');

process.on('uncaughtException', (e) => { console.error('[uncaught]', e.stack || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('[unhandledRejection]', e.stack || e); process.exit(1); });

// ---------- 配置 ----------
const ARGS = process.argv.slice(2);
const SKIP_TIME = ARGS.includes('--skip-time-check');
const ONLY_ACCOUNT = (() => { const i = ARGS.indexOf('--account'); return i >= 0 ? ARGS[i + 1] : null; })();
const DEBUG = ARGS.includes('--debug');

const JDPRO_FUNC = '/data/data/com.termux/files/usr/tmp/opencode/jd-h5st/jdpro/function';
const STORAGE = '/data/data/com.termux/files/home/.config/opencode/projects/opencode-termux/src/v2-plugin/auth-login/storage/jd/accounts';

// 京东 APP 标准 iOS UA（含 ep 加密指纹参数，抓自 jd_signbeanact_.js 20260608 实际请求）
const JD_UA = 'jdapp;iPhone;13.0.0;;;M/5.0;appBuild/169823;jdSupportDarkMode/0;ef/1;ep/%7B%22ciphertype%22%3A5%2C%22cipher%22%3A%7B%22ud%22%3A%22EQTrCNrtDNqyYzDuCNq2CJq0YzO4ZwU2CWS4ZwZvCzGyZQS0DwHsCq%3D%3D%22%2C%22sv%22%3A%22CJUkCM40%22%2C%22iad%22%3A%22%22%7D%2C%22ts%22%3A1788883607%2C%22hdid%22%3A%22JM9F1ywUPwflvMIpYPok0tt5k9kW4ArJEU3lfLhxBqw%3D%22%2C%22version%22%3A%221.0.3%22%2C%22appname%22%3A%22com.360buy.jdmobile%22%2C%22ridx%22%3A-1%7D;Mozilla/5.0 (iPhone; CPU iPhone OS 15_0_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148;supportJDSHWK/1;';

// 天天领豆（beanDailySign）活动参数（抓自 jd_signbeanact_.js 20260608 实际请求）
const ACTIVITY_CODE = 'beanDailySign';
const ASSIGNMENT_ID = 'VdbAAQEQ4t6u7ZommctabgaobfW'; // ★ 若 10:00 后仍失败，需改为动态获取（query 接口）

const ACTIVITY_WINDOW = { start: 10, end: 21 }; // 活动每天 10:00-21:00

function log(...a) { console.log(new Date().toISOString(), ...a); }

function nowHH() { return new Date().getHours(); }

function inActivityWindow() {
  const h = nowHH();
  return h >= ACTIVITY_WINDOW.start && h < ACTIVITY_WINDOW.end;
}

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

// ---------- 签名 ----------
function buildH5st() {
  const H5 = require(path.join(JDPRO_FUNC, 'krh5st.js'));
  return H5;
}

async function makeH5st(H5, body) {
  // krh5st(UA, {functionId, body, appid, client, clientVersion}) → h5st 5.3
  return H5(JD_UA, {
    functionId: 'bff_rightsCenter_interaction',
    body,
    appid: 'signed_wh5',
    client: 'apple',
    clientVersion: '11.1.2',
  });
}

// ---------- 签到 ----------
async function signBean(acc) {
  const ck = Object.entries(acc.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const body = JSON.stringify({
    scene: 'commonDoInteractiveAssignment',
    activityCode: ACTIVITY_CODE,
    businessScenario: 'jingDouCenter',
    commonScene: 'secKillChannel',
    assignmentId: ASSIGNMENT_ID,
  });

  log(`--- 账号 [${acc.pin}] 开始 ---`);
  const H5 = buildH5st();
  const h5st = await makeH5st(H5, body);
  if (!h5st || h5st.length < 80) { log('[!] h5st 生成失败'); return { pin: acc.pin, ok: false, err: 'h5st-empty' }; }
  log('h5st len=' + h5st.length + ' ver=' + h5st.split(';')[5]);

  const form = new URLSearchParams();
  form.set('functionId', 'bff_rightsCenter_interaction');
  form.set('appid', 'signed_wh5');
  form.set('body', body);
  form.set('client', 'apple');
  form.set('clientVersion', '11.1.2');
  form.set('t', Date.now());
  form.set('h5st', h5st);

  const resp = await fetch('https://api.m.jd.com/client.action', {
    method: 'POST',
    headers: {
      'User-Agent': JD_UA,
      'Cookie': ck,
      'Accept': '*/*',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'zh-cn',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': 'https://api.m.jd.com/',
    },
    body: form.toString(),
  });
  const text = await resp.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { parsed = { raw: text.slice(0, 300) }; }
  log(`[resp] ${resp.status} | ${text.slice(0, 400)}`);

  const code = String(parsed.code || '');
  if (code === '0') return { pin: acc.pin, ok: true, code };                     // 成功领豆
  if (code === '1714001') return { pin: acc.pin, ok: false, code, reason: '时段限制(10:00-21:00)或风控' };
  if (code === '1711002') return { pin: acc.pin, ok: false, code, reason: '参数错误(h5st/参数集不匹配)' };
  if (code === '402') return { pin: acc.pin, ok: false, code, reason: '活动已迁移/不可用(signBeanAct 旧码)' };
  if (code === '1' || code === '3') return { pin: acc.pin, ok: false, code, reason: '无访问权限/需登录(cookie 失效?)' };
  return { pin: acc.pin, ok: false, code, reason: '未知返回', raw: text.slice(0, 200) };
}

// ---------- main ----------
(async () => {
  log('=== 京东天天领豆签到 ===');
  log('时间:', new Date().toString());
  if (!inActivityWindow() && !SKIP_TIME) {
    log(`[!] 当前不在活动时段 (${ACTIVITY_WINDOW.start}:00-${ACTIVITY_WINDOW.end}:00)，跳过。可用 --skip-time-check 忽略。`);
    process.exit(2);
  }

  const accs = loadAccounts();
  if (!accs.length) { log('[!] 没有可用账号'); process.exit(1); }
  log('账号数:', accs.length);
  log('');

  const results = [];
  for (const acc of accs) {
    try {
      const r = await signBean(acc);
      results.push(r);
      log(r.ok ? '✅ 成功' : '❌ 失败: ' + (r.reason || ''), '\n');
    } catch (e) {
      results.push({ pin: acc.pin, ok: false, err: e.message });
      log('❌ 异常:', e.message, '\n');
    }
    // 账号间 3 秒间隔（避免风控）
    if (accs.length > 1) await new Promise((r) => setTimeout(r, 3000));
  }

  log('=== 汇总 ===');
  for (const r of results) log((r.ok ? '✅' : '❌'), r.pin, r.ok ? '成功' : (r.reason || r.err || r.code || '失败'));
  const ok = results.filter((r) => r.ok).length;
  log(`成功 ${ok}/${results.length}`);
  process.exit(ok > 0 ? 0 : 3);
})();