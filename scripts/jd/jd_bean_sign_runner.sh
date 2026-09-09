#!/data/data/com.termux/files/usr/bin/env bash
# 京东天天领豆自动签到执行器
# 等待活动时段(10:00-21:00)到达后执行 bean_sign.cjs，然后退出。
# 用法：nohup bash jd_bean_sign_runner.sh >/dev/null 2>&1 &
# 日志：scripts/jd/bean_sign.log（追加）
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$DIR/bean_sign.log"

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

log "执行器启动，等待活动时段(10:00-21:00)..."
while true; do
  HH="$(date +%H)"
  if [ "$HH" -ge 10 ] && [ "$HH" -lt 21 ]; then
    log "进入活动时段(HH=$HH)，开始执行签到"
    env -u LD_PRELOAD -u LD_LIBRARY_PATH node "$DIR/bean_sign.cjs" >> "$LOG" 2>&1
    RC=$?
    log "签到完成，退出码=$RC"
    exit $RC
  fi
  sleep 300   # 每 5 分钟检查一次
done