#!/usr/bin/env bash
# emulator/ の Rust から internal/emulator/emulator.wasm を作り直す。emulator/ か Cargo.lock を変えたら
# 実行してコミットする（checks.emulator-wasm が、コミットした wasm とソースの食い違いを見つける）。
# wasm のバイト列は作ったホストで変わるので、x86_64-linux だけで作る。macOS では x86_64-linux のビルダー
# （linux-builder に Rosetta を付けたもの）が要る。無ければ CI の check が出す emulator-wasm の成果物を使う
# （CONTRIBUTING.md の「Rebuilding internal/emulator/emulator.wasm」）。
set -euo pipefail
cd "$(dirname "$0")/.."
out=$(nix build .#packages.x86_64-linux.emulator-wasm --no-link --print-out-paths)
install -m644 "$out/emulator.wasm" internal/emulator/emulator.wasm
