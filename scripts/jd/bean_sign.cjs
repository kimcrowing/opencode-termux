#!/usr/bin/env node
/**
 * 京东签到领京豆（PC 京豆中心「签到领京豆」卡片，动态 assignmentId 链路）
 *
 * 2026-09-09 打通链路的固化版本（替代已失效的 H5 beanDailySign 内置 assignmentId）：
 *  - 查询：GET api.m.jd.com/?functionId=pc_interact_sign_query&body={"type":1}
 *    → 响应 data.assignmentInfoList 中 type=5 & extraType=sign 的项即「PC签到领京豆」，
 *    id 字段 = 每日动态 assignmentId（换期自动适配，无需内置）；completionFlag=true 表示今日已签。
 *  - 执行：POST 同 URL，functionId=pc_interact_sign_execute
 *    body={"type":5,"eaId":<assignmentId>,"itemId":"1","extraType":"sign"}
 *    → data.assignmentRewardInfo.jingDouRewards[].quantity 汇总即奖励京豆。
 *  - 签名：jdpro kr 模式 krh5st（jsdom 模拟浏览器环境，h5st 5.x），appid=asset-h5, client=pc, clientVersion=1.0.0
 *  - 登录态：auth-login 存储的 thor PC cookie（api.m.jd.com 接受）
 *  - 时段：活动每天 10:00-21:00（PC 查询响应 timeStatus 亦体现）
 *
 * 2026-09-09 端到端实测：PC 签到 +2 京豆，明细「活动奖励京豆」11:33 到账 ✅。
 * 历史：H5「天天领豆」= bff_rightsCenter_interaction + activityCode=beanDailySign（appid=signed_wh5,
 * iOS UA），assignmentId 曾内置 VdbAAQEQ4t6u7ZommctabgaobfW（已失效/换期 → 1714001），弃用。
 * ⚠️ 坑：pc_interact_sign_execute 的 POST **绝不能带 Content-Type: application/x-www-form-urlencoded**，
 * 否则 api.m.jd.com 网关返回「互动中心内部访问出现错误」HTML 页；与页面一致只带 UA/Cookie/Referer 即可。
 *
 * 用法：node bean_sign.cjs [--account 用户名] [--skip-time-check] [--debug]
 *   默认处理 storage/jd/accounts/ 下全部账号。
 *   退出码：0=成功/已签到，2=时段外，3=全部失败
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

// PC 浏览器 UA（与京豆中心页面一致；krh5st 签名与请求 UA 必须相同）
const JD_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const ACTIVITY_WINDOW = { start: 10, end: 21 }; // 活动每天 10:00-21:00

// 错误码映射（抓自 channel2022/jd_bean_sign/index-legacy-*.js）
const ERR_MAP = {
  '-1': '出了一点儿小问题，请重试',
  '-100': '请先登录哦~',
  '-1000': '活动太火爆，请稍后再来哦~',
  '3': '请先登录哦~',
  '100': '请先登录哦~',
  '101': '活动太火爆，请稍后再来~',
  '102': '活动太火爆，请稍后再来~',
  '201': '服务器跟不上你啦，请稍后重试',
  '306': '任务已经领取过',
  '307': '倒计时任务还没有领取哦',
  '308': '浏览时间不足哦',
  '309': '您还有未完成的任务哦',
  '310': '啊哦，您可能穿越了，请稍后重试哦~',
  '401': '啊哦，活动太火爆了，请稍后重试吧~',
  '999': '请刷新页面，稍后重试~',
};

function log(...a) { console.log(new Date().toISOString(), ...a); }

function inActivityWindow() {
  const h = new Date().getHours();
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

// ---------- 签名与请求（与京豆中心页面 Ap() 完全一致） ----------
async function callApi(acc, functionId, paramsObj, method) {
  const ck = Object.entries(acc.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const jda = acc.cookies.__jda || '';
  const uuid = jda.split('.')[1] || ''; // 页面：uuid = cookie __jda 第 2 段

  const H5 = require(path.join(JDPRO_FUNC, 'krh5st.js'));
  const bodyRaw = JSON.stringify(paramsObj);
  const h5st = await H5(JD_UA, {
    functionId,
    body: bodyRaw,
    appid: 'asset-h5',
    client: 'pc',
    clientVersion: '1.0.0',
  });
  if (!h5st || h5st.length < 80) return { status: 0, text: '', err: 'h5st-empty: ' + String(h5st).slice(0, 100) };

  const t = Date.now();
  const qs = new URLSearchParams();
  qs.set('h5st', h5st);
  qs.set('uuid', uuid);
  qs.set('loginType', '3');
  qs.set('appid', 'asset-h5');
  qs.set('clientVersion', '1.0.0');
  qs.set('client', 'pc');
  qs.set('t', t);
  qs.set('body', bodyRaw);
  qs.set('functionId', functionId);
  qs.set('area', '1_2802_54747_0');

  const url = 'https://api.m.jd.com/?' + qs.toString();
  // ⚠️ 方法必须与 functionId 匹配（实测）：pc_interact_sign_query → GET；
  //    pc_interact_sign_execute → POST；串用会返回「互动中心内部访问出现错误」HTML 页。
  // ⚠️ 不带 Content-Type！execute 的 POST 带 form-urlencoded 同样被网关判非法返回 HTML 错误页。
  const resp = await fetch(url, {
    method: method || 'GET',
    headers: {
      'User-Agent': JD_UA,
      'Cookie': ck,
      'Accept': '*/*',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Referer': 'https://bean.jd.com/myJingBean/list',
      'Connection': 'keep-alive',
    },
  });
  const text = await resp.text();
  if (DEBUG) log(`[${functionId}] ${resp.status} ${text.slice(0, 300)}`);
  return { status: resp.status, text };
}

