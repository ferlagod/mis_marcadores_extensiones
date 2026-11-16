#!/bin/sh
# Genera dist/chromium, dist/firefox y sus .zip a partir de src/ y manifests/.
set -eu
cd "$(dirname "$0")"
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifests/chromium.json | head -1)
rm -rf dist
for target in chromium firefox; do
  mkdir -p "dist/$target"
  cp -R src/. "dist/$target/"
  cp "manifests/$target.json" "dist/$target/manifest.json"
  (cd "dist/$target" && zip -qr -X "../mis-marcadores-$target-$VERSION.zip" . -x '.*')
done
echo "Listo:"
ls -1 dist/*.zip
