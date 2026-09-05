#!/usr/bin/env bash
# Verifies that the migrated uyanip v2 plugin (src/v2-plugin/uyanip/server.ts)
# loads and registers its tools end to end on a real built opencode2 binary.
#
# Context: uyanip is the first v1->v2 plugin migration. Its v2 plugin registers
# tools via setup(ctx) -> ctx.tool.transform(editor.add(...)), with each tool
# carrying `options: { namespace: "uyanip" }`. The host composes the final tool
# id as `namespace_name` (see effectiveName in packages/core/src/tool/runtime.ts).
#
# Success criteria (all must hold):
#   1. GET /api/plugin lists the uyanip plugin with status active (not failed);
#      a failed state means setup()/transform threw (e.g. an invalid namespace
#      option or a broken tool schema), which must fail the run.
#   2. The plugin wrote UYANIP_VERIFY_SENTINEL (only set when running under this
#      script) containing the host-composed tool ids from editor.list(); every
#      expected `uyanip_<name>` id must be present, proving namespace composition.
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
PLUGIN_DIR="$REPO_ROOT/src/v2-plugin/uyanip"
WORK="$(mktemp -d)"
PORT="${V2_UYANIP_PORT:-41844}"
PASSWORD="${V2_PASSWORD:-opencode-verify-password}"

if [[ ! -f "$PLUGIN_DIR/server.ts" ]]; then
  echo "::error::uyanip v2 plugin missing: $PLUGIN_DIR/server.ts"
  exit 1
fi

export OPENCODE_CONFIG_DIR="$WORK/config"
export OPENCODE_TEST_HOME="$WORK/home"
export UYANIP_VERIFY_SENTINEL="$WORK/uyanip-sentinel.json"
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
  if [[ -f "$WORK/uyanip-sentinel.json" ]]; then break; fi
  sleep 1
done

echo "== /api/config =="
curl -sf -u "opencode:${PASSWORD}" "http://127.0.0.1:${PORT}/api/config" || true

echo "== /api/plugin =="
PLUGIN_JSON="$(curl -sf -u "opencode:${PASSWORD}" "http://127.0.0.1:${PORT}/api/plugin" || true)"
echo "$PLUGIN_JSON"

echo "== uyanip sentinel (composed tool ids) =="
if [[ -f "$WORK/uyanip-sentinel.json" ]]; then
  cat "$WORK/uyanip-sentinel.json"
else
  echo "(missing)"
fi

echo "== server.log (first 60 lines) =="
head -60 "$WORK/server.log"

FAILURES=0

EXPECTED_IDS="uyanip_login uyanip_fetch_bibliographic uyanip_fetch_claims uyanip_fetch_description uyanip_fetch_drawings uyanip_fetch_patent_content uyanip_batch_fetch_patents uyanip_fetch_patent_pdf uyanip_search_patents"
if ! grep -q '"uyanip_login"' "$WORK/uyanip-sentinel.json"; then
  echo "::error::uyanip sentinel missing (plugin never registered tools)"
  echo "::error::full expected ids: $EXPECTED_IDS"
  FAILURES=1
else
  MISSING=""
  for id in $EXPECTED_IDS; do
    if ! grep -q "\"$id\"" "$WORK/uyanip-sentinel.json"; then
      MISSING="$MISSING $id"
    fi
  done
  if [[ -n "$MISSING" ]]; then
    echo "::error::uyanip tool ids not composed as expected, missing:$MISSING"
    FAILURES=1
  fi
fi

if [[ -z "$PLUGIN_JSON" ]]; then
  echo "::error::/api/plugin returned nothing for uyanip"
  FAILURES=1
elif ! echo "$PLUGIN_JSON" | grep -q '"id":"uyanip"'; then
  echo "::error::/api/plugin does not list the uyanip plugin"
  echo "::error::$PLUGIN_JSON"
  FAILURES=1
elif echo "$PLUGIN_JSON" | grep -q '"status":"failed"'; then
  echo "::error::/api/plugin reports the uyanip plugin as failed"
  echo "::error::$PLUGIN_JSON"
  FAILURES=1
fi

if [[ "$FAILURES" -ne 0 ]]; then
  echo "::error::uyanip v2 migration verification FAILED"
  exit 1
fi
echo "::notice::uyanip v2 migration verification PASSED (plugin active, all uyanip_* tool ids composed)"