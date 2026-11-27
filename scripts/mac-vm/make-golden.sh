#!/usr/bin/env bash
# macOS の確認用 VM の元イメージ（既定 kisui-vm-golden）を、素の VM（既定 kisui-vm-base）から作る。
#
#   scripts/mac-vm/make-golden.sh
#
# 素の VM には、ユーザー lume への ssh の鍵と cua-driver を入れておく（中身は README.md の「3 つの VM」）。
# 元イメージには次を入れる。
# - Firefox Developer Edition を /Applications/Firefox.app という名前で入れる。kisui-terminal は
#   `open -a Firefox` で開くので、この名前でないと開けない。手元で作った拡張には署名が無い。
#   普通の Firefox は署名の無い拡張を再起動までしか入れておけないが、Developer Edition は設定で入れたままにできる。
# - Firefox の設定（署名の無い拡張を許す・初回の案内を出さない）。
# - Firefox のプロファイル（~/Library/Application Support/Firefox）。kisui-terminal は、このフォルダがあるとき
#   だけ拡張の受け口の登録を置く（Mozilla/NativeMessagingHosts は kisui-terminal が作る）。
set -euo pipefail

BASE=${BASE:-kisui-vm-base}
GOLDEN=${GOLDEN:-kisui-vm-golden}

# shellcheck source=lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

if lume get "$GOLDEN" >/dev/null 2>&1; then
  echo "$GOLDEN は既にあります。作り直すなら先に lume delete $GOLDEN で消してください。" >&2
  exit 1
fi
lume clone "$BASE" "$GOLDEN"
lume run "$GOLDEN" --detach --display none

ip=$(wait_ssh "$GOLDEN")

ssh "${VM_SSH_OPTS[@]}" "lume@$ip" 'set -e
cd /tmp
curl -sSL -o ffdev.dmg "https://download.mozilla.org/?product=firefox-devedition-latest-ssl&os=osx&lang=en-US"
hdiutil attach -nobrowse -quiet ffdev.dmg -mountpoint /tmp/ffdev
rm -rf /Applications/Firefox.app
cp -R "/tmp/ffdev/Firefox Developer Edition.app" /Applications/Firefox.app
hdiutil detach -quiet /tmp/ffdev
rm ffdev.dmg
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /Applications/Firefox.app

R=/Applications/Firefox.app/Contents/Resources
mkdir -p "$R/defaults/pref"
cat > "$R/defaults/pref/autoconfig.js" <<EOF
pref("general.config.filename", "kisui.cfg");
pref("general.config.obscure_value", 0);
EOF
cat > "$R/kisui.cfg" <<EOF
// kisui-terminal の確認用 VM の設定（1 行目は Firefox が読み飛ばす）
lockPref("xpinstall.signatures.required", false);
lockPref("extensions.autoDisableScopes", 0);
lockPref("browser.shell.checkDefaultBrowser", false);
lockPref("browser.aboutwelcome.enabled", false);
lockPref("startup.homepage_welcome_url", "");
lockPref("startup.homepage_override_url", "");
lockPref("browser.startup.homepage_override.mstone", "ignore");
lockPref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
lockPref("app.update.auto", false);
EOF

# 一度開いて閉じ、プロファイルを作っておく
rm -rf ~/Library/Application\ Support/Firefox
open -a Firefox about:blank
sleep 15
osascript -e "quit app \"Firefox\""
sleep 4
ls -d ~/Library/Application\ Support/Firefox/Profiles/*.dev-edition-default
defaults read /Applications/Firefox.app/Contents/Info.plist CFBundleShortVersionString'

lume shutdown "$GOLDEN"
echo "== できました: $GOLDEN"
