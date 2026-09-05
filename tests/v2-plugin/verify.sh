#!/usr/bin/env bash
# Verifies that a built opencode2 binary loads and activates a real v2 plugin.
#
# Context: v1 plugins live in ~/.config/opencode/plugins and only speak the v1
# (`server: (input, options) => Hooks`) API. Before migrating them to v2, we must
# prove the v2 plugin machinery (ConfigPluginSource discovery/declaration,
# Host.server entrypoint resolution, setup(), ctx.tool.transform) actually works
# end to end on a real binary. This job runs on Linux x64 (native bun target), so
# it exercises exactly what an Android build would, minus the OS portability.
#
# Success criteria (all must hold):
#   1. The hello-v2 plugin's setup() wrote the sentinel file.
#   2. The sentinel.tool marker exists (tool.transform resolved and add() ran).
#   3. GET /api/plugin (auxiliary) lists hello-v2; a failed state fails the run.
#      A missing /api/plugin entry is only a warning when the sentinels prove
#      activation, because its data shape may differ across preview builds.
#
# The binary under test is expected at $1 and must be executable.
set -euo pipefail

BIN="$1"
if [[ ! -x "$BIN" ]]; then
  echo "::error::binary not found or not executable: $BIN"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$SCRIPT_DIR/hello"
WORK="$(mktemp -d)"
PORT="${V2_PORT:-41843}"
PASSWORD="${V2_PASSWORD:-opencode-verify-password}"

# Scoped home so the server never touches the runner's real config. OPENCODE_HOME
# is read by the launcher; here we instead set OPENCODE_CONFIG_DIR (the actual
# v2 knob) to an empty directory plus a project-level opencode.json that declares
# the plugin. Global data/cache/state go under $WORK/home to stay hermetic.
export OPENCODE_CONFIG_DIR="$WORK/config"
export OPENCODE_TEST_HOME="$WORK/home"
export V2_PLUGIN_SENTINEL="$WORK/sentinel"
mkdir -p "$OPENCODE_CONFIG_DIR" "$OPENCODE_TEST_HOME" "$WORK/project"

cat > "$WORK/project/opencode.json" <<JSON
{
  "plugins": [
    { "package": "$PLUGIN_DIR" }
  ]
}
JSON

echo "== binary =="
"$BIN" --version 2>&1 | head -3 || true
file "$BIN"

echo "== plugin under test =="
ls -la "$PLUGIN_DIR"
echo "server.ts:"
cat "$PLUGIN_DIR/server.ts"

echo "== starting server (port $PORT) =="
cd "$WORK/project"
env LD_PRELOAD= BUN_FEATURE_FLAG_DISABLE_EPOLL_PWAIT2=1 \
  "$BIN" serve --hostname 127.0.0.1 --port "$PORT" >"$WORK/server.log" 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Poll for readiness up to ~60s.
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

# Wait for plugin activation (setup writes the sentinel asynchronously).
SETUP=""
for _ in $(seq 1 30); do
  if [[ -f "$WORK/sentinel" ]]; then SETUP=1; break; fi
  sleep 1
done

echo "== /api/config =="
curl -sf -u "opencode:${PASSWORD}" "http://127.0.0.1:${PORT}/api/config" || true

echo "== /api/plugin =="
curl -sf -u "opencode:${PASSWORD}" "http://127.0.0.1:${PORT}/api/plugin" || true

echo "== sentinels =="
ls -la "$WORK" | grep sentinel || true
[[ -f "$WORK/sentinel" ]] && echo "sentinel: $(cat "$WORK/sentinel")"
[[ -f "$WORK/sentinel.tool" ]] && echo "sentinel.tool: $(cat "$WORK/sentinel.tool")"

echo "== server.log (first 60 lines) =="
head -60 "$WORK/server.log"

# Verdict.
# Primary evidence is the sentinel files: setup() ran and tool.transform
# resolved/add() executed. /api/plugin is auxiliary (its data shape may vary
# across preview builds), so a missing /api/plugin entry is logged but does not
# fail the run when the sentinels already prove activation.
FAILURES=0
if [[ -z "$SETUP" ]]; then
  echo "::error::plugin setup never ran (no sentinel file)"
  FAILURES=1
fi
if [[ ! -f "$WORK/sentinel.tool" ]]; then
  echo "::error::tool.transform did not resolve/add (no sentinel.tool)"
  FAILURES=1
fi
PLUGIN_JSON="$(curl -sf -u "opencode:${PASSWORD}" "http://127.0.0.1:${PORT}/api/plugin" || true)"
if [[ -z "$PLUGIN_JSON" ]]; then
  echo "::warning::/api/plugin returned nothing (auxiliary check)"
elif ! echo "$PLUGIN_JSON" | grep -q '"id":"hello-v2"'; then
  echo "::warning::/api/plugin does not list hello-v2 (auxiliary check)"
  echo "::warning::$PLUGIN_JSON"
elif echo "$PLUGIN_JSON" | grep -q '"status":"failed"'; then
  echo "::error::/api/plugin reports a failed plugin state"
  echo "::error::$PLUGIN_JSON"
  FAILURES=1
fi

if [[ "$FAILURES" -ne 0 ]]; then
  echo "::error::v2 plugin verification FAILED"
  exit 1
fi
echo "::notice::v2 plugin verification PASSED (hello-v2 active, tool registered)"