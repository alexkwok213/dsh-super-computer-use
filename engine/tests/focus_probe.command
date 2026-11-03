#!/bin/zsh
# Does any CU path steal the user's foreground? Samples the front app while
# running the paths a normal session uses, and writes it all to focus_probe.log.
# Run by opening this file in Finder; Terminal is frontmost for the whole run,
# so any change away from "Terminal" is a steal.
CU_DIR="$HOME/Downloads/work/computer-use"
LOG="$CU_DIR/tests/focus_probe.log"
: > "$LOG"
exec >>"$LOG" 2>&1

ts() { date +"%H:%M:%S"; }
front() {
  local asn
  asn=$(lsappinfo front 2>/dev/null)
  lsappinfo info -only name "$asn" 2>/dev/null | tr -d '\n'
}
cu_windows() {
  local token reply
  token=$(sed -n 's/.*"token" *: *"\([^"]*\)".*/\1/p' "$HOME/.cu/config.json" | head -1)
  reply=$(curl -s -m 10 -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
          -d '{"argv":["windows"]}' http://127.0.0.1:47777/v1/exec)
  echo "$reply" | tr '{' '\n' | grep '"app":"Computer Use"' || echo "  (no Computer Use windows)"
}

echo "=== focus probe $(date) ==="
echo "shell pid=$$  tty=$(tty)"

echo "--- 0: wait for the service"
for i in {1..40}; do
  S=$(curl -s -m 2 http://127.0.0.1:47777/v1/status 2>/dev/null)
  if [ -n "$S" ]; then break; fi
  sleep 1
done
echo "status: $S"

(
  while :; do
    echo "  [$(ts)] front: $(front)"
    sleep 0.4
  done
) &
SAM=$!

echo "--- A baseline (Terminal was just opened by Finder)"
sleep 2
echo "front: $(front)"

echo "--- B: start the menu-bar agent the way install-app.sh does (launchctl, no open)"
launchctl kickstart -k "gui/$(id -u)/local.cu.menubar" >/dev/null 2>&1
sleep 3
echo "front: $(front)"
echo "windows:"
cu_windows

echo "--- C: capsule pill spawned the way the MCP layer does"
"$CU_DIR/bin/cu" capsule --label "probe" --seconds 4 >/dev/null 2>&1 &
sleep 2
echo "front: $(front)"
sleep 3
echo "front: $(front)"

echo "--- D: service actions (windows / snapshot / frontmost)"
TOKEN=$(sed -n 's/.*"token" *: *"\([^"]*\)".*/\1/p' "$HOME/.cu/config.json" | head -1)
call() {
  echo "> $1"
  curl -s -m 25 -H "Authorization: Bearer $TOKEN" \
       -H "Content-Type: application/json" \
       -d "{\"argv\":$1}" http://127.0.0.1:47777/v1/exec | head -c 160
  echo
  echo "front: $(front)"
}
call '["windows"]'
sleep 1
FINDER=$(pgrep -x Finder | head -1)
call "[\"snapshot\",\"--pid\",\"$FINDER\"]"
sleep 1
call '["frontmost"]'

echo "--- E: restore Terminal"
/usr/bin/open -a Terminal
sleep 1
echo "front: $(front)"

kill $SAM 2>/dev/null
echo "=== end $(date) ==="
