// credential-sync.mjs — auth-login ↔ opencode credential 表（opencode.db）双向同步。
//
// 【方案 A 落地点】让 opencode 内置的 codebuddy provider（模型/补丁 checkin）吃到与
// auth-login 同一份 token：auth-login 登录/刷新成功后把 {access, refresh} 写进 opencode
// 的 credential 表（integration_id="codebuddy"，methodID="ioa"），模型侧 integration
// connection.active() 每次现查 db（上游源码实证无缓存）→ 立即生效，无需重启。
//
// 数据库：~/.local/share/opencode/opencode.db 与 opencode-.db（本机 serve 实测用
// opencode-.db；--service 的另个 serve 用 opencode.db）——两个都写入，保证命中活跃库。
// 表结构（上游 schema + 本机 PRAGMA 实证，2026-09-07）：
//   credential(id TEXT PK, integration_id TEXT, label TEXT NOT NULL, value TEXT NOT NULL,
//              connector_id, method_id, active INTEGER, time_created INTEGER, time_updated INTEGER)
//   OAuth value = {"type":"oauth","methodID":"ioa","refresh","access","expires"(ms),"metadata":{"uid"}}
//   id = "cred_" + 时间戳编码(26字符)（与上游 ascending() 同构：6 字节 HEX 时间前缀 + 14 随机字符）
//
// SQLite 访问：优先 node:sqlite（Bun ≥1.2 内置 shim），其次 bun:sqlite（Bun 原生）；
// 都不可用则降级为「仅 storage」并打印警告（不阻断登录/活动主流程）。

let _driver = null; // "node" | "bun" | null
let _warned = false;
let _fs = null;

async function getFs() {
  if (_fs) return _fs;
  try {
    const fs = await import("node:fs");
    _fs = fs.default || fs;
  } catch {
    _fs = { existsSync: () => false };
  }
  return _fs;
}

