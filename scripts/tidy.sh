#!/usr/bin/env bash
# リポジトリを整える。手元でも CI でも、これ 1 つを動かす。
# 動かし方は nix run .#tidy か、devShell の中で scripts/tidy.sh。
#
# 順番に意味がある:
#   go mod tidy → gomod2nix は go.mod と go.sum から gomod2nix.toml を作るので、tidy のあと
#   go fix      → コードを書き換える（gopls が「シンプルに書ける」と出す modernize の修正）ので、nix fmt はそのあと
set -euo pipefail
# nix run では store の中から動くので、$0 ではなく git でリポジトリの根を探す
cd "$(git rev-parse --show-toplevel)"
# devShell と同じ。go fix は依存を型検査するので、cgo を切らないと C コンパイラを探しに行く
export CGO_ENABLED=0

go mod tidy
gomod2nix
go fix ./...
nix fmt
