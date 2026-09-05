#!/usr/bin/env bash
# Verifies that the migrated xcpquery v2 plugin (src/v2-plugin/xcpquery/server.ts)
# loads and registers its tools end to end on a real built opencode2 binary.
#
# Context: xcpquery is the second v1->v2 plugin migration. Unlike uyanip it ships
# a vendored browser/WAF runtime (cjs/) used for CNIPA access; the plugin still
# registers tools through setup(ctx) -> ctx.tool.transform(editor.add(...)), each
# carrying `options: { namespace: "xcpquery" }`, and the host composes the final
# tool ids as `namespace_name`.
#
# No network or CNIPA credentials are involved in this check: the plugin defers
# login to first use. Success criteria (all must hold):
#   1. GET /api/plugin lists the xcpquery plugin, and no plugin reports failed;
#      a failed state means setup()/transform threw (e.g. an invalid namespace
#      option, a broken tool schema, or a bad import in core.mjs), which must
#      fail the run.
#   2. The plugin wrote XCPQUERY_VERIFY_SENTINEL containing the host-composed
#      tool ids from editor.list(); every expected `xcpquery_<name>` id must be
#      present, proving namespace composition over 7 tools.
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
PLUGIN_DIR="$REPO_ROOT/src/v2-plugin/xcpquery"
WORK="$(mktemp -d)"
PORT="${V2_XCPQUERY_PORT:-41845}"
PASSWORD="${V2_PASSWORD:-opencode-verify-password}"

if [[ ! -f "$PLUGIN_DIR/server.ts" ]]; then
  echo "::error::xcpquery v2 plugin missing: $PLUGIN_DIR/server.ts"
  exit 1
fi
if [[ ! -f "$PLUGIN_DIR/core.mjs" ]]; then
  echo "::error::xcpquery protocol core missing: $PLUGIN_DIR/core.mjs"
  exit 1
fi

export OPENCODE_CONFIG_DIR="$WORK/config"
export OPENCODE_TEST_HOME="$WORK/home"
export XCPQUERY_VERIFY_SENTINEL="$WORK/xcpquery-sentinel.json"
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
  if [[ -f "$WORK/xcpquery-sentinel.json" ]]; then break; fi
  sleep 1
done

echo "== /api/plugin =="
PLUGIN_JSON="$(curl -sf -u "opencode:${PASSWORD}" "http://127.0.0.1:${PORT}/api/plugin" || true)"
echo "$PLUGIN_JSON"

echo "== xcpquery sentinel (composed tool ids) =="
if [[ -f "$WORK/xcpquery-sentinel.json" ]]; then
  cat "$WORK/xcpquery-sentinel.json"
else
  echo "(missing)"
fi

echo "== server.log (first 60 lines) =="
head -60 "$WORK/server.log"

FAILURES=0

EXPECTED_IDS="xcpquery_search_patent xcpquery_get_case_summary xcpquery_list_documents xcpquery_download_document xcpquery_get_section_text xcpquery_get_examination_tree xcpquery_get_scjd_tree"
if [[ ! -f "$WORK/xcpquery-sentinel.json" ]]; then
  echo "::error::xcpquery sentinel missing (plugin never registered tools)"
  echo "::error::full expected ids: $EXPECTED_IDS"
  FAILURES=1
else
  MISSING=""
  for id in $EXPECTED_IDS; do
    if ! grep -q "\"$id\"" "$WORK/xcpquery-sentinel.json"; then
      MISSING="$MISSING $id"
    fi
  done
  if [[ -n "$MISSING" ]]; then
    echo "::error::xcpquery tool ids not composed as expected, missing:$MISSING"
    FAILURES=1
  fi
fi

if [[ -z "$PLUGIN_JSON" ]]; then
  echo "::error::/api/plugin returned nothing for xcpquery"
  FAILURES=1
elif ! echo "$PLUGIN_JSON" | grep -q '"id":"xcpquery"'; then
  echo "::error::/api/plugin does not list the xcpquery plugin"
  echo "::error::$PLUGIN_JSON"
  FAILURES=1
elif echo "$PLUGIN_JSON" | grep -q '"status":"failed"'; then
  echo "::error::/api/plugin reports the xcpquery plugin as failed"
  echo "::error::$PLUGIN_JSON"
  FAILURES=1
fi

if [[ "$FAILURES" -ne 0 ]]; then
  echo "::error::xcpquery v2 migration verification FAILED"
  exit 1
fi

echo "::notice::xcpquery v2 migration verification PASSED (plugin active, all xcpquery_* tool ids composed)"
