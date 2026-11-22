#!/bin/bash
# Keepalive supervisor for the LocalForge preview server (:3000).
# The sandbox recycles processes between messages; this watchdog restarts
# the standalone server whenever it stops answering, while the session lives.
cd /home/z/my-project
[ -f .watchdog.pid ] && kill -0 "$(cat .watchdog.pid)" 2>/dev/null && exit 0  # already running
echo $$ > .watchdog.pid
echo "$(date -u '+%F %T') watchdog started (pid $$)" >> server-watchdog.log
while true; do
  if ! curl -s -o /dev/null --max-time 5 http://127.0.0.1:3000/; then
    echo "$(date -u '+%F %T') :3000 down — restarting standalone server" >> server-watchdog.log
    for p in $(ss -tlnp 2>/dev/null | grep ":3000 " | grep -oP 'pid=\K[0-9]+' | sort -u); do
      kill "$p" 2>/dev/null
    done
    sleep 2
    NODE_ENV=production nohup bun .next/standalone/server.js >> server.log 2>&1 &
    sleep 5
    curl -s -o /dev/null -w "$(date -u '+%F %T') restart check: %{http_code}\n" --max-time 5 http://127.0.0.1:3000/ >> server-watchdog.log
  fi
  sleep 15
done
