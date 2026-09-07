#!/usr/bin/env bash
# Verifies that the auth-login v2 plugin (src/v2-plugin/auth-login/server.ts)
# loads and registers its tools end to end on a real built opencode2 binary.
#
# auth-login is a generic QR scan-login framework: QR generate -> render PNG+ASCII
# -> background poll -> token persist -> configurable activity runner. Tools
# register through setup(ctx) -> ctx.tool.transform(editor.add(...)) with
# `options: { namespace: "auth_login" }`, so the host composes `auth_login_<name>`
# ids.
#
# No credentials are involved: the plugin only needs a valid config with a site.
# Success criteria:
#   1. GET /api/plugin lists the auth-login plugin, and no plugin reports failed.
#   2. The plugin wrote AUTH_LOGIN_VERIFY_SENTINEL containing the host-composed
#      tool ids from editor.list(); every expected `auth_login_<name>` id must be
#      present, proving namespace composition over all 11 tools.
#
# The binary under test is expected at $1 and must be executable.
set -euo pipefail

BIN="$1"
if [[ ! -x "$BIN" ]]; then
  echo "::error::binary not found or not executable: $BIN"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/src/v2-plugin/auth-login"
WORK="$(mktemp -d)"
PORT="${V2_AUTH_LOGIN_PORT:-41847}"
PASSWORD="${V2_PASSWORD:-opencode-verify-password}"

if [[ ! -f "$PLUGIN_DIR/server.ts" ]]; then
  echo "::error::auth-login v2 plugin missing: $PLUGIN_DIR/server.ts"
  exit 1
fi
for f in core.mjs provider-qr.mjs qr.js png.js providers/gitcode.mjs; do
  if [[ ! -f "$PLUGIN_DIR/$f" ]]; then
    echo "::error::auth-login required module missing: $PLUGIN_DIR/$f"
    exit 1
  fi
done

export OPENCODE_CONFIG_DIR="$WORK/config"
export OPENCODE_TEST_HOME="$WORK/home"
export AUTH_LOGIN_VERIFY_SENTINEL="$WORK/auth-login-sentinel.json"
mkdir -p "$OPENCODE_CONFIG_DIR" "$OPENCODE_TEST_HOME" "$WORK/project"

cat > "$WORK/project/opencode.json" <<JSON
{
  "plugins": [
    {
      "package": "$PLUGIN_DIR",
      "options": {
        "sites": {
          "gitcode": {
            "name": "GitCode",
            "activities": [
              { "name": "每日签到", "path": "/checkin", "method": "POST" }
            ]
          },
          "mock": {
            "name": "Mock"
          }
        }
      }
    }
  ]
}
JSON

echo "== binary =="
"$BIN" --version 2>&1 | head -3 || true

echo "== plugin under test =="
ls -la "$PLUGIN_DIR"

echo "== starting server (port $PORT) =="
cd "$WORK/project"
env -u OPENCODE_PASSWORD \
  LD_PRELOAD= \
  OPENCODE_SERVER_PASSWORD="$PASSWORD" \
  BUN_FEATURE_FLAG_DISABLE_EPOLL_PWAIT2=1 \
  "$BIN" serve --hostname 127.0.0.1 --port "$PORT" >"$WORK/server.log" 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

READY=""
for _ in $(seq 1 60); do
  if curl -sf -u "opencode:${PASSWORD}" "http://127.0.0.1:${PORT}/api/config" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done
if [[ -z "$READY" ]]; then
  echo "::error::server did not become ready in 60s"
  echo "== server.log =="
  cat "$WORK/server.log"
  exit 1
fi
echo "server ready"

# Wait for plugin activation (setup + transform run asynchronously).
for _ in $(seq 1 30); do
  if [[ -f "$WORK/auth-login-sentinel.json" ]]; then break; fi
  sleep 1
done

echo "== /api/plugin =="
PLUGIN_JSON="$(curl -sf -u "opencode:${PASSWORD}" "http://127.0.0.1:${PORT}/api/plugin" || true)"
echo "$PLUGIN_JSON"

echo "== auth-login sentinel (composed tool ids) =="
if [[ -f "$WORK/auth-login-sentinel.json" ]]; then
  cat "$WORK/auth-login-sentinel.json"
else
  echo "(missing)"
fi

echo "== server.log (first 80 lines) =="
head -80 "$WORK/server.log"

FAILURES=0

EXPECTED_IDS="auth_login_sites auth_login_login auth_login_accounts auth_login_status auth_login_token auth_login_refresh auth_login_logout auth_login_run_activities auth_login_manual_token auth_login_render_qr auth_login_qr_image_path"
if [[ ! -f "$WORK/auth-login-sentinel.json" ]]; then
  echo "::error::auth-login sentinel missing (plugin never registered tools)"
  echo "::error::full expected ids: $EXPECTED_IDS"
  FAILURES=1
else
  MISSING=""
  for id in $EXPECTED_IDS; do
    if ! grep -q "\"$id\"" "$WORK/auth-login-sentinel.json"; then
      MISSING="$MISSING $id"
    fi
  done
  if [[ -n "$MISSING" ]]; then
    echo "::error::auth-login tool ids not composed as expected, missing:$MISSING"
    FAILURES=1
  fi
fi

if [[ -z "$PLUGIN_JSON" ]]; then
  echo "::error::/api/plugin returned nothing for auth-login"
  FAILURES=1
elif ! echo "$PLUGIN_JSON" | grep -q '"id":"auth-login"'; then
  echo "::error::/api/plugin does not list the auth-login plugin"
  echo "::error::$PLUGIN_JSON"
  FAILURES=1
elif echo "$PLUGIN_JSON" | grep -q '"status":"failed"'; then
  echo "::error::/api/plugin reports the auth-login plugin as failed"
  echo "::error::$PLUGIN_JSON"
  FAILURES=1
fi

if [[ "$FAILURES" -ne 0 ]]; then
  echo "::error::auth-login v2 plugin verification FAILED"
  exit 1
fi

echo "::notice::auth-login v2 plugin verification PASSED (plugin active, all auth_login_* tool ids composed)"