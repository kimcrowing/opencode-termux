// providers/mock.mjs — 本地模拟 provider，用于插件端到端自测（不需要任何真实站点）。
//
// 模拟"扫码登录"全流程（账号池语义）：
//   1. generateQr() 分配用户名并返回测试文本作为二维码内容：
//      - add 模式（临时槽 `_new_*`）→ 分配 `user-<n>`（每次扫码一个新用户，入池）
//      - update 模式（指定已有账户）→ 沿用该账户名（重新扫码续期，不新增）
//   2. 第一次 pollStatus 返回 pending，第二次返回 confirmed 并给一个假 token
//      （user/account 级计数，多账户并发轮询互不干扰）。
//   3. executeActivity() 把活动定义回显成一条"结果"，验证活动执行器。
//
// 上生产后无需此 provider；它只在 auth_login_sites 里配置一个 site 用来自测。

import { SITE_STATE } from "../core.mjs";

export default {
  id: "mock",
  name: "Mock",
  pollIntervalMs: 1000,
  _mockSeq: 0,

  async generateQr(s) {
    // add 模式（临时槽）→ 分配新用户名；update 模式（指定账户）→ 沿用账户名
    s._mockName = String(s._accountId || "").startsWith("_new_")
      ? `user-${++this._mockSeq}`
      : String(s._accountId || "default");
    return "https://example.mock/login/session=mock123";
  },

  async pollStatus(s) {
    s._mockPoll = (s._mockPoll || 0) + 1;
    if (s._mockPoll < 2) return { state: SITE_STATE.WAITING };
    return {
      state: SITE_STATE.CONFIRMED,
      token: `mock-token-${Date.now()}`,
      user: { username: s._mockName || "mock-user" },
    };
  },

  headers(token) {
    return token ? { Authorization: `Bearer ${token}` } : {};
  },

  // 模拟 token 刷新（GitCode 每日续期 24h 的行为）：换新 token 并计数，供测试断言
  async refresh(s) {
    s.mockRefreshCount = (s.mockRefreshCount || 0) + 1;
    return {
      ok: true,
      token: `mock-token-${Date.now()}`,
      cookies: { access_token: `mock-token-${Date.now()}` },
      headers: this.headers(`mock-token-${Date.now()}`),
      user: s.user,
    };
  },

  async executeActivity(s, def) {
    // 模拟：回显活动
    return { simulated: true, activity: def.name, withToken: !!s.token, account: s.user?.username || s._accountId };
  },
};