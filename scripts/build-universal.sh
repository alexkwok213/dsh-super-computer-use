#!/bin/bash
# Build universal binary (arm64 + x86_64) for macOS
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENGINE_DIR="$ROOT_DIR/engine"
BIN_DIR="$ROOT_DIR/bin"
TMP_DIR="$(mktemp -d)"

trap 'rm -rf "$TMP_DIR"' EXIT

echo "==> Compiling arm64 binary..."
swiftc -O -swift-version 5 \
  -target arm64-apple-macos14.0 \
  -framework AppKit -framework ApplicationServices -framework ScreenCaptureKit -framework Vision -framework AVFoundation \
  -o "$TMP_DIR/cu-arm64" "$ENGINE_DIR"/Sources/*.swift

echo "==> Compiling x86_64 binary..."
swiftc -O -swift-version 5 \
  -target x86_64-apple-macos14.0 \
  -framework AppKit -framework ApplicationServices -framework ScreenCaptureKit -framework Vision -framework AVFoundation \
  -o "$TMP_DIR/cu-x86_64" "$ENGINE_DIR"/Sources/*.swift

echo "==> Packaging Universal Binary with lipo..."
mkdir -p "$BIN_DIR"
lipo -create -output "$BIN_DIR/cu" "$TMP_DIR/cu-arm64" "$TMP_DIR/cu-x86_64"
cp "$BIN_DIR/cu" "$BIN_DIR/cu-preview"

# Codesign
IDENTITY="${CU_SIGN_IDENTITY:-$(cat "$ENGINE_DIR/signing-identity" 2>/dev/null || true)}"
if [ -n "$IDENTITY" ] && security find-identity -v -p codesigning 2>/dev/null | grep -qF "$IDENTITY"; then
  echo "==> Signing with identity: $IDENTITY"
  codesign --force --sign "$IDENTITY" "$BIN_DIR/cu"
  codesign --force --sign "$IDENTITY" "$BIN_DIR/cu-preview"
else
  echo "==> Signing ad-hoc (-)..."
  codesign --force --sign - "$BIN_DIR/cu"
  codesign --force --sign - "$BIN_DIR/cu-preview"
fi

chmod +x "$BIN_DIR/cu" "$BIN_DIR/cu-preview"
echo "==> Successfully built universal binaries in $BIN_DIR:"
file "$BIN_DIR/cu"
