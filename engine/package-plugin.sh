#!/bin/sh
# Copy the DSH plugin to the stable app resource path before signing.
set -eu
ROOT="$1"
RESOURCES="$2"
PLUGIN="$RESOURCES/dsh-plugin"
mkdir -p "$PLUGIN"
for item in lib locale skill assets; do
    test -d "$ROOT/$item"
    mkdir -p "$PLUGIN/$item"
    rsync -a --exclude node_modules --exclude engine "$ROOT/$item/" "$PLUGIN/$item/"
done
for item in package.json cordis.patch.yml; do
    cp "$ROOT/$item" "$PLUGIN/$item"
done
