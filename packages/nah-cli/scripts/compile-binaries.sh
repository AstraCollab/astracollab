#!/usr/bin/env bash
# Build single-file executables for distribution (named like install.sh expects).
# Requires bun: https://bun.sh
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm run build
targets=(bun-darwin-arm64 bun-darwin-x64 bun-linux-x64 bun-linux-arm64)
for t in "${targets[@]}"; do
  out="dist/bin/nah-${t#bun-}"
  mkdir -p dist/bin
  echo "→ $out"
  bun build --compile --target="$t" --minify dist/cli.js --outfile "$out"
done
echo "done. binaries in dist/bin/"
