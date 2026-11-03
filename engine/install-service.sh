#!/bin/sh
# Register the per-user LaunchAgents (service + menu bar) for Computer Use.
# Both agents run the engine from inside the installed app bundle, so there is
# exactly one engine copy on disk. Run install-app.sh first.
set -eu
cd "$(dirname "$0")"

APP_BIN="/Applications/Computer Use.app/Contents/MacOS/Computer Use"
if [ ! -x "$APP_BIN" ] && [ -x "$HOME/Applications/Computer Use.app/Contents/MacOS/Computer Use" ]; then
    APP_BIN="$HOME/Applications/Computer Use.app/Contents/MacOS/Computer Use"
fi
if [ ! -x "$APP_BIN" ]; then
    echo "error: $APP_BIN not found — run ./install-app.sh first" >&2
    exit 1
fi
# The service runs the hard-linked engine copy outside the bundle: a process
# inside the bundle gets registered by LaunchServices as "the app", which then
# breaks double-click (`open` tries to activate the service → -600).
SERVICE_BIN="$HOME/Library/Application Support/cu/bin/cu"
if [ ! -x "$SERVICE_BIN" ]; then
    echo "error: $SERVICE_BIN not found — run ./install-app.sh first" >&2
    exit 1
fi

PLIST="$HOME/Library/LaunchAgents/local.cu.service.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.cu"

PORT=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.cu/config.json')))['port'])" 2>/dev/null || echo 47777)

# bootout returns before the old process exits; a bootstrap that lands while the
# old service still holds the port dies with bind_failed and only recovers after
# launchd's retry timer. Wait for the port to be released first.
wait_port_free() {
    i=0
    while [ "$i" -lt 50 ]; do
        if ! /usr/bin/nc -z 127.0.0.1 "$PORT" 2>/dev/null; then return 0; fi
        sleep 0.2
        i=$((i + 1))
    done
    return 0
}

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>local.cu.service</string>
    <key>ProgramArguments</key>
    <array><string>$SERVICE_BIN</string><string>service</string></array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ProcessType</key><string>Interactive</string>
    <key>LimitLoadToSessionType</key><string>Aqua</string>
    <key>StandardOutPath</key><string>$HOME/.cu/service.out.log</string>
    <key>StandardErrorPath</key><string>$HOME/.cu/service.err.log</string>
</dict>
</plist>
PLIST

MENU_PLIST="$HOME/Library/LaunchAgents/local.cu.menubar.plist"
cat > "$MENU_PLIST" <<MENU
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>local.cu.menubar</string>
    <key>ProgramArguments</key>
    <array><string>$APP_BIN</string><string>app</string><string>--quiet</string></array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
    <key>LimitLoadToSessionType</key><string>Aqua</string>
    <key>StandardOutPath</key><string>$HOME/.cu/menubar.out.log</string>
    <key>StandardErrorPath</key><string>$HOME/.cu/menubar.err.log</string>
</dict>
</plist>
MENU

# Restarting an agent is bootout + bootstrap, but bootout is asynchronous: a
# bootstrap that lands while the old job is still unloading fails with
# "Input/output error" and leaves the job not loaded at all (that is how the
# menu-bar item and the HTTP service disappeared after an install). Wait for the
# label to actually go away, then bootstrap; kickstart as the fallback.
restart_agent() {
    plist="$1"
    label="$2"
    launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
    i=0
    while [ "$i" -lt 25 ] && launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; do
        sleep 0.2
        i=$((i + 1))
    done
    wait_port_free
    launchctl bootstrap "gui/$(id -u)" "$plist" >/dev/null 2>&1 || \
        launchctl kickstart -k "gui/$(id -u)/$label" >/dev/null 2>&1 || true
}

restart_agent "$PLIST" local.cu.service
restart_agent "$MENU_PLIST" local.cu.menubar
sleep 1

echo
echo "service: http://127.0.0.1:$PORT (engine: $APP_BIN)"
curl -s "http://127.0.0.1:$PORT/v1/status" | python3 -m json.tool || true
echo
echo "If accessibility/screenRecording are false, re-grant once in"
echo "System Settings → Privacy & Security → Accessibility / Screen Recording"
echo "for the app bundle: /Applications/Computer Use.app"
echo
echo "Uninstall:"
echo "  launchctl bootout gui/$(id -u) $PLIST; rm $PLIST"
echo "  launchctl bootout gui/$(id -u) $MENU_PLIST; rm $MENU_PLIST"
