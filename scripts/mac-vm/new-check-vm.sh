#!/usr/bin/env bash
# macOS の確認用 VM（lume）を元イメージから作り直し、kisui-terminal の版と Firefox の拡張を入れる。
#
#   scripts/mac-vm/new-check-vm.sh [-y] [--tag TAG] [--extension ZIP] [--no-extension] [--config TOML]
#
# - 元イメージ（既定 kisui-vm-golden）は make-golden.sh で作る。Firefox（中身は Developer Edition）と
#   cua-driver が入っていて、署名の無い拡張を入れたままにできる。
# - 確認用 VM（既定 kisui-vm）は、あれば消して作り直す。中に残した設定やスクリーンショットも消える。
# - 確認用 VM の MAC アドレスを固定するので、IP アドレスは毎回同じになる（cua-driver の MCP の接続先が変わらない）。
# - TAG は GitHub の Release のタグ（既定 nightly）。その Release の .dmg を入れる。
# - 拡張は、指定が無ければ extension/dist の一番新しい zip を入れる（npm run build:extension で作る）。
# - 設定は、指定が無ければ同じフォルダの config.local.toml を、VM の config.local.toml として入れる。
set -euo pipefail

REPO=mm1995tk/kisui-terminal
GOLDEN=${GOLDEN:-kisui-vm-golden}
VM=${VM:-kisui-vm}
# 確認用 VM の MAC アドレス。lume の DHCP はこれで IP アドレスを決める（192.168.64.2）
MAC=${MAC:-a6:91:68:b7:6a:5c}
EXT_ID=kisui-terminal@mm1995tk.github.io

tag=nightly
ext=""
no_ext=0
yes=0
cfg=""
while [ $# -gt 0 ]; do
  case "$1" in
  -y) yes=1 ;;
  --tag) tag=$2; shift ;;
  --extension) ext=$2; shift ;;
  --no-extension) no_ext=1 ;;
  --config) cfg=$2; shift ;;
  -h | --help) sed -n '2,12p' "$0"; exit 0 ;;
  *) echo "知らない引数: $1" >&2; exit 2 ;;
  esac
  shift
done

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
cfg=${cfg:-$here/config.local.toml}
[ -f "$cfg" ] || { echo "設定のファイルがありません: $cfg" >&2; exit 1; }
if [ "$no_ext" = 0 ] && [ -z "$ext" ]; then
  ext=$(ls -t "$root"/extension/dist/kisui-terminal-firefox-*.zip 2>/dev/null | head -1 || true)
  if [ -z "$ext" ]; then
    echo "拡張の zip がありません。npm run build:extension で作るか、--extension か --no-extension を付けてください。" >&2
    exit 1
  fi
fi

vm_status() { lume get "$1" --format json 2>/dev/null | python3 -c 'import sys,json;d=json.load(sys.stdin);print((d[0] if isinstance(d,list) else d)["status"])' 2>/dev/null || echo missing; }
vm_ip() { lume get "$1" --format json 2>/dev/null | python3 -c 'import sys,json;d=json.load(sys.stdin);print((d[0] if isinstance(d,list) else d).get("ipAddress") or "")' 2>/dev/null || true; }

[ "$(vm_status "$GOLDEN")" = stopped ] || { echo "元イメージ $GOLDEN が無いか、止まっていません。" >&2; exit 1; }

# 1. 入れる版をホストに落として確かめる
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
echo "== $REPO の Release $tag を落とします"
gh release download "$tag" -R "$REPO" -p '*.dmg' -p SHA256SUMS -D "$work"
dmg=$(ls "$work"/*.dmg | head -1)
# SHA256SUMS に .dmg が載っていれば確かめる（今の Release は kisui と shj の単体のファイルだけを載せている）
if line=$(grep " $(basename "$dmg")\$" "$work/SHA256SUMS"); then
  (cd "$work" && echo "$line" | shasum -a 256 -c -)
fi

# 2. 確認用 VM を作り直す
if [ "$(vm_status "$VM")" != missing ]; then
  if [ "$yes" = 0 ]; then
    read -r -p "$VM を消して作り直します。中の設定も消えます。続けますか？ [y/N] " a
    [ "$a" = y ] || [ "$a" = Y ] || exit 1
  fi
  [ "$(vm_status "$VM")" = stopped ] || lume stop "$VM"
  lume delete "$VM" --force
fi
lume clone "$GOLDEN" "$VM"
lume set "$VM" --mac-address "$MAC"
lume run "$VM" --detach --display none

echo "== $VM の起動を待ちます"
ip=""
for _ in $(seq 1 60); do
  ip=$(vm_ip "$VM")
  if [ -n "$ip" ] && ssh -T -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "lume@$ip" true 2>/dev/null; then
    break
  fi
  ip=""
  sleep 5
done
[ -n "$ip" ] || { echo "$VM に ssh でつながりません。" >&2; exit 1; }
# 作り直した VM は前の VM と鍵が同じとは限らないので、このローカルの VM に限って known_hosts を使わない
vssh() { ssh -T -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "lume@$ip" "$@"; }

# 3. kisui-terminal を入れ替える
echo "== $(basename "$dmg") を入れます"
vssh 'cat > /tmp/kisui.dmg' <"$dmg"
vssh 'set -e
hdiutil attach -nobrowse -quiet /tmp/kisui.dmg -mountpoint /tmp/kisui-dmg
app=$(ls -d /tmp/kisui-dmg/*.app | head -1)
rm -rf "/Applications/$(basename "$app")"
cp -R "$app" /Applications/
hdiutil detach -quiet /tmp/kisui-dmg
rm /tmp/kisui.dmg
echo "$(basename "$app") $(defaults read "/Applications/$(basename "$app")/Contents/Info.plist" CFBundleShortVersionString)"'

# 設定のフォルダの名前は、アプリの名前と同じ（kisui-terminal か kisui-terminal-nightly）
app=$(vssh 'basename "$(ls -d /Applications/kisui-terminal*.app | head -1)" .app')
echo "== 設定 $cfg を ~/.config/$app/config.local.toml に入れます"
vssh "mkdir -p ~/.config/$app && cat > ~/.config/$app/config.local.toml" <"$cfg"

# 4. Firefox の拡張を入れ替える（プロファイルの extensions に置くと、次に Firefox を開いたときに入る）
if [ "$no_ext" = 0 ]; then
  echo "== 拡張 $(basename "$ext") を入れます"
  vssh "cat > /tmp/ext.xpi" <"$ext"
  vssh "set -e
p=\$(ls -d ~/Library/Application\\ Support/Firefox/Profiles/*.dev-edition-default)
mkdir -p \"\$p/extensions\"
mv /tmp/ext.xpi \"\$p/extensions/$EXT_ID.xpi\""
fi

echo "== できました: $VM ($ip)"
echo "画面を見るには: lume attach $VM"
