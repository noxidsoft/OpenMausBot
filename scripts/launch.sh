#!/usr/bin/env bash
# Starts the harness server, the Vite UI and the Electron shell from this checkout.
# Quitting the window stops whatever this script started.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
logs="${XDG_STATE_HOME:-$HOME/.local/state}/openmausbot-launcher"
mkdir -p "$logs"
cd "$root"
export PATH="$HOME/.local/share/pnpm/bin:$HOME/.local/bin:$PATH"

listening() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

pids=()
stop() { ((${#pids[@]})) && kill "${pids[@]}" 2>/dev/null || true; }
trap stop EXIT

start() { # name port command...
  local name=$1 port=$2
  shift 2
  if listening "$port"; then return; fi
  setsid "$@" >"$logs/$name.log" 2>&1 &
  pids+=("-$!")
  for _ in $(seq 120); do
    listening "$port" && return
    sleep 0.5
  done
  echo "$name did not come up on :$port, see $logs/$name.log" >&2
  command -v notify-send >/dev/null && notify-send "OpenMausBot" "$name failed to start"
  exit 1
}

start server 8799 pnpm dev:server
start ui 5199 pnpm dev

export ELECTRON_OZONE_PLATFORM_HINT=auto
pnpm dev:desktop >"$logs/desktop.log" 2>&1
