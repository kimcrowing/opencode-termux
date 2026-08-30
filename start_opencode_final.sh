#!/bin/bash
# Start opencode serve with proper environment on Android.
# This script restores process.env from /proc/self/environ before launching opencode,
# which is necessary because Bun on Android does not automatically populate
# process.env from the Linux environment.

set -euo pipefail

export OPENCODE_SERVER_PASSWORD="${OPENCODE_SERVER_PASSWORD:-www}"
export BUN_FEATURE_FLAG_DISABLE_EPOLL_PWAIT2=1

cd /data/data/com.termux/files/home

# Restore process.env from /proc/self/environ before launching opencode.
# On Android, Bun does not automatically populate process.env from the Linux
# environment, so we must manually load variables from /proc/self/environ.
# This must run in the same shell that will exec opencode, so the exports
# are inherited by the opencode process.
node -e "
const fs = require('fs');
const data = fs.readFileSync('/proc/self/environ', 'utf8');
const entries = new TextDecoder().decode(new Uint8Array(Buffer.from(data))).split('\0');
for (const entry of entries) {
  const idx = entry.indexOf('=');
  if (idx > 0) {
    const key = entry.slice(0, idx);
    const value = entry.slice(idx + 1);
    if (key) process.env[key] = value;
  }
}"

cd /data/data/com.termux/files/home
exec opencode serve --hostname 0.0.0.0 --port 4096