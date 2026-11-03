#!/bin/sh
# Build "Computer Use.app" and install it (menu-bar only, no Dock icon).
# The engine binary itself is the app's main executable: build.sh pins the
# deployment target, so LaunchServices accepts a self-compiled Mach-O (the
# old script-launcher workaround is gone).
set -eu
cd "$(dirname "$0")"

./build.sh >/dev/null

NAME="Computer Use"
BUNDLE="build/$NAME.app"
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"
cp bin/cu "$BUNDLE/Contents/MacOS/$NAME"
cp mcp/tools.json "$BUNDLE/Contents/Resources/tools.json"
cp build/AppIcon.icns "$BUNDLE/Contents/Resources/AppIcon.icns"

cat > "$BUNDLE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>$NAME</string>
    <key>CFBundleDisplayName</key><string>$NAME</string>
    <key>CFBundleIdentifier</key><string>local.cu.app</string>
    <key>CFBundleExecutable</key><string>$NAME</string>
    <key>CFBundleIconFile</key><string>AppIcon</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>0.1.0</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>LSUIElement</key><true/>
    <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

IDENTITY="${CU_SIGN_IDENTITY:-Apple Development: g690322603@outlook.com (8UL3844UU8)}"
SIGN_ID="-"
if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$IDENTITY"; then
    SIGN_ID="$IDENTITY"
fi
codesign --force --sign "$SIGN_ID" --identifier local.cu.app "$BUNDLE" >/dev/null
codesign --verify --strict "$BUNDLE"
echo "built $BUNDLE"

DEST="/Applications"
if [ ! -w "$DEST" ]; then DEST="$HOME/Applications"; mkdir -p "$DEST"; fi
# A previously staged copy stays registered with LaunchServices until removed.
if [ -d "build/$NAME.app" ] && [ "$DEST/$NAME.app" != "$PWD/build/$NAME.app" ]; then
    /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
        -u "$PWD/build/$NAME.app" >/dev/null 2>&1 || true
fi
rm -rf "$DEST/$NAME.app"
cp -R "$BUNDLE" "$DEST/$NAME.app"
rm -rf "$BUNDLE"
xattr -dr com.apple.quarantine "$DEST/$NAME.app" 2>/dev/null || true
# Force LaunchServices to pick up the new bundle now, or Finder/Launchpad
# falls back to the generic icon until some later rescan.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -f "$DEST/$NAME.app" >/dev/null 2>&1 || true
echo "installed $DEST/$NAME.app"

# The MCP proxy script lives at a stable path so agent configs (written by
# `cu agents-connect`) survive repo moves; CU_BIN points at the bundle engine.
PROXY="$HOME/Library/Application Support/cu/mcp"
mkdir -p "$PROXY"
cp mcp/server.py "$PROXY/server.py"
# The service reads its tool catalogue from ../mcp/tools.json relative to the
# engine binary; keep it in the same directory as the proxy so both agree.
cp mcp/tools.json "$PROXY/tools.json"

# The background service must NOT run the bundle binary directly: LaunchServices
# registers any process living inside the bundle as "the app", so `open` then
# tries to activate the service (which ignores UI events) and fails with -600.
# A hard link keeps a single engine copy while giving the service a non-bundle
# path; a plain copy is the fallback across filesystems.
SUPPORT="$HOME/Library/Application Support/cu"
mkdir -p "$SUPPORT/bin"
rm -f "$SUPPORT/bin/cu"
ln "$DEST/$NAME.app/Contents/MacOS/$NAME" "$SUPPORT/bin/cu" 2>/dev/null || \
    cp "$DEST/$NAME.app/Contents/MacOS/$NAME" "$SUPPORT/bin/cu"
chmod 755 "$SUPPORT/bin/cu"

# The login agents (service + menu bar) are owned by install-service.sh; both
# run the engine from inside this bundle, so there is exactly one engine copy.
./install-service.sh >/dev/null 2>&1 || true
sleep 1
# install-service.sh has just (re)started both agents through launchd, which
# starts them without activating anything. Never `open` the app to "start" it:
# LaunchServices sends a reopen to the copy that is already running, and a reopen
# raises the console window — which takes the user's foreground mid-install
# (measured with tests/focus_probe.command).
if ! launchctl print "gui/$(id -u)/local.cu.menubar" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/local.cu.menubar" >/dev/null 2>&1 || \
        open -g "$DEST/$NAME.app"
fi
echo
echo "Computer Use is now in $DEST — look for it in Applications/Launchpad."
echo "It has no Dock icon by design; the item is in the menu bar (● CU)."
