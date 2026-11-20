#!/usr/bin/env bash
# 同梱した公開サフィックスの一覧（app/src-tauri/assets/public_suffix_list.dat）を、publicsuffix.org の最新のものに置き換える。
# 殻（app/src-tauri/src/public_suffix.rs）がこれを埋め込み、`[gui.browser] passkey_sites` の `.com` のような項目を断るのに使う。
# 一覧は publicsuffix.org の URL からだけ取る（一覧の先頭のコメントがそう頼んでいる）。
# 置き換えたら cargo test を通してからコミットする（CONTRIBUTING.md の「Updating the Public Suffix List」）。
# 毎日の .github/workflows/update-flake.yml もこれを動かす。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

url=https://publicsuffix.org/list/public_suffix_list.dat
dest=app/src-tauri/assets/public_suffix_list.dat

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-time 60 -o "$tmp" "$url"

# 途中で切れたものや、別のページを置かないよう、一覧の形をしているかを確かめる
for marker in "// VERSION:" "===BEGIN ICANN DOMAINS===" "===END ICANN DOMAINS===" "===BEGIN PRIVATE DOMAINS===" "===END PRIVATE DOMAINS==="; do
  if ! grep -qF -- "$marker" "$tmp"; then
    echo "update-public-suffix-list: $url に $marker がありません。置き換えません" >&2
    exit 1
  fi
done

install -m644 "$tmp" "$dest"
grep -m1 '^// VERSION:' "$dest"
