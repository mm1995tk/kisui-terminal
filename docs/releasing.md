# リリースの流れ

kisui-terminal は shijimi-editor（shj）とは別の版・別のタイミングでリリースします。shijimi-editor の「毎日のリリース判定」は kisui-terminal を扱いません。リリースは人が起動します。

## 版

- 版は `app/src-tauri/Cargo.toml` の `version` です。0.x の間は、利用者から見える機能が増えたか破壊的な変更があれば minor、それ以外は patch を上げます。
- 版を上げる手順：`Cargo.toml` の `version`（と、`Cargo.lock` の同じ行）を直す PR をマージします。そのあと、Actions の「リリース」（`release.yml`）を main で起動します（`gh workflow run release.yml --ref main`。`ref` を空にすると main の最新）。このワークフローは版を書き換えません。同じ版のタグがもう別のコミットにあれば止まります。
- Release のタグは `v<版>` で、GitHub の「Latest」の印が付きます。

## 同梱する shj

- 同梱する shj は shijimi-editor がリリースしたものです。このリポジトリでは shj を作りません。
- Nix：flake の入力 `shijimi-editor`（release ブランチ。一番新しいリリース）の shj です。nightly 版は入力 `shijimi-editor-nightly`（タグ nightly）の `shj-nightly` です。`update-flake.yml` が毎日進めます。
- リリースのワークフロー：そのコミットの `flake.lock` が指す shijimi-editor の版（`nix eval --raw .#shj.version`）の `shj-<os>-<cpu>` を、shijimi-editor の Release `v<版>` から取ります（`packaging/fetch-shj.sh`。`SHA256SUMS` で確かめます）。Release の説明に、同梱した shj の版を書きます。
- 新しい shj を同梱した版を出すには、`flake.lock` を進めた（`update-flake.yml` か `nix flake update shijimi-editor`）あとにリリースします。

## 上がるもの（`build.yml`）

macOS（Apple シリコン、aarch64-apple-darwin）の Apple の署名の無い（ad-hoc 署名だけの）`.dmg`、`.app.tar.gz` とその `.sig`、リモートに入れる `kisui-<os>-<cpu>` と `shj-<os>-<cpu>`（Linux の x64・arm64 と macOS の arm64）、`SHA256SUMS`、`latest.json`。ビルドと Release への upload は `build.yml`（`release.yml` と `nightly.yml` から呼ぶ）です。ssh 先への kisui と shj の取得（`app/src-tauri/src/install.rs`）は、この Release から取ります。macOS の Intel（x86_64）はサポートしないので、アプリもリモート用の `kisui-darwin-x64`・`shj-darwin-x64` も作りません。

- Linux の AppImage（x86_64 と aarch64）は、ふだんのリリースでは作りません。`linux-appimage.yml` が毎月 1 日と 15 日（17:00 UTC）に、最新の安定版（Latest の Release）と同じタグ・同じコミットで作って、その Release に足し、`latest.json` に `linux-x86_64` と `linux-aarch64` を足します。もう足してあれば何もしません。すぐ足すには `gh workflow run linux-appimage.yml --ref main` で起動します。足すまでの間、Linux の AppImage の自動更新は新しい版を見つけません。

- 自動更新の確認先（Tauri の updater の `endpoints`）は `https://github.com/mm1995tk/kisui-terminal/releases/latest/download/latest.json` です。このリポジトリの Release は kisui-terminal のものだけなので、`releases/latest` で足ります（pre-release の nightly は Latest になりません）。
- 署名鍵と 1Password のサービスアカウントは `build.yml` の冒頭に書いてあります。Secret `OP_SERVICE_ACCOUNT_TOKEN_RELEASE` がこのリポジトリに要ります。
- 古い版を出し直しても、`releases/latest` は版の大小ではなく一番新しく作った Release を指します。出し直しは、最新の版でだけ行います。

## nightly 版

- `nightly.yml` が毎日 16:00 UTC（日本時間 1:00。shijimi-editor の nightly の 1 時間後）に main で動き、pre-release `nightly`（毎回作り直します）に、`kisui-terminal-nightly` の `.dmg`（macOS の Apple シリコンだけ。nightly の AppImage は作りません）・`latest.json`、`kisui-nightly-<os>-<cpu>` と `shj-nightly-<os>-<cpu>`、`SHA256SUMS` を置きます。
- 版は `<Cargo.toml の version>-nightly.<yyyymmdd>.g<sha>` です（sha の前の `g` は、sha が数字だけで 0 から始まっても semver になるようにするため）。同梱する shj は、その時点の shijimi-editor の pre-release `nightly` の shj です。
- 前の nightly から main にコミットが無く、shijimi-editor の nightly も進んでいなければ何もしません（`gh workflow run nightly.yml -f force=true` で作り直せます）。
- nightly 版の自動更新の確認先は `https://github.com/mm1995tk/kisui-terminal/releases/download/nightly/latest.json` です（`app/src-tauri/tauri.nightly.conf.json`）。

## shijimi-editor のリポジトリにあった頃の版からの移行

kisui-terminal は 2026-11-07 に shijimi-editor のリポジトリから分かれました（shijimi-editor の #600）。それより前の nightly（shijimi-editor の pre-release `kisui-terminal-nightly`）を見ている kisui-terminal-nightly には、新しい nightly が届きません。そのときの確認先に、このリポジトリの nightly を指す `latest.json` を 1 度置けば移れます（Tauri の updater は `latest.json` の `url` をそのまま取るため）。安定版はまだ出していなかったので、移行はありません。

## 止める・変える

- nightly を止めるには、Actions の「nightly 版を配る」（`nightly.yml`）を無効にします（`gh workflow disable nightly.yml`）。pre-release は残るので、消すなら `gh release delete nightly --cleanup-tag` で消します。
