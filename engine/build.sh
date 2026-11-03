#!/bin/sh
# Build the standalone computer-use engine and sign it ad-hoc, so macOS can
# remember the permissions you grant it.
set -eu
cd "$(dirname "$0")"
mkdir -p bin
swiftc -O -swift-version 5 \
  -target arm64-apple-macos14.0 \
  -framework AppKit -framework ApplicationServices -framework ScreenCaptureKit -framework Vision \
  -o bin/cu Sources/main.swift
# Toolchain defaults to minos 28 (newer than this machine's 27); LaunchServices
# then refuses the binary as an app main executable with -10825 even though
# direct exec works. Pin the deployment target.
# A stable signing identity keeps the TCC grant across rebuilds; ad-hoc changes the
# cdhash every build and macOS forgets the permission.
IDENTITY="${CU_SIGN_IDENTITY:-Apple Development: g690322603@outlook.com (8UL3844UU8)}"
if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$IDENTITY"; then
  codesign --force --sign "$IDENTITY" bin/cu
else
  codesign --force --sign - bin/cu
fi
echo "built $(pwd)/bin/cu"
./bin/cu perms