// ---------- 签到 ----------
async function signBean(acc) {
  log(`--- 账号 [${acc.pin}] 开始 ---`);

  // 1. 查询今日任务（动态 assignmentId）
  const q = await callApi(acc, 'pc_interact_sign_query', { type: 1 }, 'GET');
  if (q.err) return { pin: acc.pin, ok: false, err: q.err };
  let parsed;
  try { parsed = JSON.parse(q.text); } catch (e) { return { pin: acc.pin, ok: false, err: 'query 非 JSON: ' + q.text.slice(0, 150) }; }
  if (!parsed.success) return { pin: acc.pin, ok: false, err: 'query 失败: ' + (parsed.errMessage || parsed.errCode || q.text.slice(0, 100)) };

  const data = parsed.data || {};
  const list = data.assignmentInfoList || [];
  const task = list.find((x) => x.type === 5 && x.extraType === 'sign') || list[0];
  const assignmentId = task && task.id;
  const itemId = (task && task.signDetail && task.signDetail.itemId) || '1';
  const extraType = (task && task.extraType) || 'sign';
  const completionFlag = !!(task && task.completionFlag);
  const activityId = (data.resourceData && data.resourceData.activityId) || '';
  const newUserTask = data.newUserGuideTask || {};

  if (DEBUG) log('assignmentId:', assignmentId, '| type:', task && task.type, '| completionFlag:', completionFlag, '| activityId:', activityId);
  if (!assignmentId) return { pin: acc.pin, ok: false, err: '未获取到 assignmentId（任务列表为空）' };
  if (completionFlag) { log('ℹ️ 今日已签到，跳过'); return { pin: acc.pin, ok: true, already: true, assignmentId }; }

  // 2. 执行签到
  const ex = await callApi(acc, 'pc_interact_sign_execute', { type: 5, eaId: assignmentId, itemId, extraType }, 'POST');
  if (ex.err) return { pin: acc.pin, ok: false, err: ex.err };
  let exParsed;
  try { exParsed = JSON.parse(ex.text); } catch (e) { return { pin: acc.pin, ok: false, err: 'execute 非 JSON: ' + ex.text.slice(0, 150) }; }
  if (!exParsed.success) {
    const code = String(exParsed.errCode || '');
    return { pin: acc.pin, ok: false, err: `execute 失败 [${code}] ${exParsed.errMessage || ERR_MAP[code] || ex.text.slice(0, 100)}` };
  }

  const reward = (exParsed.data && exParsed.data.assignmentRewardInfo) || {};
  const rewards = (reward.jingDouRewards || []).map((r) => r.quantity || 0);
  const total = rewards.reduce((a, b) => a + b, 0);
  log(`✅ 签到成功，获得 ${total} 京豆`, rewards.length ? `(${rewards.join('+')})` : '(奖励明细为空)');

  // 3. 新人引导任务（若有且未完成，页面逻辑 C(0, id)；无奖励但可点亮引导）
  if (!newUserTask.completionFlag && newUserTask.id) {
    try {
      const g = await callApi(acc, 'pc_interact_sign_execute', { type: 0, eaId: newUserTask.id }, 'POST');
      if (DEBUG) log('[引导任务]', (g.text || '').slice(0, 150));
    } catch (e) { if (DEBUG) log('[引导任务跳过]', e.message); }
  }

  return { pin: acc.pin, ok: true, beans: total, assignmentId };
}

// ---------- main ----------
(async () => {
  log('=== 京东签到领京豆 (PC 京豆中心) ===');
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
      log(r.ok ? (r.already ? 'ℹ️ 已签到' : '✅ 成功') : '❌ 失败: ' + (r.err || ''), '\n');
    } catch (e) {
      results.push({ pin: acc.pin, ok: false, err: e.message });
      log('❌ 异常:', e.message, '\n');
    }
    // 账号间 3 秒间隔（避免风控）
    if (accs.length > 1) await new Promise((r) => setTimeout(r, 3000));
  }

  log('=== 汇总 ===');
  for (const r of results) {
    log((r.ok ? '✅' : '❌'), r.pin, r.already ? '已签到' : r.ok ? `成功 ${r.beans || 0} 豆` : (r.err || '失败'));
  }
  const ok = results.filter((r) => r.ok).length;
  log(`成功 ${ok}/${results.length}`);
  process.exit(ok > 0 ? 0 : 3);
})();