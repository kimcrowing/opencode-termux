#!/usr/bin/env bash
# Verifies the plugin registry end to end on a built opencode2 binary.
#
# Runs on Linux x64 (native bun target), exercising exactly what an Android
# build would, minus OS portability. The same binary is then used by the
# per-plugin scripts (verify-uyanip.sh / verify-xcpquery.sh / verify-dingtalk.sh)
# which assert the host-composed tool ids for each shipped plugin.
#
# Success criteria (all must hold):
#   1. GET /api/plugin lists every registered plugin with status active;
#      no non-active (warning/failed/...) state may exist.
#   2. opencode.provider.codebuddy is registered as a builtin provider and
#      active (catches patched-source regressions like a patch that ships
#      provider/codebuddy.ts but forgets the ProviderPlugins registration).
#   3. Every shipped plugin (dingtalk / uyanip / xcpquery / auth-login) loads from its
#      src/v2-plugin package, is registered as a local plugin and is active.
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

declare -A PLUGINS
PLUGINS[dingtalk]="$REPO_ROOT/src/v2-plugin/dingtalk"
PLUGINS[uyanip]="$REPO_ROOT/src/v2-plugin/uyanip"
PLUGINS[xcpquery]="$REPO_ROOT/src/v2-plugin/xcpquery"
PLUGINS[auth-login]="$REPO_ROOT/src/v2-plugin/auth-login"
for id in "${!PLUGINS[@]}"; do
  if [[ ! -f "${PLUGINS[$id]}/server.ts" ]]; then
    echo "::error::missing v2 plugin source: ${PLUGINS[$id]}/server.ts"
    exit 1
  fi
done

WORK="$(mktemp -d)"
PORT="${V2_PORT:-41843}"
PASSWORD="${V2_PASSWORD:-opencode-verify-password}"

export OPENCODE_CONFIG_DIR="$WORK/config"
export OPENCODE_TEST_HOME="$WORK/home"
mkdir -p "$OPENCODE_CONFIG_DIR" "$OPENCODE_TEST_HOME" "$WORK/project"

# Project opencode.json declaring every shipped plugin so this one server loads
# and activates the full set at once.
{
  echo "{"
  echo '  "plugins": ['
  first=1
  for id in "${!PLUGINS[@]}"; do
    if [[ "$first" -ne 1 ]]; then
      echo ","
    fi
    printf '    { "package": "%s" }' "${PLUGINS[$id]}"
    first=0
  done
  echo ""
  echo "  ]"
  echo "}"
} > "$WORK/project/opencode.json"

echo "== binary =="
"$BIN" --version 2>&1 | head -3 || true
file "$BIN"

echo "== shipped v2 plugins under test =="
for id in "${!PLUGINS[@]}"; do
  echo "-- $id --"
  ls -la "${PLUGINS[$id]}"
done

echo "== project opencode.json =="
cat "$WORK/project/opencode.json"

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

# Plugin activation (setup + transform) runs asynchronously after readiness.
sleep 2

echo "== /api/config =="
curl -sf -u "opencode:${PASSWORD}" "http://127.0.0.1:${PORT}/api/config" || true

echo "== /api/plugin =="
PLUGIN_JSON="$(curl -sf -u "opencode:${PASSWORD}" "http://127.0.0.1:${PORT}/api/plugin" || true)"
echo "$PLUGIN_JSON"

echo "== /api/tool (resolved tool ids) =="
curl -sf -u "opencode:${PASSWORD}" "http://127.0.0.1:${PORT}/api/tool" || true

echo "== server.log (first 60 lines) =="
head -60 "$WORK/server.log"

FAILURES=0

if [[ -z "$PLUGIN_JSON" ]]; then
  echo "::error::/api/plugin returned nothing"
  FAILURES=1
else
  # 1. No plugin may be in a non-active state.
  NON_ACTIVE="$(echo "$PLUGIN_JSON" | grep -o '"state":{"status":"[a-z]*"' | grep -v '"status":"active"' || true)"
  if [[ -n "$NON_ACTIVE" ]]; then
    echo "::error::non-active plugin state(s) found: $NON_ACTIVE"
    FAILURES=1
  fi

  # 2. Provider gate: codebuddy registered builtin + active.
  if ! echo "$PLUGIN_JSON" | grep -q '"id":"opencode.provider.codebuddy","source":{"type":"builtin"}'; then
    echo "::error::opencode.provider.codebuddy is not registered as a builtin provider"
    echo "::error::$PLUGIN_JSON"
    FAILURES=1
  elif ! echo "$PLUGIN_JSON" | grep -o '"id":"opencode.provider.codebuddy".\{0,200\}' | grep -q '"status":"active"'; then
    echo "::error::opencode.provider.codebuddy is registered but not active"
    echo "::error::$(echo "$PLUGIN_JSON" | grep -o '"id":"opencode.provider.codebuddy".\{0,200\}')"
    FAILURES=1
  fi

  # 3. Every shipped plugin: registered local + active.
  for id in "${!PLUGINS[@]}"; do
    if ! echo "$PLUGIN_JSON" | grep -q "\"id\":\"$id\",\"source\":{\"type\":\"local\""; then
      echo "::error::shipped plugin $id is not registered as a local plugin"
      echo "::error::$PLUGIN_JSON"
      FAILURES=1
    elif ! echo "$PLUGIN_JSON" | grep -o "\"id\":\"$id\".\{0,200\}" | grep -q '"status":"active"'; then
      echo "::error::shipped plugin $id is registered but not active"
      echo "::error::$(echo "$PLUGIN_JSON" | grep -o "\"id\":\"$id\".\{0,200\}")"
      FAILURES=1
    fi
  done
fi

if [[ "$FAILURES" -ne 0 ]]; then
  echo "::error::plugin verification FAILED"
  exit 1
fi
echo "::notice::plugin verification PASSED (codebuddy + dingtalk + uyanip + xcpquery + auth-login active, no non-active plugins)"