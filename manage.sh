#!/usr/bin/env bash
# Management script for SlurmClusterInsight (start/stop/status/logs).
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_ROOT"

PID_FILE="$APP_ROOT/.slurmclusterinsight.pid"
LOG_DIR="$APP_ROOT/logs"
LOG_FILE="$LOG_DIR/app.log"
PORT="${PORT:-4173}"
HOST="${HOST:-0.0.0.0}"

mkdir -p "$LOG_DIR"

is_running() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE")
    if ps -p "$pid" >/dev/null 2>&1; then
      return 0
    else
      rm -f "$PID_FILE"
    fi
  fi
  return 1
}

start() {
  if is_running; then
    echo "Service already running (pid $(cat "$PID_FILE"))."
    exit 0
  fi

  echo "Starting SlurmClusterInsight on ${HOST}:${PORT} ..."
  HOST="$HOST" PORT="$PORT" nohup npm start >>"$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  echo "Started with pid $(cat "$PID_FILE"). Logs: $LOG_FILE"
}

stop() {
  if ! is_running; then
    echo "Service not running."
    exit 0
  fi
  local pid
  pid=$(cat "$PID_FILE")
  echo "Stopping pid $pid ..."
  kill "$pid" || true
  rm -f "$PID_FILE"
  echo "Stopped."
}

status() {
  if is_running; then
    echo "Service is running (pid $(cat "$PID_FILE")) on ${HOST}:${PORT}."
  else
    echo "Service is not running."
  fi
}

logs() {
  tail -n "${1:-100}" "$LOG_FILE"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop || true; start ;;
  status) status ;;
  logs) logs "${2:-100}" ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs [lines]}"; exit 1 ;;
esac
