// providers/mock.mjs — 本地模拟 provider，用于插件端到端自测（不需要任何真实站点）。
//
// 模拟"扫码登录"全流程：
//   1. loginUrl() 返回一个测试字符串作为二维码内容。
//   2. 第一次 pollStatus 返回 pending，第二次（约几秒后）返回 confirmed 并给一个
//      假 token，验证轮询→确认→持久化链路。
//   3. executeActivity() 把活动定义回显成一条"结果"，验证活动执行器。
//
// 上生产后无需此 provider；它只在 auth_login_sites 里配置一个 site 用来自测。

import { SITE_STATE } from "../core.mjs";

export default {
  id: "mock",
  name: "Mock",
  pollIntervalMs: 1000,
  _pollCount: 0,

  async loginUrl() {
    return "https://example.mock/login/session=mock123";
  },

  async pollStatus(s) {
    this._pollCount = (this._pollCount || 0) + 1;
    if (this._pollCount < 2) return { state: SITE_STATE.WAITING };
    return {
      state: SITE_STATE.CONFIRMED,
      token: "mock-token-abc123",
      user: { username: "mock-user" },
    };
  },

  headers(token) {
    return token ? { Authorization: `Bearer ${token}` } : {};
  },

  async executeActivity(s, def) {
    // 模拟：回显活动
    return { simulated: true, activity: def.name, withToken: !!s.token };
  },
};