async function dbPaths() {
  const fs = await getFs();
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const dir = `${home}/.local/share/opencode`;
  const files = [`${dir}/opencode.db`, `${dir}/opencode-.db`].filter((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  return files;
}

async function loadDriver() {
  if (_driver) return _driver;
  try {
    await import("node:sqlite");
    _driver = "node";
  } catch {
    try {
      await import("bun:sqlite");
      _driver = "bun";
    } catch {
      _driver = null;
    }
  }
  return _driver;
}

/** 打开一个 sqlite 库（driver 自适应），返回统一句柄 { run, all, exec, close } 或 null。 */
async function openDb(file) {
  const driver = await loadDriver();
  if (!driver) return null;
  try {
    if (driver === "node") {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(file);
      return {
        run: (sql, params = []) => db.prepare(sql).run(...params),
        all: (sql, params = []) => db.prepare(sql).all(...params),
        exec: (sql) => db.exec(sql),
        close: () => db.close(),
      };
    }
    // bun:sqlite
    const { Database } = await import("bun:sqlite");
    const db = new Database(file);
    return {
      run: (sql, params = []) => db.prepare(sql).run(...params),
      all: (sql, params = []) => db.prepare(sql).all(...params),
      exec: (sql) => db.exec(sql),
      close: () => db.close(),
    };
  } catch {
    return null;
  }
}

function warn(msg) {
  if (!_warned) {
    _warned = true;
    console.error(`[auth-login][credential-sync] ${msg}`);
  }
}

/** 生成与上游 Credential.ID 同构的 id：时间戳编码 + 随机串（无需与 db 协调）。 */
function credentialId() {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const t = BigInt(Date.now()) * 0x1000n + 1n;
  const time = Array.from({ length: 6 }, (_, i) =>
    Number((t >> BigInt(40 - 8 * i)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  ).join("");
  let rand = "";
  for (let i = 0; i < 14; i++) rand += chars[Math.floor(Math.random() * 62)];
  return `cred_${time}${rand}`;
}

/**
 * 把 auth-login 某账户的 token 写入 opencode credential 表。
 * @param {object} opts { integrationId, label, access, refresh, expires(ms), uid, makeActive? }
 *   makeActive=true（默认）：同 integration 旧记录全部置 inactive，本行 active=1（登录/手动注入场景）。
 *   makeActive=false：只更新本行 token（值），active 位保持原状（refresh 场景 → 不把 opencode
 *   的 active 账号在每日轮询里拨来拨去；若本行本来就是 active 则继续 active）。
 * @returns {Promise<{ok:boolean, dbs:number, error?:string}>}
 */
export async function syncToOpencodeCredential(opts = {}) {
  const integrationId = String(opts.integrationId || "codebuddy");
  const label = String(opts.label || "default");
  const access = String(opts.access || "");
  const refresh = String(opts.refresh || "");
  if (!access) return { ok: false, dbs: 0, error: "缺少 access token" };
  const expires = Number(opts.expires || Date.now() + 24 * 60 * 60 * 1000);
  const uid = String(opts.uid || "");
  const makeActive = opts.makeActive !== false;
  const value = JSON.stringify({
    type: "oauth",
    methodID: "ioa",
    refresh,
    access,
    expires,
    metadata: uid ? { uid } : {},
  });

  const files = await dbPaths();
  let touched = 0;
  for (const file of files) {
    const db = await openDb(file);
    if (!db) {
      warn(`无法打开 sqlite（${file}），credential 同步跳过（不影响登录/活动）`);
      continue;
    }
    try {
      const now = Date.now();
      db.exec("BEGIN");
      try {
        if (makeActive) {
          // 同 integration 全部置非 active
          db.run("UPDATE credential SET active = 0 WHERE integration_id = ?", [integrationId]);
        }
        const exist = db.all("SELECT id, active FROM credential WHERE integration_id = ? AND label = ?", [
          integrationId,
          label,
        ]);
        if (exist && exist.length) {
          const curActive = makeActive ? 1 : Number(exist[0].active);
          db.run("UPDATE credential SET value = ?, active = ?, time_updated = ? WHERE id = ?", [
            value,
            curActive,
            now,
            exist[0].id,
          ]);
        } else {
          const id = credentialId();
          db.run(
            "INSERT INTO credential (id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)",
            [id, integrationId, label, value, makeActive ? 1 : 0, now, now]
          );
        }
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        warn(`写入 credential 失败（${file}）: ${e.message}`);
        db.close();
        continue;
      }
      db.exec("COMMIT");
      db.close();
      touched++;
    } catch (e) {
      warn(`同步失败（${file}）: ${e.message}`);
      try {
        db.close();
      } catch {}
    }
  }
  return { ok: touched > 0, dbs: touched };
}

/**
 * 从 opencode credential 表读取某 integration 的凭据列表（供导入账号池）。
 * @param {string} integrationId e.g. "codebuddy"
 * @returns {Promise<Array<{label, access, refresh, expires, uid, active, file}>>}
 */
export async function listOpencodeCredentials(integrationId = "codebuddy") {
  const out = [];
  for (const file of await dbPaths()) {
    const db = await openDb(file);
    if (!db) continue;
    try {
      const rows = db.all("SELECT id, label, value, active FROM credential WHERE integration_id = ?", [integrationId]);
      for (const r of rows || []) {
        let v = null;
        try {
          v = JSON.parse(r.value);
        } catch {}
        if (!v || v.type !== "oauth") continue;
        out.push({
          label: r.label,
          access: v.access || "",
          refresh: v.refresh || "",
          expires: Number(v.expires || 0),
          uid: (v.metadata && v.metadata.uid) || "",
          active: !!r.active,
          file,
        });
      }
    } catch {}
    db.close();
  }
  // 去重：同 label 保留 active 优先；同 active 状态保留 expires 较新者
  const byLabel = new Map();
  for (const c of out) {
    const prev = byLabel.get(c.label);
    if (!prev || (c.active && !prev.active) || (c.active === prev.active && c.expires >= prev.expires)) {
      byLabel.set(c.label, c);
    }
  }
  return [...byLabel.values()].sort((a, b) => Number(b.active) - Number(a.active));
}