// providers/jd.mjs — 京东扫码登录 + 京豆任务适配器。
//
// 【端点实测记录（2026-09-08 本机 curl，PC 码京东 App 可扫）】
//   登录流（passport 域，无需签名）：
//     1) GET https://passport.jd.com/new/login.aspx            → HTTP 200，种会话 cookie
//     2) GET https://qr.m.jd.com/show?appid=133&size=147&t=<ms>
//        → HTTP 200 返回二维码 PNG（~770 字节，京东 App 可直接扫），
//          Set-Cookie: guid / QRCodeKey(域.qr.m.jd.com) / wlfstk_smdl(域.jd.com，即轮询 token)
//     3) GET https://qr.m.jd.com/check?callback=jQuery<rand>&appid=133&token=<wlfstk_smdl>&_=<ms>
//        （需带 Referer: https://passport.jd.com/new/login.aspx + 上述 cookie）
//        → JSONP: code 201=未扫描 / 202=已扫待确认 / 200=ticket / 203=过期 / 257=二维码无效
//     4) ★成功关键（2026-09-08 实测，之前失败→成功只差这几项）：
//        GET https://passport.jd.com/uc/qrCodeTicketValidation?t=<ticket>
//            &ReturnUrl=https%3A%2F%2Fwww.jd.com%2F&callback=jsonp
//        Headers: Referer: https://union.jd.com/index
//                 Cookie: 只带 wlfstk_smdl=<token>（不要带全部会话 cookie！）
//        → 响应 jsonp({"returnCode":0,"url":"https://www.jd.com/"})，
//          Set-Cookie 为 PC 端登录 cookie（非 pt_key/pt_pin！）：
//          thor（核心登录态）/ pin=<用户名> / unick=<昵称> / light_key / flash /
//          TrackID / logining=1 / _pst / pinId / _tp / ceshi3.com 等（.jd.com 域，~1 年有效）。
//        之前不带 ReturnUrl/callback、Referer 用 passport.uc.login、Cookie 带全量会话
//        → 返回 riskCode:1100（要求 aq.jd.com 安全验证），无任何登录 cookie —— 死路。
//        带 ReturnUrl+callback+只带 wlfstk_smdl → returnCode:0 + thor 体系 cookie，绕过风控！
//   已知坑：
//     - 二维码有效期很短（实测约 1~2 分钟内未扫即 257 无效），provider 本地兜底 100s 过期。
//     - check 返回 JSONP（jQuery<rand>({...})），需剥壳解析，不能直接 JSON.parse。
//     - ★移动端流（plogin.m.jd.com/cgi-bin/m/tmauth）不可用：生成的 tmauth 链接二维码
//       京东 App 扫码提示「暂无可用打开方式」（openapp.jdmobile:// 深度链打不开），
//       只适合手机浏览器扫。PC 端 qr.m.jd.com 码才是京东 App 标准的扫码登录。
//     - ★PC 扫码拿到的是 thor 体系（持久化 s.cookies 全量 PC cookie），不是 pt_key/pt_pin。
//       api.m.jd.com 的 signBeanAct 实测识别 thor 体系为已登录（返回 S109「签到人数较多」
//       而非未登录 402）→ PC cookie 对京豆签到接口有效。
//   京豆任务（api.m.jd.com，实测 thor 体系可用）：
//     - 京豆签到: GET https://api.m.jd.com/client.action?functionId=signBeanAct&body=<urlenc>&
//         appid=ld&client=apple&clientVersion=10.0.4&networkType=wifi&osVersion=14.8.1&uuid=<uuid>&open=0&t=<ms>
//         body(JSON): {"fp":"-1","shshshfp":"-1","shshshfpa":"-1","referUrl":"-1",
//                      "userAgent":"-1","jda":"-1","rnVersion":"3.9"}
//         无 cookie: code 402「活动现在挤不进去呀」；有 thor 体系 cookie: code 0 + S109
//         「当前签到人数较多，请稍晚再来」= 登录有效、服务端限量/限流，稍后/次日重试。
//     - 用户信息/京豆: wq.jd.com/user/info/QueryJDUserInfo?sceneval=2 实测 403 nginx
//         （WAF 拦 thor 体系或需移动特征，待debug）；passport getUserInfoForMiniJd 302。
//
//   登录态 = cookie 字典（非 token），持久化到 s.cookies，
//   京东无官方 token 刷新机制 → 不实现 refresh()，cookie 失效靠重新扫码(update) 续期。

import { SITE_STATE } from "../core.mjs";

