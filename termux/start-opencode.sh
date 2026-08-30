#!/bin/bash
# Start opencode serve on Termux (headless server for the web UI / API).
#
# Environment variables set here matter:
#   OPENCODE_SERVER_PASSWORD
#       HTTP basic-auth password for the server (username defaults to
#       "opencode").  NOTE: on guysoft 1.17.9 builds this is logged as
#       "not set" and basic auth does not actually engage - see docs.
#   BUN_FEATURE_FLAG_DISABLE_EPOLL_PWAIT2=1
#       Escape hatch added in Bun 1.4.0 (oven-sh/bun#32490) that keeps the
#       event loop off epoll_pwait2 (syscall 441), which Android's seccomp
#       policy blocks.  Harmless on older Bun builds that ignore it.
#
# Prerequisite: apply patches/android10-seccomp/ first.  Without the shim the
# server dies with SIGSYS within ~30-120s on Android 10.
#
set -euo pipefail

export OPENCODE_SERVER_PASSWORD="${OPENCODE_SERVER_PASSWORD:-www}"
export BUN_FEATURE_FLAG_DISABLE_EPOLL_PWAIT2=1

cd "${OPENCODE_HOME:-$HOME}"

exec opencode serve \
  --hostname "${OPENCODE_HOST:-0.0.0.0}" \
  --port "${OPENCODE_PORT:-4096}"
