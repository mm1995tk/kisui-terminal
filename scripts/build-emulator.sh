#!/usr/bin/env bash
# emulator/ の Rust から internal/emulator/emulator.wasm を作り直す。emulator/ か Cargo.lock を変えたら
# 実行してコミットする（checks.emulator-wasm が、コミットした wasm とソースの食い違いを見つける）。
# Nix で作るので、手元でも CI でも同じバイト列になる。
set -euo pipefail
cd "$(dirname "$0")/.."
out=$(nix build .#emulator-wasm --no-link --print-out-paths)
install -m644 "$out/emulator.wasm" internal/emulator/emulator.wasm