const LOGIN_PAGE = "https://passport.jd.com/new/login.aspx";
const QR_SHOW = "https://qr.m.jd.com/show";
const QR_CHECK = "https://qr.m.jd.com/check";
const TICKET_VALIDATE = "https://passport.jd.com/uc/qrCodeTicketValidation";
const PET_NAME = "https://passport.jd.com/user/petName/getUserInfoForMiniJd.action";
const WQ_USER_INFO = "https://wq.jd.com/user/info/QueryJDUserInfo?sceneval=2";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function jdHeaders(extra = {}) {
  return Object.assign(
    {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      Connection: "keep-alive",
      Referer: LOGIN_PAGE,
    },
    extra
  );
}

// 解析 Set-Cookie 头为 cookie 字典（保留最后一个同名值；忽略 Path/Domain/Expires 元数据）。
function parseSetCookies(res) {
  const out = {};
  let arr = [];
  try {
    arr = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  } catch {
    arr = [];
  }
  if (!arr.length) {
    const raw = res.headers.get("set-cookie");
    if (raw) arr = [raw];
  }
  for (const line of arr) {
    const seg = String(line).split(";")[0];
    const eq = seg.indexOf("=");
    if (eq <= 0) continue;
    const k = seg.slice(0, eq).trim();
    const v = seg.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function cookieString(dict) {
  return Object.entries(dict || {})
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function rand() {
  return Math.floor(Math.random() * 9000000) + 1000000;
}

// 剥 JSONP 壳（jQuery1234({...})）→ 对象
function parseJsonp(text) {
  const m = String(text).match(/\((\{.*\})\)/s);
  if (m) {
    try {
      return JSON.parse(m[1]);
    } catch {}
  }
  try {
    return JSON.parse(String(text).trim());
  } catch {}
  return null;
}

export default {
  id: "jd",
  name: "京东",
  apiBase: "https://api.m.jd.com",
  pollIntervalMs: 2000,
  qrTimeoutMs: 100000, // 京东二维码实测约 1~2 分钟有效，本地兜底 100s

  // 生成二维码：先访问登录页种会话 cookie，再拉二维码 PNG。
  // 返回 { base64 } → core 落盘为 storage/jd/qr-<ts>.png（原图直接展示，不重编码）。
  async generateQr(s) {
    const login = await fetch(LOGIN_PAGE, { headers: jdHeaders() });
    let cookies = parseSetCookies(login);

    const show = await fetch(`${QR_SHOW}?appid=133&size=147&t=${Date.now()}`, {
      headers: jdHeaders({ Cookie: cookieString(cookies) }),
    });
    if (!show.ok) throw new Error(`获取二维码失败 HTTP ${show.status}`);
    const buf = Buffer.from(await show.arrayBuffer());
    Object.assign(cookies, parseSetCookies(show));
    s._jdCookies = cookies;
    s._qrT0 = Date.now();
    return {
      base64: buf.toString("base64"),
      ascii: "[京东] 扫码登录二维码已生成，请用京东 App「扫一扫」扫描并在手机上确认登录。二维码约 1~2 分钟内有效。",
    };
  },

  // 轮询扫码状态；code 200 时拿 ticket 换登录 cookie。
  async pollStatus(s) {
    const ck = (s && (s._jdCookies || s.cookies)) || {};
    const token = ck.wlfstk_smdl;
    if (!token) return { state: SITE_STATE.ERROR, message: "缺少 wlfstk_smdl（请重新生成二维码）" };

    if (s._qrT0 && Date.now() - s._qrT0 > 100000) {
      return { state: SITE_STATE.EXPIRED };
    }

    let j = null;
    try {
      const url = `${QR_CHECK}?callback=jQuery${rand()}&appid=133&token=${encodeURIComponent(token)}&_=${Date.now()}`;
      const res = await fetch(url, {
        headers: jdHeaders({
          Host: "qr.m.jd.com",
          Cookie: cookieString(ck),
        }),
      });
      const text = await res.text();
      if (!res.ok) return { state: SITE_STATE.ERROR, message: `轮询 HTTP ${res.status}: ${text.slice(0, 120)}` };
      j = parseJsonp(text);
    } catch (e) {
      return { state: SITE_STATE.WAITING }; // 网络抖动：下轮再试
    }
    if (!j) return { state: SITE_STATE.WAITING };

    const code = Number(j.code);
    if (code === 201) return { state: SITE_STATE.WAITING };
    if (code === 202) return { state: SITE_STATE.SCANNED };
    if (code === 200 && j.ticket) {
      return await this.doLogin(String(j.ticket), s);
    }
    if (code === 203) return { state: SITE_STATE.EXPIRED };
    return { state: SITE_STATE.ERROR, message: `扫码状态异常 code=${code}: ${j.msg || ""}` };
  },

  // ticket 换登录态 cookie（PC 扫码流 → thor 体系，非 pt_key！）。
  // ★ 实测绕风控 riskCode:1100 的成功参数（2026-09-08/09，勿回退成旧参数）：
  //   Referer=union.jd.com/index；Cookie 只带 wlfstk_smdl（不要全量会话 cookie！）；
  //   URL 带 ReturnUrl=https%3A%2F%2Fwww.jd.com%2F + callback=jsonp（响应是 JSONP 壳）。
  async doLogin(ticket, s) {
    try {
      const ck = (s && (s._jdCookies || s.cookies)) || {};
      const wlfstk = ck.wlfstk_smdl || "";
      const url =
        `${TICKET_VALIDATE}?t=${encodeURIComponent(ticket)}` +
        `&ReturnUrl=${encodeURIComponent("https://www.jd.com/")}&callback=jsonp`;
      const res = await fetch(url, {
        headers: jdHeaders({
          Referer: "https://union.jd.com/index",
          Cookie: wlfstk ? `wlfstk_smdl=${wlfstk}` : "",
        }),
      });
      const text = await res.text();
      let j = null;
      try {
        j = parseJsonp(text);
      } catch {}
      const newCookies = parseSetCookies(res);
      // 合并：会话 cookie（guid/QRCodeKey/wlfstk_smdl） + 登录 Set-Cookie（thor/pin/unick/...）
      const merged = Object.assign({}, ck, newCookies);

      if (!res.ok) {
        return { state: SITE_STATE.ERROR, message: `换 token HTTP ${res.status}: ${text.slice(0, 120)}` };
      }
      if (j && j.returnCode !== undefined && Number(j.returnCode) !== 0) {
        const msg = (j && (j.message || j.msg)) || "ticket 校验失败";
        return { state: SITE_STATE.ERROR, message: `登录失败: ${msg}` };
      }
      if (j && Number(j.riskCode || 0) !== 0) {
        return { state: SITE_STATE.ERROR, message: `风控拦截 riskCode:${j.riskCode} ${(j.url || "").slice(0, 160)}` };
      }
      // PC 扫码流核心登录态 = thor（非 pt_key/pt_pin），缺 thor = 未拿到登录 cookie。
      if (!merged.thor) {
        const msg = j && (j.message || j.msg);
        return { state: SITE_STATE.ERROR, message: `未获得登录 cookie（缺 thor）: ${msg || text.slice(0, 120)}` };
      }

      const pin = decodeSafe(merged.pin || merged.pt_pin || "");
      const user = { username: pin || "jd", nick_name: decodeSafe(merged.unick || pin || "") };
      // 尝试拿昵称（尽力而为，失败不影响登录）
      try {
        const pn = await fetch(PET_NAME, { headers: jdHeaders({ Cookie: cookieString(merged) }) });
        const pnText = await pn.text();
        const m = String(pnText).match(/"nickName"\s*:\s*"([^"]+)"/) || String(pnText).match(/"nickname"\s*:\s*"([^"]+)"/);
        if (m) user.nick_name = m[1];
      } catch {}

      s.cookies = merged;
      return {
        state: SITE_STATE.CONFIRMED,
        cookies: merged,
        headers: this.headers(null, merged),
        user,
      };
    } catch (e) {
      return { state: SITE_STATE.ERROR, message: `登录异常: ${e.message}` };
    }
  },

  // 鉴权请求头：京东用 cookie（pt_key/pt_pin）而非 token。
  // token 参数保留以兼容 core 调用约定；有 token 时从 s 会话取 cookie。
  headers(token, cookies) {
    const ck = cookies || (token && typeof token === "object" && token.cookies) || null;
    const dict = ck || {};
    return jdHeaders({ Cookie: cookieString(dict) });
  },

  // 手动注入 cookie（已有 pt_key/pt_pin 的场景）：
  //   auth_login_manual_token {site:"jd", account?, token:"pt_key=xxx;pt_pin=xxx" 或任意 cookie 串}
  async manualToken(s, opts) {
    const raw = opts?.token;
    if (!raw) throw new Error("需要 token 参数（京东用 cookie 串，如 pt_key=xxx;pt_pin=xxx）");
    const dict = {};
    for (const seg of String(raw).split(";")) {
      const eq = seg.indexOf("=");
      if (eq > 0) dict[seg.slice(0, eq).trim()] = seg.slice(eq + 1).trim();
    }
    const ptPin = dict.pt_pin || "";
    const username = ptPin ? decodeSafe(ptPin) : "jd";
    return {
      cookies: dict,
      user: { username, nick_name: username },
      headers: this.headers(null, dict),
    };
  },

  // 活动执行器：
  //   bean_sign            → signBeanAct 京豆签到（api.m.jd.com，实测接口存活，扫码后确认签名要求）
  //   daily_collect_bean   → scripts/jd/jd_collect_bean.cjs 购物返豆领取（免签名，实测领 68 豆）
  //   daily_comment_bean   → scripts/jd/jd_comment_bean.cjs 评价领京豆（免签名，saveProductComment.action）
  //   query_user           → QueryJDUserInfo 用户信息/京豆余额（验证登录态）
  //   其他 type            → 回退通用请求（def.method/path/body，Cookie 自动带上）
  async executeActivity(s, def) {
    const type = String((def && def.type) || "");
    const cookies = (s && s.cookies) || {};
    if (type === "bean_sign" || type === "sign_bean" || type === "signin") {
      return this.signBean(s);
    }
    if (type === "query_user" || type === "user_info") {
      return this.queryUser(s);
    }
    if (type === "daily_collect_bean" || type === "collect_bean") {
      return this.runScript(s, "jd_collect_bean.cjs");
    }
    if (type === "daily_comment_bean" || type === "comment_bean") {
      return this.runScript(s, "jd_comment_bean.cjs");
    }
    // 通用 fallback
    const url = (def.baseUrl || "https://api.m.jd.com") + (def.path || "");
    const res = await fetch(url, {
      method: def.method || "GET",
      headers: jdHeaders({ Cookie: cookieString(cookies), ...(def.headers || {}) }),
      body: def.body ? (typeof def.body === "string" ? def.body : JSON.stringify(def.body)) : undefined,
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, body: tryJson(text) };
  },

  // 运行已固化的京东任务脚本（node 子进程；清 LD_PRELOAD/LD_LIBRARY_PATH 避免 termux tagfix 干扰）
  async runScript(s, name) {
    const { spawnSync } = await import("node:child_process");
    const script = "/data/data/com.termux/files/home/.config/opencode/projects/opencode-termux/scripts/jd/" + name;
    const username = (s && s.user && s.user.username) || "loon520";
    const env = Object.assign({}, process.env);
    delete env.LD_PRELOAD;
    delete env.LD_LIBRARY_PATH;
    const r = spawnSync("node", [script, "--account", username], { encoding: "utf8", env, timeout: 180000, maxBuffer: 20 * 1024 * 1024 });
    const out = ((r.stdout || "") + (r.stderr || "")).trim();
    return { status: r.status, ok: r.status === 0, message: (out || "(无输出)").slice(-900) };
  },

  // 京豆签到（M 端 signBeanAct）。appid=ld 客户端行为（2026-09-08 无 cookie 实测 402=活动高峰，
  // 接口存活；扫码后如返回签名类错误（含 h5st/h5st 相关字段）则记录并提示走无头浏览器方案）。
  async signBean(s) {
    const cookies = s.cookies || {};
    const uuid = "3acd1f6361f86fc0a1bc23971b2e7bbe6197afb6";
    const body = JSON.stringify({
      fp: "-1",
      shshshfp: "-1",
      shshshfpa: "-1",
      referUrl: "-1",
      userAgent: "-1",
      jda: "-1",
      rnVersion: "3.9",
    });
    const url =
      `https://api.m.jd.com/client.action?functionId=signBeanAct&body=${encodeURIComponent(body)}` +
      `&appid=ld&client=apple&clientVersion=10.0.4&networkType=wifi&osVersion=14.8.1&uuid=${uuid}&open=0&t=${Date.now()}`;
    const res = await fetch(url, {
      headers: jdHeaders({
        Referer: "https://h5.m.jd.com/dev/WmZuRhjBTWs92BgdncikERB9trw/index.html",
        Cookie: cookieString(cookies),
      }),
    });
    const text = await res.text();
    const bodyO = tryJson(text);
    const msg = (bodyO && (bodyO.message || bodyO.msg)) || text.slice(0, 120);
    const hitSign = /sign|h5st/i.test(text) && /signed|已签到/.test(text);
    return { status: res.status, ok: res.ok || hitSign, body: bodyO || text.slice(0, 200), message: msg };
  },

  // 用户信息 / 京豆余额（老脚本通用接口，验证登录态有效 + 拿京豆数）
  async queryUser(s) {
    const cookies = s.cookies || {};
    const res = await fetch(WQ_USER_INFO, {
      headers: jdHeaders({
        Referer: "https://wqs.jd.com/my/jingdou/my.shtml?sceneval=2",
        Cookie: cookieString(cookies),
      }),
    });
    const text = await res.text();
    const j = tryJson(text);
    const ok = j && j.retcode === 0;
    return {
      status: res.status,
      ok: !!ok,
      body: j || text.slice(0, 200),
      message: ok ? `京豆余额: ${(j.base && j.base.beanNum) ?? (j.base && j.base.beanCount) ?? "未知"}` : text.slice(0, 120),
      userInfo: ok ? j.base : null,
    };
  },
};

function decodeSafe(v) {
  try {
    return decodeURIComponent(String(v));
  } catch {
    return String(v);
  }
}

function tryJson(text) {
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}