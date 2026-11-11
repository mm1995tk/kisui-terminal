# kisui-terminal

[English](README.md)

kisui-terminal は、[shijimi-editor](https://github.com/mm1995tk/shijimi-editor) と強く連携する、ターミナル中心の作業環境です。窓を欄に分け、欄にターミナル（その中で `shj`）・動画・画像・PDF・ファイルツリーを置きます。名前の汽水は、しじみがすむ場所です。

shijimi-editor とは別のアプリで、版もリリースも別です。組み合わせを確かめた版の `shj` を同梱し、欄の中のターミナルでは同梱の `shj` を先に使います（自分で入れた `shj` は、kisui-terminal の外では今まで通り使われます）。kisui-terminal と `shj` のやりとりの取り決めは [docs/protocol.md](docs/protocol.md) にあり、コードは共有しません。

## 入れ方

Linux（x86_64 と aarch64）と、Apple シリコン（arm64）の macOS で動きます。Intel の macOS には、アプリとしても ssh 先としても対応しません。版は [Releases](https://github.com/mm1995tk/kisui-terminal/releases) にあります。AppImage と `.dmg` は自動で更新されます。

- **AppImage**：`chmod +x kisui-terminal-linux-*.AppImage` してから起動します。AppImage は 2 週間に 1 回、最新の版に足すので、新しい版にはしばらく `.dmg` だけのことがあります。
- **`.dmg`**：Apple の署名が無いので、macOS は初回に開くのを断ります。`kisui-terminal.app` をアプリケーションに入れて 1 度開き（「確認できません」と出たら閉じます）、**システム設定 → プライバシーとセキュリティ** で `kisui-terminal` についての表示の横にある **このまま開く** を押します。次からは普通に開けます。代わりに `xattr -dr com.apple.quarantine /Applications/kisui-terminal.app` を 1 度だけ実行してもかまいません。アプリは ad-hoc 署名だけなので、更新するたびに、プライバシーとセキュリティで入れた許可（**アプリ管理** など）を入れ直す必要があります。

main の nightly 版は `kisui-terminal-nightly` で、[`nightly` の pre-release](https://github.com/mm1995tk/kisui-terminal/releases/tag/nightly) に置いています（`.dmg` だけです。Linux で nightly 版を使うなら Nix で入れます）。名前と identifier が違うので、普通の版と並べて入れられます。

Nix では、パッケージ `kisui-terminal`（nightly 版は `kisui-terminal-nightly`。同じ名前で入ります）か、home-manager で flake の `homeManagerModules.default` を import して `programs.kisui-terminal.enable = true;` で入れます。Nix で入れた版に自動更新はありません。`nix flake update` で進めます。

```sh
nix run github:mm1995tk/kisui-terminal
nix profile install github:mm1995tk/kisui-terminal
nix profile install github:mm1995tk/kisui-terminal#kisui-terminal-nightly
```

## 使い方

kisui-terminal の中での `shj` の動き（開く欄、動画、URL の開き方、ファイルツリー）は shijimi-editor のマニュアルにあります。[ターミナル](https://mm1995tk.github.io/shijimi-editor/manual/ja/terminal/)・[ブラウザ](https://mm1995tk.github.io/shijimi-editor/manual/ja/browser/)・[設定ファイル](https://mm1995tk.github.io/shijimi-editor/manual/ja/config/)（「kisui-terminal のマシン」と `[server]`）を見てください。

欄の中で `kisui open <ファイル|URL>` を打つと、種類に合う欄に、同じワークスペースの中で開きます。動画・画像・PDF（拡張子で見分け、拡張子で分からなければファイルの頭の中身で見分ける）のファイルです。同じ種類の欄が開いていれば入れ替えます。`http`・`https` の URL は欄にせず、kisui-terminal が動いている手元のブラウザ（OS 既定のブラウザ）で開きます（`shj` の `:open-url` と同じ）。ssh 先のマシンの `localhost` の URL は、kisui-terminal が張る ssh のポート転送越しに開くので、ssh 先のページが見えます。ssh 先のマシンの欄でも使えます。使えるのは kisui-terminal の欄の中だけで、ほかのシェルから打つと断ります。コマンドの一覧は `kisui --help` で出ます。

```sh
kisui open ./diagram.png
kisui open ./talk.mp4
kisui open ./paper.pdf
kisui open https://example.com/
```

`kisui notify <文>` は、窓の動いているコンピュータ（手元）にデスクトップ通知を出します。長いコマンドの終わりを知るのに使えます。`kisui clipboard copy` は標準入力の文を手元のクリップボードに入れ、`kisui clipboard paste` は手元のクリップボードの文を標準出力に出します。手元のクリップボードを読まれるのは危ないので、`paste` のたびに kisui-terminal が許すかを聞き、許したときだけ出します。3 つとも ssh 先のマシンの欄でも同じように使えます。

```sh
make build; kisui notify "build: $?"
echo hello | kisui clipboard copy
kisui clipboard paste > note.txt
```

欄のシェルでは、`pbcopy` と `pbpaste` もそれぞれ `kisui clipboard copy` と `kisui clipboard paste` を呼びます（`echo hello | pbcopy`）。`pbpaste` も読むたびに許すかを聞きます。ssh 先のマシンの欄でも同じです。kisui-terminal は zsh・bash・fish の起動ファイルを読んだあとに、この 2 つを置いたフォルダを `PATH` の先頭に入れるので、macOS の `pbcopy` より先になり、スクリプトの中から呼んでも同じに動きます。ユーザーの起動ファイルは書き換えません。ほかのシェルでは `PATH` の先頭に足すだけなので、起動ファイルが `PATH` を組み直すと macOS の `pbcopy` が先になることがあります。

kisui-terminal は、手元のクリップボードにコピーした文の履歴を持ちます。kisui-terminal の中のコピーも、ほかのアプリ（ブラウザなど）でのコピーも入ります。新しい 20 件を 12 時間残し、データのディレクトリ（macOS は `~/Library/Application Support/dev.mm1995tk.kisui-terminal`、Linux は `~/.local/share/dev.mm1995tk.kisui-terminal`）の `clipboard-history.json`（自分だけが読めるファイル）に保存するので、閉じても消えません。パスワード管理アプリが「秘密」の印を付けたコピーと、画像は入れません。

`Cmd+Shift+H`（macOS）か `Ctrl+Shift+H`（Linux）で、履歴を新しい順の一覧で開きます。文字を打つと絞り込め、上下キーで選び、`Enter` で打っていた欄に貼り、`Shift+Enter` でクリップボードに戻します。`Esc` は何もせずに閉じます。

kisui-terminal の外（ほかのアプリを使っているとき）でも、`Option+Space`（macOS）か `Alt+Space`（Linux）で、履歴の小さな窓が前に出ます。kisui-terminal のメインの窓は前に出ません。上下キーで選んで `Enter` を押すと、その文をクリップボードに戻し、窓を閉じて前に使っていたアプリに戻るので、`Cmd+V`（Linux は `Ctrl+V`）で貼ります。kisui-terminal からは貼る操作を送らないので、macOS のアクセシビリティの許可は要りません。`Esc` は何もせずに閉じて前のアプリに戻ります。使えるのは kisui-terminal が起動している間だけです。Linux では、`Alt+Space` をウィンドウマネージャー（GNOME や KDE の窓のメニューなど）が先に取っていると届きません。そのときは、ウィンドウマネージャーの側でそのキーを外してください。Wayland のセッションでは全体のキーを取れないことがあります（X11 のアプリを使っている間だけ届くことがあります）。

`kisui pane split --right` / `--down` は、打った欄を右か下に分け、新しい欄にフォーカスを移します。後ろにコマンドを付けると、新しい欄ではシェルの代わりにそのコマンドを動かします（`kisui pane split --down htop`）。コマンドが終わると欄も閉じるので、短いコマンドの出力を残したいときは、シェルに動かさせて最後にシェルを残します（`kisui pane split --down sh -c "ls; exec sh"`）。分けた後の欄が 20 列・5 行より小さくなるときは、キーで分けるときと同じく断ります。`kisui pane title <名前>` は、欄の上の細い帯に名前を出します（空の名前なら外します）。名前は serve が持つので、ウィンドウを開き直しても残ります。

```sh
kisui pane split --right
kisui pane split --down npm run dev
kisui pane title build
```

kisui-terminal の設定は `shj` と同じ `config.toml`（`~/.config/shijimi-editor/config.toml`。nightly 版は `shijimi-editor-nightly/`）に書きます。

- `[[gui.machines]]`：サイドバーに出すマシン（`ssh = "dev-vm"`、`name = "dev"`）。
- 画面の URL（波線が引かれる）は、`cmd + click` か `cmd + shift + click`（macOS 以外は `ctrl + click` か `ctrl + shift + click`）で、OS 既定のブラウザで開きます。開くのは http と https の URL だけです。リモート（ssh）のマシンのターミナルに出た `localhost` 系の URL は、手元のブラウザだと手元の localhost に行ってしまうため、ssh のポート転送を張って転送先の URL を開きます。アプリがマウスの報告を有効にしている間（vim・tmux・htop・`shj` など）は、shift なしのクリックはアプリに届くので、`cmd + shift + click` を使います。以前の版の `[gui]` の `url_open` は無視します。
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
