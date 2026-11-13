# kisui-terminal

[English](README.md)

kisui-terminal は、[shijimi-editor](https://github.com/mm1995tk/shijimi-editor) と強く連携する、ターミナル中心の作業環境です。窓をペインに分け、ペインにターミナル（その中で `shj`）・動画・画像・PDF・ファイルツリーを置きます。名前の汽水は、しじみがすむ場所です。

shijimi-editor とは別のアプリで、版もリリースも別です。組み合わせを確かめた版の `shj` を同梱し、ペインの中のターミナルでは同梱の `shj` を先に使います（自分で入れた `shj` は、kisui-terminal の外では今まで通り使われます）。kisui-terminal と `shj` のやりとりの取り決めは [docs/protocol.md](docs/protocol.md) にあり、コードは共有しません。

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

kisui-terminal の中での `shj` の動き（開くペイン、動画、URL の開き方、ファイルツリー）は shijimi-editor のマニュアルにあります。[ターミナル](https://mm1995tk.github.io/shijimi-editor/manual/ja/terminal/)・[ブラウザ](https://mm1995tk.github.io/shijimi-editor/manual/ja/browser/)・[設定ファイル](https://mm1995tk.github.io/shijimi-editor/manual/ja/config/)（「kisui-terminal のマシン」と `[server]`）を見てください。

ペインの中で `kisui open <ファイル|URL>` を打つと、画像は打ったペインのカーソルの位置にそのまま出ます（kitty の `icat` と同じ。kitty の画像のプロトコルで端末に書き出すので、ssh 先のマシンのペインでも出ます。PNG・JPEG・GIF（最初のコマ）・WebP・BMP で、ペインの幅までの大きさ）。ほかのファイルは、種類に合うペインに、同じワークスペースの中で開きます。動画・PDF（拡張子で見分け、拡張子で分からなければファイルの頭の中身で見分ける）です。同じ種類のペインが開いていれば入れ替えます。`kisui open --pane <画像>` なら、画像も別のペインに開きます。SVG・AVIF の画像、16 MB か 10000 ピクセルを超える画像、標準出力が端末でないとき（パイプ、コーディングエージェントのシェル）の画像は、`--pane` が無くてもペインに開きます。`http`・`https` の URL はペインにせず、kisui-terminal が動いている手元のブラウザ（OS 既定のブラウザ）で開きます（`shj` の `:open-url` と同じ）。ssh 先のマシンの `localhost` の URL は、kisui-terminal が張る ssh のポート転送越しに開くので、ssh 先のページが見えます。ssh 先のマシンのペインでも使えます。使えるのは kisui-terminal のペインの中だけで、ほかのシェルから打つと断ります。コマンドの一覧は `kisui --help` で出ます。

```sh
kisui open ./diagram.png         # このペインに出す
kisui open --pane ./diagram.png  # 別のペインに出す
kisui open ./talk.mp4
kisui open ./paper.pdf
kisui open https://example.com/
```

`kisui notify <文>` は、窓の動いているコンピュータ（手元）にデスクトップ通知を出します。長いコマンドの終わりを知るのに使えます。`kisui clipboard copy` は標準入力の文を手元のクリップボードに入れ、`kisui clipboard paste` は手元のクリップボードの文を標準出力に出します。手元のクリップボードを読まれるのは危ないので、`paste` のたびに kisui-terminal が許すかを聞き、許したときだけ出します。3 つとも ssh 先のマシンのペインでも同じように使えます。

```sh
make build; kisui notify "build: $?"
echo hello | kisui clipboard copy
kisui clipboard paste > note.txt
```

ペインのシェルでは、`pbcopy` と `pbpaste` もそれぞれ `kisui clipboard copy` と `kisui clipboard paste` を呼びます（`echo hello | pbcopy`）。`pbpaste` も読むたびに許すかを聞きます。ssh 先のマシンのペインでも同じです。kisui-terminal は zsh・bash・fish の起動ファイルを読んだあとに、この 2 つを置いたフォルダを `PATH` の先頭に入れるので、macOS の `pbcopy` より先になり、スクリプトの中から呼んでも同じに動きます。ユーザーの起動ファイルは書き換えません。ほかのシェルでは `PATH` の先頭に足すだけなので、起動ファイルが `PATH` を組み直すと macOS の `pbcopy` が先になることがあります。

kisui-terminal は、手元のクリップボードにコピーした文の履歴を持ちます。kisui-terminal の中のコピーも、ほかのアプリ（ブラウザなど）でのコピーも入ります。新しい 20 件を 12 時間残し、データのディレクトリ（macOS は `~/Library/Application Support/dev.mm1995tk.kisui-terminal`、Linux は `~/.local/share/dev.mm1995tk.kisui-terminal`）の `clipboard-history.json`（自分だけが読めるファイル）に保存するので、閉じても消えません。パスワード管理アプリが「秘密」の印を付けたコピーと、画像は入れません。

`Cmd+Shift+H`（macOS）か `Ctrl+Shift+H`（Linux）で、履歴を新しい順の一覧で開きます。文字を打つと絞り込め、上下キー（か `Ctrl+J` / `Ctrl+K`）で選び、`Enter` で打っていたペインに貼り、`Shift+Enter` でクリップボードに戻します。`Esc` は何もせずに閉じます。

kisui-terminal の外（ほかのアプリを使っているとき）でも、`Option+Space`（macOS）か `Alt+Space`（Linux）で、履歴の小さな窓が前に出ます。kisui-terminal のメインの窓は前に出ません。上下キー（か `Ctrl+J` / `Ctrl+K`）で選んで `Enter` を押すと、その文をクリップボードに戻し、窓を閉じて前に使っていたアプリに戻るので、`Cmd+V`（Linux は `Ctrl+V`）で貼ります。kisui-terminal からは貼る操作を送らないので、macOS のアクセシビリティの許可は要りません。`Esc` は何もせずに閉じて前のアプリに戻ります。使えるのは kisui-terminal が起動している間だけです。Linux では、`Alt+Space` をウィンドウマネージャー（GNOME や KDE の窓のメニューなど）が先に取っていると届きません。そのときは、ウィンドウマネージャーの側でそのキーを外してください。Wayland のセッションでは全体のキーを取れないことがあります（X11 のアプリを使っている間だけ届くことがあります）。

`kisui pane split --right` / `--down` は、打ったペインを右か下に分け、新しいペインにフォーカスを移します。後ろにコマンドを付けると、新しいペインではシェルの代わりにそのコマンドを動かします（`kisui pane split --down htop`）。コマンドが終わるとペインも閉じるので、短いコマンドの出力を残したいときは、シェルに動かさせて最後にシェルを残します（`kisui pane split --down sh -c "ls; exec sh"`）。分けた後のペインが 20 列・5 行より小さくなるときは、キーで分けるときと同じく断ります。`kisui pane title <名前>` は、ペインの上の細い帯に名前を出します（空の名前なら外します）。名前は serve が持つので、ウィンドウを開き直しても残ります。

```sh
kisui pane split --right
kisui pane split --down npm run dev
kisui pane title build
```

`kisui update` は、アプリに新しい版を今すぐ調べ直させます。アプリを閉じて開き直さなくてすみます（何もしなければ、調べるのは起動したときの 1 回だけです）。新しい版があれば、起動したときと同じ「新しい版があります」の知らせを出します（「あとで」で閉じていても、出し直します）。「更新して再起動」の動きは、その知らせと同じで、ペインのシェルは残ります（serve が引き継ぎます）。`kisui update` は、アプリが見つけたことを出します。新しい版がある、最新である、この版は自動更新を持たない（Nix で入れた版と、AppImage でない Linux。`nix flake update` で更新するか、新しい版を入れ直す）のどれかです。ssh 先のマシンのペインでも使えます。調べて知らせを出すのは手元のアプリです。使い方は `kisui update --help` で出ます。

`kisui skill install [フォルダ]` は、Claude Code などのコーディングエージェントに、ペインの中での `kisui open`・`kisui notify`・`kisui clipboard`・`kisui pane` の使い方を教える skill（`SKILL.md`）を書き出します。フォルダを省くと `~/.claude/skills/kisui-terminal/` に書きます。skill は `kisui` のバイナリに入っているので、入れた版に合った内容になります。`kisui clipboard paste` は勝手に呼ばないよう、skill に書いてあります。

```sh
kisui skill install
kisui skill install ./my-skills/kisui-terminal
```

kisui-terminal の設定は `shj` と同じ `config.toml`（`~/.config/shijimi-editor/config.toml`。nightly 版は `shijimi-editor-nightly/`）に書きます。

- `[[gui.machines]]`：サイドバーに出すマシン（`ssh = "dev-vm"`、`name = "dev"`）。
- 画面の URL（波線が引かれる）は、`cmd + click` か `cmd + shift + click`（macOS 以外は `ctrl + click` か `ctrl + shift + click`）で、OS 既定のブラウザで開きます。開くのは http と https の URL だけです。リモート（ssh）のマシンのターミナルに出た `localhost` 系の URL は、手元のブラウザだと手元の localhost に行ってしまうため、ssh のポート転送を張って転送先の URL を開きます。アプリがマウスの報告を有効にしている間（vim・tmux・htop・`shj` など）は、shift なしのクリックはアプリに届くので、`cmd + shift + click` を使います。以前の版の `[gui]` の `url_open` は無視します。
- `[server]`：`idle_stop_days`（窓がつながっていない状態で `kisui serve` が待つ日数。既定 7、0 は止めない）と `start_dir`（新しいワークスペースのシェルを始めるフォルダ）。
- `ui-language`：kisui 自身のメッセージの言語（`shj` と同じ項目）。

ssh 先では、kisui-terminal は聞いてから自分の `kisui` と `shj` を `~/.cache/kisui-terminal/<版>/` に入れます。その先の PATH の `shj` には触りません。

### キー操作

キーを覚えなくても使えます。リーダー（macOS は `Cmd+K`、Linux は `Ctrl+Shift+K`）を押すと、次に押せるキーが、その動きといっしょに窓の左下に出ます。押すと動くか、一段下のグループに入ります。`Backspace` は一段戻り、`Esc`（かリーダーをもう 1 度）で出て、`?` で全部のキーを一覧で見られます。一覧に無いキーは捨てて出るので、うっかり押した字がシェルに入ることはありません。`shj` には自分のキー（`Space` など）があり、ペインの中では今までどおり届きます。kisui-terminal が受けるのは、リーダーと下の近道だけで、`Ctrl` と字、`Alt` と字だけのキーは取りません。

| リーダーのあとのキー | 動き                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `h` `j` `k` `l`      | 左・下・上・右のペインへ移る（続けて押せる）。`Tab` は直前にいたペインへ戻る                                       |
| `w`                  | ワークスペース：`j` `k` はサイドバーの次・前のワークスペース（マシンをまたぐ。端で止まる。続けて押せる）、`h` `l` は前・次のマシン（そのマシンで最後に使ったワークスペース、無ければ先頭。ワークスペースが無いマシンにも止まり、`m` や `n` はそのマシンに行う）、`1`〜`9` はサイドバーの上から n 番目、`n` は今のマシンに作る、`x` は閉じる、`Tab` は直前のワークスペースへ戻る |
| `m`                  | マシン（今のワークスペースのマシン）：`a` 足す、`n` 名前を変える、`d` 一覧から外す、`x` 切る、`r` つなぎ直す |
| `p`                  | ペイン：`v` 右に分ける、`s` 下に分ける、`x` 閉じる、`z` プライマリ以外を隠す・戻す、`r` 大きさを変える（`h` `j` `k` `l` も同じ） |
| `b`                  | サイドバーを開け閉めする（閉じるのは、このキーを押したときだけ。ファイルツリーか CHANGES にフォーカスが移る（`shj` の `Space e`・`Space E` など）と、閉じていても開く（`shj` を起動した直後の自動のフォーカスでは開かない）。開け閉めは覚えておく） |
| `y`                  | クリップボードの履歴                                                                                       |
| `v`                  | 表示の大きさ：`+` 大きく、`-` 小さく、`0` 元に戻す                                                          |
| `n`                  | お知らせ：`a` いちばん下のお知らせの主のボタンを押す、`d` 閉じる、`g` 最後に OS の通知を出したペインを前に出す |

リーダーを通さずに押せる近道もあります（`?` の一覧に、使っている OS のものが出ます）。`Cmd+Shift+W` / `Ctrl+Shift+W` と `Cmd+Shift+P` / `Ctrl+Shift+P` は、ワークスペースとペインのグループに 1 回で入ります。`Cmd+D` / `Ctrl+Shift+D` と `Cmd+Shift+D` / `Ctrl+Shift+E` はペインを分け、`Cmd+R` / `Ctrl+Shift+R` は大きさを変え、`Cmd+Shift+Enter` / `Ctrl+Shift+M` はほかのペインを隠し、`Cmd+Shift+H` / `Ctrl+Shift+H` はクリップボードの履歴、`Cmd+=` `Cmd+-` `Cmd+0`（Linux は `Ctrl+=` `Ctrl+0`）は表示の大きさを変えます。macOS では `Cmd+1`〜`Cmd+9` でワークスペースを選び、`Cmd+W` でペインを閉じます。次のキーは、`shj` やシェルが使うので、なくなりました。`Ctrl+Shift+矢印` と `Cmd+Option+矢印`（ペインの移動。リーダーを使います）、macOS の `Ctrl+Shift+M`、Linux の `Ctrl+-`（表示を小さくする。リーダーを使います）。

画像のペイン（`kisui open --pane` で開いたものと、`shj` から開いたもの）では、ペインにフォーカスがあるあいだ次のキーが効きます（リーダーには載せていません。`?` の一覧に出ます）。`+` / `=` で拡大、`-` で縮小、`0` でペインに収まる大きさに戻し、拡大中は `h` `j` `k` `l` か矢印で見える場所を動かし、`Esc` でターミナルへ戻ります。マウスでは、`Ctrl` + ホイールかトラックパッドのピンチで（ポインタの位置を中心に）拡大・縮小し、拡大中はドラッグで動かせます。画面全体の大きさを変えるキー（`Cmd+=` など）は修飾キーが付くので、重なりません。

ファイルツリー・変更一覧・動画のペインにも、フォーカスがあるあいだだけ効くその場所のキーがあります。そこで `?` を押すとその一覧が出ます（リーダーの `?` も、フォーカスがある場所のキーを、リーダーのキーの上に出します）。ファイルツリーでは、`c` で名前をコピー、`m` で「ここへ移動」（ターミナルで cd。フォルダの行だけ）、`.` か Menu キーで、選んでいる行に右クリックのメニューを開きます。これらは今まで右クリックのメニューにしかありませんでした。ダイアログの一覧（クリップボードの履歴、リモートを足すときの候補）では、`↓` `↑` と同じに、`Ctrl+J` / `Ctrl+K` で次・前の行を選べます。

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

`tauri dev` では、ペインの中のターミナルは PATH の `shj` を使います。配るアプリは自分の `shj` を同梱します（`packaging/`）。

置き場：`app/` が窓（`src/` に Solid + TypeScript、`src-tauri/` に Tauri の殻）、`cmd/kisui` と `server/`・`attach/`・`rpc/`・`config/` が `kisui`（Go）、`internal/` は kisui が持つ `shj` との取り決め（`ctl`）・PTY（`term`）・ビルドの情報（`buildinfo`）・メッセージ（`i18n`）です。`docs/design/` は設計の経緯です。

リリースの流れは [docs/releasing.md](docs/releasing.md) にあります。

## ライセンス

MIT
