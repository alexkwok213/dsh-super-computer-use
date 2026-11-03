#!/bin/sh
# Exercise the real packaging helper and sign a temporary app without installing it.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/cu-package-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
APP="$TMP/Computer Use.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp /usr/bin/true "$APP/Contents/MacOS/Computer Use"
printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.cu.package-test</string><key>CFBundleExecutable</key><string>Computer Use</string></dict></plist>' > "$APP/Contents/Info.plist"
sh "$ROOT/engine/package-plugin.sh" "$ROOT" "$APP/Contents/Resources"
PLUGIN="$APP/Contents/Resources/dsh-plugin"
for item in lib/index.mjs lib/core.mjs locale/en.json locale/zh-CN.json skill/SKILL.md package.json cordis.patch.yml assets/icon.png; do
  test -f "$PLUGIN/$item" || { echo "missing $item" >&2; exit 1; }
  cmp "$ROOT/$item" "$PLUGIN/$item"
done
test ! -e "$PLUGIN/engine"
test ! -e "$PLUGIN/node_modules"
codesign --force --sign - "$APP" >/dev/null 2>&1
codesign --verify --strict "$APP"
printf '\nmutation\n' >> "$PLUGIN/locale/en.json"
if codesign --verify --strict "$APP" >/dev/null 2>&1; then
  echo 'signature did not cover plugin resources' >&2
  exit 1
fi
echo 'plugin packaging and signature verification passed'
