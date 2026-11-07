# kisui-terminal

[English](README.md)

kisui-terminal は、[shijimi-editor](https://github.com/mm1995tk/shijimi-editor) と強く連携する、ターミナル中心の作業環境です。窓を欄に分け、欄にターミナル（その中で `shj`）・動画・画像・PDF・ブラウザ・ファイルツリーを置きます。名前の汽水は、しじみがすむ場所です。

shijimi-editor とは別のアプリで、版もリリースも別です。組み合わせを確かめた版の `shj` を同梱し、欄の中のターミナルでは同梱の `shj` を先に使います（自分で入れた `shj` は、kisui-terminal の外では今まで通り使われます）。kisui-terminal と `shj` のやりとりの取り決めは [docs/protocol.md](docs/protocol.md) にあり、コードは共有しません。

## 入れ方

Linux と macOS で動きます。版は [Releases](https://github.com/mm1995tk/kisui-terminal/releases) にあります。AppImage と `.dmg` は自動で更新されます。

- **AppImage**：`chmod +x kisui-terminal-linux-*.AppImage` してから起動します。
- **`.dmg`**：Apple の署名が無いので、macOS は初回に開くのを断ります。`kisui-terminal.app` をアプリケーションに入れて 1 度開き（「確認できません」と出たら閉じます）、**システム設定 → プライバシーとセキュリティ** で `kisui-terminal` についての表示の横にある **このまま開く** を押します。次からは普通に開けます。代わりに `xattr -dr com.apple.quarantine /Applications/kisui-terminal.app` を 1 度だけ実行してもかまいません。アプリは ad-hoc 署名だけなので、更新するたびに、プライバシーとセキュリティで入れた許可（**アプリ管理** など）を入れ直す必要があります。

main の nightly 版は `kisui-terminal-nightly` で、[`nightly` の pre-release](https://github.com/mm1995tk/kisui-terminal/releases/tag/nightly) に置いています。名前と identifier が違うので、普通の版と並べて入れられます。

Nix では、パッケージ `kisui-terminal`（nightly 版は `kisui-terminal-nightly`。同じ名前で入ります）か、home-manager で flake の `homeManagerModules.default` を import して `programs.kisui-terminal.enable = true;` で入れます。Nix で入れた版に自動更新はありません。`nix flake update` で進めます。

```sh
nix run github:mm1995tk/kisui-terminal
nix profile install github:mm1995tk/kisui-terminal
nix profile install github:mm1995tk/kisui-terminal#kisui-terminal-nightly
```

## 使い方

kisui-terminal の中での `shj` の動き（開く欄、動画、ブラウザの欄、ファイルツリー）は shijimi-editor のマニュアルにあります。[ターミナル](https://mm1995tk.github.io/shijimi-editor/manual/ja/terminal/)・[ブラウザ](https://mm1995tk.github.io/shijimi-editor/manual/ja/browser/)・[設定ファイル](https://mm1995tk.github.io/shijimi-editor/manual/ja/config/)（「kisui-terminal のマシン」と `[server]`）を見てください。

欄の中で `kisui open <ファイル|URL>` を打つと、種類に合う欄に、同じワークスペースの中で開きます。動画・画像・PDF（拡張子で見分け、拡張子で分からなければファイルの頭の中身で見分ける）か、`http`・`https` の URL ならブラウザの欄です。同じ種類の欄が開いていれば入れ替えます。ssh 先のマシンの欄でも使えます。使えるのは kisui-terminal の欄の中だけで、ほかのシェルから打つと断ります。コマンドの一覧は `kisui --help` で出ます。

```sh
kisui open ./diagram.png
kisui open ./talk.mp4
kisui open ./paper.pdf
kisui open https://example.com/
```

kisui-terminal の設定は `shj` と同じ `config.toml`（`~/.config/shijimi-editor/config.toml`。nightly 版は `shijimi-editor-nightly/`）に書きます。

- `[[gui.machines]]`：サイドバーに出すマシン（`ssh = "dev-vm"`、`name = "dev"`）。
- `[server]`：`idle_stop_days`（窓がつながっていない状態で `kisui serve` が待つ日数。既定 7、0 は止めない）と `start_dir`（新しいワークスペースのシェルを始めるフォルダ）。
- `ui-language`：kisui 自身のメッセージの言語（`shj` と同じ項目）。

ssh 先では、kisui-terminal は聞いてから自分の `kisui` と `shj` を `~/.cache/kisui-terminal/<版>/` に入れます。その先の PATH の `shj` には触りません。

## 開発

Nix の devShell（Go・gopls・gomod2nix・git・Node.js・Rust。Linux では WebView のライブラリも）を使います。direnv があれば `.envrc` で自動で入ります。コマンドはどれもリポジトリの根で動かします。`go.mod`（サーバーの `kisui`）、`package.json`（Web 画面。ソースは `app/`）、`Cargo.toml`（Tauri の殻 `app/src-tauri` を member に持つ workspace）はどれも根にあります。

```sh
nix develop
npm ci                 # Web 画面（最初と、package-lock.json が変わったとき）
go test ./...          # kisui
npm test               # Web 画面
cargo test             # Tauri の殻
go build -o target/dev/kisui ./cmd/kisui   # 窓が起動する kisui（SHIJIMI_KISUI）
SHIJIMI_KISUI=$PWD/target/dev/kisui npm run tauri dev   # 動かす（devShell の外では nix run .#dev）
nix fmt                # 全部を整形する
nix flake check        # CI が回す検査を全部（整形・go test・ビルドとテスト）
```

`tauri dev` では、欄の中のターミナルは PATH の `shj` を使います。配るアプリは自分の `shj` を同梱します（`packaging/`）。

置き場：`app/` が窓（`src/` に Solid + TypeScript、`src-tauri/` に Tauri の殻）、`cmd/kisui` と `server/`・`attach/`・`rpc/`・`config/` が `kisui`（Go）、`internal/` は kisui が持つ `shj` との取り決め（`ctl`）・PTY（`term`）・ビルドの情報（`buildinfo`）・メッセージ（`i18n`）です。`docs/design/` は設計の経緯です。

リリースの流れは [docs/releasing.md](docs/releasing.md) にあります。

## ライセンス

MIT
