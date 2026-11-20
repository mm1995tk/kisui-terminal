# kisui-terminal

[English](README.md)

kisui-terminal は、[shijimi-editor](https://github.com/mm1995tk/shijimi-editor) と強く連携する、ターミナル中心の作業環境です。窓をペインに分け、ペインにターミナル（その中で `shj`）・動画・画像・PDF・ファイルツリーを置きます。名前の汽水は、しじみがすむ場所です。

shijimi-editor とは別のアプリで、版もリリースも別です。組み合わせを確かめた版の `shj` を同梱し、ペインの中のターミナルでは同梱の `shj` を先に使います（自分で入れた `shj` は、kisui-terminal の外では今まで通り使われます）。kisui-terminal と `shj` のやりとりの取り決めは [docs/protocol.md](docs/protocol.md) にあり、コードは共有しません。

## 入れ方

Linux（x86_64 と aarch64）と、Apple シリコン（arm64）の macOS で動きます。Intel の macOS には、アプリとしても ssh 先としても対応しません。版は [Releases](https://github.com/mm1995tk/kisui-terminal/releases) にあります。AppImage と `.dmg` は自動で更新されます。

- **AppImage**：`chmod +x kisui-terminal-linux-*.AppImage` してから起動します。AppImage は 2 週間に 1 回、最新の版に足すので、新しい版にはしばらく `.dmg` だけのことがあります。
- **`.dmg`**：Apple の署名が無いので、macOS は初回に開くのを断ります。`kisui-terminal.app` をアプリケーションに入れて 1 度開き（「確認できません」と出たら閉じます）、**システム設定 → プライバシーとセキュリティ** で `kisui-terminal` についての表示の横にある **このまま開く** を押します。次からは普通に開けます。代わりに `xattr -dr com.apple.quarantine /Applications/kisui-terminal.app` を 1 度だけ実行してもかまいません。アプリは ad-hoc 署名だけなので、更新するたびに、プライバシーとセキュリティで入れた許可（**アプリ管理** など）を入れ直す必要があります。

main の nightly 版は `kisui-terminal-nightly` で、[`nightly` の pre-release](https://github.com/mm1995tk/kisui-terminal/releases/tag/nightly) に置いています（`.dmg` だけです。Linux で nightly 版を使うなら Nix で入れます）。名前と identifier が違うので、普通の版と並べて入れられます。

Nix では、パッケージ `kisui-terminal`（nightly 版は `kisui-terminal-nightly`。同じ名前で入ります）か、home-manager で flake の `homeManagerModules.default` を import して `programs.kisui-terminal.enable = true;` で入れます。Nix で入れた版に自動更新はありません。`nix flake update` で進めます。アプリは別の方法で入れ（macOS の .dmg など）、設定だけを home-manager で置くときは、`programs.kisui-terminal.package = null;` と書きます（パッケージを入れません）。設定を置くフォルダは `programs.kisui-terminal.channel` で選びます（`"stable"` なら `~/.config/kisui-terminal/`、`"nightly"` なら `~/.config/kisui-terminal-nightly/`。書かなければ、パッケージがあるときはパッケージの名前で、`package = null` のときは `"stable"` で決まります。パッケージと食い違う `channel` は、評価の時点でエラーになります）。例: `programs.kisui-terminal = { enable = true; package = null; channel = "nightly"; settings = { /* ... */ }; };`

```sh
nix run github:mm1995tk/kisui-terminal
nix profile install github:mm1995tk/kisui-terminal
nix profile install github:mm1995tk/kisui-terminal#kisui-terminal-nightly
```

## 使い方

kisui-terminal の中での `shj` の動き（開くペイン、動画、URL の開き方、ファイルツリー）は shijimi-editor のマニュアルにあります。[ターミナル](https://mm1995tk.github.io/shijimi-editor/manual/ja/terminal/)・[ブラウザ](https://mm1995tk.github.io/shijimi-editor/manual/ja/browser/)・[設定ファイル](https://mm1995tk.github.io/shijimi-editor/manual/ja/config/)を見てください。

ペインの中で `kisui open <ファイル|URL>` を打つと、画像は打ったペインのカーソルの位置にそのまま出ます（kitty の `icat` と同じ。kitty の画像のプロトコルで端末に書き出すので、ssh 先のマシンのペインでも出ます。PNG・JPEG・GIF（最初のコマ）・WebP・BMP で、ペインの幅までの大きさ）。ほかのファイルは、種類に合うペインに、同じワークスペースの中で開きます。動画・PDF（拡張子で見分け、拡張子で分からなければファイルの頭の中身で見分ける）です。同じ種類のペインが開いていれば入れ替えます。`kisui open --pane <画像>` なら、画像も別のペインに開きます。SVG・AVIF の画像、16 MB か 10000 ピクセルを超える画像、標準出力が端末でないとき（パイプ、コーディングエージェントのシェル）の画像は、`--pane` が無くてもペインに開きます。`http`・`https` の URL はペインにせず、kisui-terminal が動いている手元のブラウザで開きます。内蔵ブラウザを使っていれば（下の `[gui.browser]`）ワークスペースの新しいタブで、使っていなければ OS 既定のブラウザで開きます。`shj` が開くよう頼んだ URL も同じです。ssh 先のマシンの `localhost` の URL は、kisui-terminal が普通の ssh のセッションの上で張る中継（ssh 先の `kisui relay`）越しに開くので、ssh 先のページが見えます（ssh のポート転送は使わないので、ポート転送を断る環境でも開けます）。ssh 先のマシンのペインでも使えます。使えるのは kisui-terminal のペインの中だけで、ほかのシェルから打つと断ります。コマンドの一覧は `kisui --help` で出ます。

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

kisui-terminal の外（ほかのアプリを使っているとき）でも、`Option+Space`（macOS）か `Alt+Space`（Linux）で、履歴の小さな窓が前に出ます。kisui-terminal のメインの窓は前に出ません。上下キー（か `Ctrl+J` / `Ctrl+K`）で選んで `Enter` を押すと、その文をクリップボードに戻し、「コピーしました」を少し出してから窓を閉じて前に使っていたアプリに戻るので、`Cmd+V`（Linux は `Ctrl+V`）で貼ります。kisui-terminal からは貼る操作を送らないので、macOS のアクセシビリティの許可は要りません。`Esc` は何もせずに閉じて前のアプリに戻ります。使えるのは kisui-terminal が起動している間だけです。Linux では、`Alt+Space` をウィンドウマネージャー（GNOME や KDE の窓のメニューなど）が先に取っていると届きません。そのときは、ウィンドウマネージャーの側でそのキーを外してください。Wayland のセッションでは全体のキーを取れないことがあります（X11 のアプリを使っている間だけ届くことがあります）。

`kisui pane split --right` / `--down` / `--left` / `--up` は、打ったペインを右・下・左・上に分け、新しいペインにフォーカスを移します。後ろにコマンドを付けると、新しいペインではシェルの代わりにそのコマンドを動かします（`kisui pane split --down htop`）。コマンドが終わるとペインも閉じるので、短いコマンドの出力を残したいときは、シェルに動かさせて最後にシェルを残します（`kisui pane split --down sh -c "ls; exec sh"`）。分けた後のペインが 20 列（`--right`・`--left`）・5 行（`--down`・`--up`）より小さくなるときは、キーで分けるときと同じく断ります。`kisui pane title <名前>` は、ペインの上の細い帯に名前を出します（空の名前なら外します）。名前は serve が持つので、ウィンドウを開き直しても残ります。名前は 1 つのマシン（1 つの `kisui serve`）の中で重なりません。どのワークスペース・タブのものでも、ほかのペインが使っている名前は断ります。ペインの id の形の名前（`t` と数字。`t3` など）も断ります。`kisui pane split` に `--name <名前>` を付けると、新しいペインにその名前を付けます（`kisui pane split --right --name dev`）。`kisui pane list` は、このマシンの全部のペインを（どのワークスペース・タブのものも）一覧にします。id・名前・タブ・フォルダ（cwd）・プログラムが付けたタイトルを出し、打ったペインに `*` を付けます。`kisui pane list --json` は同じものを、プログラム（やエージェント）が読む JSON で出します。`kisui pane send <名前|id> <文字>` は、名前か id で指したこのマシンのペイン（どのワークスペース・タブのものでも）に文字を打ち、Enter を押します。`kisui pane keys <名前|id> <キー>...` はそのペインでキーを押します（`esc`・`ctrl+c`・`up`・`enter` など。`kisui pane keys --help` で一覧を出します）。`kisui pane close <名前|id>` はそのペインを閉じます。どれもフォーカスは移らないので、あるペインのエージェントが、新しいペインで別のエージェントを起動して指示を送れます。ペインのプログラムが bracketed paste を有効にしていれば（多くのシェルとエージェントはしています）、文字は貼り付けとして送るので、何行もの文字が 1 つにまとまって届きます。文字の中の改行は Enter になります。`send` は、相手のプログラムの処理が終わるのを待ちません。タブのプライマリのペインは `kisui pane close` では閉じず、タブといっしょに閉じます。

```sh
kisui pane split --right
kisui pane split --down npm run dev
kisui pane title build
kisui pane split --down --name dev npm run dev
kisui pane list --json
kisui pane send build "make test"
kisui pane keys build ctrl+c
kisui pane close dev
kisui pane open --workspace review --name reviewer -- claude
```

`kisui pane read <名前|id>` は、名前か id で指したこのマシンのペイン（どのワークスペース・タブのものでも）の画面の字を出します。あるペインのエージェントが、別のペインのエージェントやコマンドが出しているものを見られます。`--lines <数>` を付けると、画面の上の scrollback もその行数だけ出します（serve が持つ 5000 行まで）。出すのは字だけで、色は付きません。端末が折り返した行は 1 行にして出し、行末の空白と、画面の下の何も無い行は出しません。全画面のプログラム（`shj` や `htop` など）は scrollback の無い画面に描くので、そこでは `--lines` を付けても増えません。プログラムがとても速く大量に出力すると（`yes` のように、serve が追いつけない分が約 4 MB を超えると）、serve は追いつけなかった分を捨てるので、プログラムが画面を描き直すまでは、その後に出た分しか出ません。

`kisui pane open --workspace <ワークスペース> [--new] --name <名前> [--cwd <フォルダ>] [-- コマンド ...]` は、ウィンドウのワークスペース（サイドバーに出ている名前で指します。`review`・`ws2` など）の最後にターミナルのタブを足し、そこでコマンド（無ければシェル）を動かし、タブのペインに名前を付けます。あるペインのエージェントが、別のワークスペースで別のエージェントを起動し、`kisui pane send` と `kisui pane read` で使えます（`kisui pane open --workspace review --name reviewer -- claude`）。`--new` を付けると、その名前のワークスペースを新しく作ります。`--new` が無いときは、その名前のワークスペースが無いか、2 つ以上あれば断ります。`--new` があるときは、その名前のワークスペースがもうあれば断ります。タブは打ったペインのマシンにでき、`--cwd`（書かなければ今のフォルダ）で始まります。フォーカスは移りません。名前は `kisui pane title` と同じ決まりで、ほかのペインが使っていれば、タブを作らずに断ります。コマンドはタブのプライマリのペインで動くので、コマンドが終わってもペインは出力を残したまま残ります（`kisui pane close` では閉じません。タブを閉じます）。ワークスペースはウィンドウが持つので、ウィンドウが閉じていれば理由を出して失敗します。

```sh
kisui pane read build
kisui pane read t5 --lines 200
```

`--machine <マシン>` を付けると、`kisui pane list`・`send`・`keys`・`close`・`read`・`open` が別のマシンのペインに効きます。マシンは、`[[gui.machines]]` の名前（名前が無ければ ssh の行き先）で指すか、`local` と書きます。`local` は常に、ウィンドウの動く手元の PC です。ssh 先のマシンのペインのエージェントが手元の PC のペインに、その逆にも届きます（`kisui pane send --machine local foo 'echo hi'`・`kisui pane read --machine dev bar`）。マシンの serve は自分のペインしか知らないので、全部のマシンにつながっているウィンドウが頼みを中継します。ウィンドウが閉じているときや、そのマシンにつながっていないときは、理由を出して失敗します。`kisui pane open --machine` のタブは、そのマシンのターミナルです。`--cwd` とコマンドは、そのマシンの絶対パスで書きます（`--cwd` が無ければ、そのマシンの始めのフォルダで始まります）。または、シェルを開いて `kisui pane send` でコマンドを始めます。別のマシンへの操作でも、kisui-terminal は確認を出しません。どこで何をするかは全部コマンドの引数に出ているので、それを動かすエージェントの権限の決まりで判断できます。名前が `local` のマシン（`[[gui.machines]]` のものか、この版より前にウィンドウで足したもの）は `--machine` で選べず、別の名前を付けるようお知らせが出ます。

```sh
kisui pane list --machine dev
kisui pane open --machine dev --workspace review --name reviewer --cwd /home/me/repo
kisui pane send --machine dev reviewer claude
kisui pane read --machine dev reviewer
```

`kisui update` は、アプリに新しい版を今すぐ調べ直させます。アプリを閉じて開き直さなくてすみます（何もしなければ、調べるのは起動したときの 1 回だけです）。新しい版があれば、起動したときと同じ「新しい版があります」の知らせを出します（「あとで」で閉じていても、出し直します）。「更新して再起動」の動きは、その知らせと同じで、ペインのシェルは残ります（serve が引き継ぎます）。`kisui update` は、アプリが見つけたことを出します。新しい版がある、最新である、この版は自動更新を持たない（Nix で入れた版と、AppImage でない Linux。`nix flake update` で更新するか、新しい版を入れ直す）のどれかです。ssh 先のマシンのペインでも使えます。調べて知らせを出すのは手元のアプリです。使い方は `kisui update --help` で出ます。

`kisui skill install [フォルダ]` は、Claude Code などのコーディングエージェントに、ペインの中での `kisui open`・`kisui notify`・`kisui clipboard`・`kisui pane` の使い方を教える skill（`SKILL.md`）を書き出します。フォルダを省くと `~/.claude/skills/kisui-terminal/` に書きます。skill は `kisui` のバイナリに入っているので、入れた版に合った内容になります。`kisui clipboard paste` は勝手に呼ばないよう、skill に書いてあります。

```sh
kisui skill install
kisui skill install ./my-skills/kisui-terminal
```

kisui-terminal の設定は、kisui-terminal 自身の設定のフォルダの `config.toml` と `config.local.toml` に書きます。フォルダは `~/.config/kisui-terminal/`（nightly 版は、あれば `kisui-terminal-nightly/`。`$XDG_CONFIG_HOME` が絶対パスならそちらを使います）。`config.toml` を土台に、`config.local.toml` を上に重ねて読みます。同じ項目は `config.local.toml` が勝ちます。`[server]` のような表は項目ごとに重ね、`[[gui.machines]]` の一覧は、`config.local.toml` にあれば（`[gui]` の `machines = []` も）`config.toml` の一覧を丸ごと置き換えます。どちらのファイルも無くてかまいません。読むのはこの 2 つだけで、`config.nix` は読みません。kisui-terminal 自身が設定を書くときは `config.local.toml` に書き、`config.toml` には書きません。`shj` の設定（`~/.config/shijimi-editor/`）は読みません（`ui-language` も）。home-manager では、この flake のモジュールの `programs.kisui-terminal.settings` に書くと、`config.toml` を作ります。

- `[[gui.machines]]`：マシン（マシンのダイアログ `m` に出て、ワークスペースは切り替えの窓（`w`）に並ぶ。`ssh = "dev-vm"`、`name = "dev"`）。名前は `kisui pane --machine` で指す名前でもある。`local` は、ウィンドウの動く手元の PC を指す予約語。
- `[gui.browser]`：`enabled = true` で内蔵ブラウザを使います（既定は使わない。使わなければ何も変わりません）。ワークスペースごとにブラウザのタブを持てます。タブはサイドバーのワークスペースの下に、ターミナルのタブと一緒に開いた順に並び、タブを選ぶと、ペインの場所すべてがそのタブになります（ワークスペースを選ぶと、そのワークスペースが最後に出していたものが出ます）。名前を付けたタブは、ページの題の代わりにその名前を出します。ページは OS の WebView（macOS は WKWebView、Linux は WebKitGTK）なので、DRM の動画は使えず、パスキーは外のブラウザを通してだけ使えます（下の `passkey_sites`）。`o e` で、そのページを OS 既定のブラウザで開けます。ページにキーがあっても、リーダーと近道は効き、ほかのキーはページに届きます。ログイン（Cookie）はすべてのタブで共有し、タブと一緒にディスクに残り、起動し直すと戻ります。タブはデータのディレクトリ（macOS は `~/Library/Application Support/dev.mm1995tk.kisui-terminal`、Linux は `~/.local/share/dev.mm1995tk.kisui-terminal`）の `browser-tabs.json`、ログインは Linux ではそこの `browser/`、macOS では WebView 自身の置き場に残ります。ブックマーク（`o b` で足し、`o B` で一覧）はすべてのワークスペースで共有し、同じ場所の `browser-bookmarks.json` に残ります。手元の Chrome のブックマーク（`Default` プロファイル。macOS は `~/Library/Application Support/Google/Chrome/Default/Bookmarks`、Linux は `~/.config/google-chrome/Default/Bookmarks`）は読むだけで書かず、新しいタブのページと一覧に、kisui-terminal のものの後ろに（`Chrome` の札を付けて）、Chrome と同じフォルダの入れ子で出します（ブックマークバー・その他のブックマーク・モバイルが根で最初から開き、その下のフォルダは閉じています。フォルダは選んで `Enter`、またはクリックで開け閉めします。絞り込むと、当たったブックマークだけを、入っているフォルダを開いて出します）。ページや一覧を開くたびに読み直し、`Ctrl+D` では消えません。Chrome が無ければ何も出さず、エラーにもしません。ワークスペースを閉じると、その下のタブも閉じます。`o N` ではシークレットのタブを開きます。タブだけの、メモリにだけ置くログインを使うので、共有のログインもほかのシークレットのタブのログインも見えず、閉じるとログインは消え、起動し直しても戻りません（サイドバーに「シークレット」の札が付きます）。シークレットのタブでは下の `passkey_sites` は使わず、パスワードと認証アプリのコードでログインできます。ページが新しい窓を開くリンクやスクリプト（`target="_blank"`・`window.open`）は、同じワークスペースの新しいタブで開きます。ログインは開いた元のページと同じで、元のページとのつながり（`window.opener`）も保つので、「GitHub でログイン」などの小窓は元のページに結果を返せます。そのページが自分を閉じると、タブも閉じて元のタブに戻ります。ダウンロードしたファイルは、場所を聞かずにダウンロードのフォルダ（`~/Downloads`）に保存し（同じ名前があれば `名前 (1).拡張子`）、右下のお知らせで知らせます。お知らせから、ファイルを開くこととフォルダを表示することができます（リーダーの `n o` `n f`）。内蔵ブラウザを使っていると、`kisui open <URL>`・`shj` が開くよう頼んだ URL・ターミナルの URL の `cmd + click` は、そのワークスペースの新しいタブで開きます。リモート（ssh）のマシンの `localhost` 系の URL は、下と同じ中継を通してタブで開き、URL の入力欄には中継前の元の URL（`http://localhost:3000/` など）を出します。
- `[gui.browser]` の `passkey_sites`（`enabled = true` のとき）：iCloud キーチェーンや 1Password のパスキーでログインするサイト（`github.com` のような host）を書きます。例：`passkey_sites = ["github.com", "dash.cloudflare.com"]`。WebView ではそれらのパスキーを使えないので、書いたサイトのページがパスキーを求めると、kisui-terminal は同じ URL を Chrome か Firefox（`passkey_browser = "chrome"`（既定）か `"firefox"`）で開きます。そこでログインすると、そのブラウザの kisui-terminal の拡張機能がサイトの Cookie を送り返し、kisui-terminal はそれを内蔵ブラウザに入れて、タブをログインした状態で開き直します。外のブラウザに移るのは一覧に書いたサイトだけで、Cookie を受け取るのも、移ったサイトの分を 10 分以内に 1 回だけです。パスキーの後にまだ手順が続くサイトでは、済んだら拡張機能のボタンを押すと、手でログインを戻せます。パスワード（1Password の拡張機能など）で外のブラウザからログインしたいときや、パスキーを求める前に WebView を止めるサイトでは、そのサイトのページでリーダーの `o s` を押します。kisui-terminal が同じ URL を外のブラウザで開いて同じようにそのサイトを待つので、そこでログインしたら拡張機能のボタンを押します（シークレットのタブでは使えません）。拡張機能は [addons.mozilla.org](https://addons.mozilla.org/addon/kisui-terminal-passkey-login/) から入れます。Chrome ウェブストアには出していません。Chrome では、パッケージ化されていない拡張機能として読み込みます（[docs/browser-extension.md](docs/browser-extension.md)）。一覧を変えたら kisui-terminal を起動し直してください。起動するたびに、使っている Chrome・Chromium・Firefox に native messaging の受け口を登録します。パスワードと認証アプリのコードは、移らずに内蔵ブラウザで入力できます。ログインを localStorage に置くサイトや、ログインを端末に結び付けるサイト（Device Bound Session Credentials。Google など）では使えません。操作の画面の中でパスキーを求める操作は、外のブラウザで行います（GitHub は確認をしばらく覚えるので、外のブラウザで確認したあと内蔵ブラウザで続けられます）。詳しくは [docs/passkey-extension.md](docs/passkey-extension.md) にあります。
- `[gui.browser]`（macOS 14 以上）：内蔵ブラウザは、kisui-terminal が手元の Mac で動かすプロキシ（`127.0.0.1` だけで待ち受けます）を通ります。プロキシはサイトのアドレスを自分で引き、IPv6 に先につなぐので、IPv6 の無い回線で Cloudflare WARP を使っていても、Google にほかの国のサイト（`www.google.com.hk` など）へ移されず、HTTP/3 も使えます。全部のサイトが通り、シークレットのタブと新しい窓のタブも通ります。`localhost` と `127.0.0.1`（下の中継で開くリモートの `localhost`）は通りません。そのため、内蔵ブラウザで初めてタブを開くとき、kisui-terminal はこの Mac だけの鍵と `localhost` 用の証明書を作り、macOS がパスワードを聞いて、証明書をログインのキーチェーンで信頼させます。信頼は用途が SSL、名前が `localhost` のときだけで、証明書は CA ではありません。取り消すと、プロキシ無しで今までどおり使え、作った証明書と鍵を消し、もう聞きません（データのディレクトリの `browser-proxy-declined` を消すと、次の起動で聞き直します）。鍵はファイルに置かず、ログインのキーチェーンに置きます。kisui-terminal を更新したあと、新しい版が鍵を使ってよいかを macOS が聞くことがあります（「常に許可」で、その版では聞かれなくなります）。証明書の有効な長さは 1 年で、切れる 1 か月前に作り直してもう 1 度聞き、古いものを消します（そこで取り消すと、古いものを切れるまで使い、もう聞きません）。証明書の信頼を外し、証明書と鍵を消すには、kisui-terminal を終えてから次のコマンドを動かします（macOS がパスワードを聞きます）。次にタブを開くとき kisui-terminal はまた聞くので、プロキシを使わないなら取り消します。

  ```sh
  # あとで確かめるため、証明書を写しておく
  security find-certificate -c "kisui-terminal browser proxy" -p > /tmp/kisui-browser-proxy.pem
  # その名前の証明書をすべて信頼の設定ごと消し、鍵を消す
  for h in $(security find-certificate -a -c "kisui-terminal browser proxy" -Z | awk '/^SHA-256 hash:/ {print $3}'); do
    security delete-certificate -t -Z "$h"
  done
  security delete-generic-password -s "kisui-terminal browser proxy"
  # 失敗すれば（CSSMERR_TP_NOT_TRUSTED）、信頼は外れている
  security verify-cert -c /tmp/kisui-browser-proxy.pem -p ssl -s localhost
  rm /tmp/kisui-browser-proxy.pem
  ```

- `[gui.sidebar]` の `tabs-height`：`shj` が動いているとき、サイドバーのヘッダーの下を「タブ」「ファイルツリー」「CHANGES」の 3 段に分け、段ごとにその中だけでスクロールします。タブの段が使える高さの上限を、サイドバーの高さに対する %（10〜90 の整数）で書きます（既定は `tabs-height = 40`）。タブが少なければ中身の高さまで縮み、多ければタブの段の中でスクロールします。タブの段とファイルツリーの境目は、ドラッグか、リサイズモード（`p r`、`Tab` でこの境目を選んで `j` `k`）でも動かせます。ダブルクリック（リサイズモードでは `=`）でこの設定の値に戻り、動かした値は起動し直しても残ります。`shj` が動いていないときは、タブがサイドバーの高さを全部使います。タブを足したときや、タブを切り替えたときは、その行が見える所までタブの段をスクロールします。
- `[gui.shortcuts]`：リーダーを通さずに 1 回で押せるキー（近道）を、自分で足せます。`"キー" = "コマンド"` と書きます。たとえば `"Ctrl+Alt+N" = "workspace.new"`、`"Alt+J" = "pane.focus:down"`。キーは、修飾キー（`Cmd`・`Ctrl`・`Shift`・`Alt`。`Cmd`・`Ctrl`・`Alt` のどれかは要ります）を `+` でつなぎ、最後に 1 つのキーを書きます（今使っている OS で押すキーのまま）。コマンドは、リーダーの木の動きの名前です（`pane.focus:left`・`pane.split:right`・`workspace.new`・`workspace.nth:0`（1 番目のワークスペース）・`scale:in`・`clipboard.history` など。一覧は [docs/key-design.md](docs/key-design.md) の 4.3）。同じキーの既定の近道があれば、書いたほうが勝ちます。`"Cmd+D" = "none"` と書くと、既定の近道を消すだけです。リーダーのキーは変わりません。足した近道は、全部のキーの一覧（リーダーの `?`）に出ます。読めないキー・知らないコマンド・同じキーの 2 回書きは、右下のお知らせに出し、その近道だけ使いません。`config.toml` と `config.local.toml` に同じキーがあれば、`config.local.toml` が勝ちます。
- 画面の URL（波線が引かれる）は、`cmd + click` か `cmd + shift + click`（macOS 以外は `ctrl + click` か `ctrl + shift + click`）で開きます。内蔵ブラウザを使っていればワークスペースの新しいタブで、使っていなければ OS 既定のブラウザで開きます。`cmd + option + click`（macOS 以外は `ctrl + alt + click`。`shift` を足しても同じ）は、いつも OS 既定のブラウザで開きます。開くのは http と https の URL だけです。リモート（ssh）のマシンのターミナルに出た `localhost` 系の URL は、手元のブラウザだと手元の localhost に行ってしまうため、ssh の上で中継し（`kisui relay`）、手元のアドレスの URL を開きます。そのポートで誰も待っていなければ、ブラウザを開かずにそう出します。アプリがマウスの報告を有効にしている間（vim・tmux・htop・`shj` など）は、shift なしのクリックはアプリに届くので、`cmd + shift + click`（か `cmd + option + shift + click`）を使います。以前の版の `[gui]` の `url_open` は無視します。
- `[server]`：`idle_stop_days`（窓がつながっていない状態で `kisui serve` が待つ日数。既定 7、0 は止めない）と `start_dir`（新しいワークスペースのシェルを始めるフォルダ）。
- `[[db.connections]]`：`kisui serve` が接続して SQL を実行できる DB（MySQL と PostgreSQL）。`name`・`kind`（`"postgres"` か `"mysql"`）・`host`・`port`・`user`・`database` と、書き込みを DB に断らせる `read-only = true`。接続するマシンに書きます（リモートのマシンなら、そのマシンの `config.toml`）。パスワードはここに書きません：キーチェーン（macOS）か `~/.pgpass`・`~/.my.cnf` から読むか、聞かれたときに入力します。詳しくは [docs/database.md](docs/database.md)。窓の DB のタブはまだ無く、これはその土台です。
- `ui-language`：kisui-terminal の表示の言語です。画面（窓）と `kisui` の両方に効きます（`en` か `ja`。書かない・この 2 つ以外の値のときは英語）。窓は起動時に 1 度だけ読むので、変えたら次に起動したときから変わります。`shj` の同じ名前の項目とは別に書きます。

**キャラクター（実験的）**。リーダーの案内を、キャラクターがターミナルの左端から右下の位置まで押して運んでくるようにできます。キャラクターは kisui-terminal に入っていません。画面を動かすマシンの、`config.toml` と同じフォルダの `mascot/<名前>/`（`~/.config/kisui-terminal/mascot/<名前>/`。nightly 版は、あれば `kisui-terminal-nightly/mascot/`。`$XDG_CONFIG_HOME` が絶対パスならそちらを使います）に、キャラクターごとに `mascot.toml` と画像（背景が透明な右向きの PNG）を置き、リーダーの `c` → `s` で選びます（`mascot/` の中のキャラクターを並べた窓が出て、選ぶと `config.local.toml` に書きます。`config.toml` には書きません。home-manager が置く読み取り専用のファイルのことがあるためです）。`c` → `r` で、今選んでいるキャラクターを、窓を開き直さずに読み直します（次にリーダーを開いたときから新しい絵になります）。設定ファイルの `[gui]` に `mascot = "<名前>"` と自分で書いて選ぶこともできます。書いていなければキャラクターは出ません。キャラクターを配る人は、zip を落として `mascot/<名前>/` に広げるスクリプトを配ってください。使う人はそれを kisui-terminal のターミナルで実行し、`c` → `r`（新しいキャラクターなら `c` → `s`）を押します。kisui-terminal はスクリプトを実行しません。`mascot.toml` には、場面ごとに、コマの画像のファイル（名前もコマの数も自由）・1 コマの時間（既定 200 ミリ秒）・くり返すか・動く速さ（既定 1 秒に 90px）を書きます。キャラクターは案内を運び、運び終えると一息つき、しばらく（既定 3 秒）経つと休憩の動き（コーヒーを飲む・椅子に座る、など）をランダムに選んで見せ、案内を Esc で閉じると、案内を右へ押して画面の外まで持っていきます（`[push]` の場面でコマと速さを決めます。書かなければ運ぶ場面のコマを、既定の 1 秒に 90px の速さで使います）。Esc 以外（リーダーのキーをもう 1 度押す・操作を実行する・一覧に無いキーを押す・窓のフォーカスが外れる）で閉じると、その場でさようならを 1 回再生して消えます（案内からダイアログを開いたときや、さようならの場面が無いときは、すぐ消えます）。形式・全部の場面・既定の値・キャラクターの配り方は [docs/mascot.md](docs/mascot.md) にあります。以前の版の決まった名前（`walk-1.png`〜`walk-4.png`・`stop.png`）は読みません。窓を開いたときと、リーダーの `c` → `s`・`c` → `r` を押したときに読みます。OS の「視差効果を減らす」が入っているときは、右下に止まって出て、閉じると（Esc でも）その場で消えます。運んでいる途中に Esc で閉じたときも、押していかず、キャラクターと案内はその場ですぐ消えます。リーダーの後のキーは、アニメーションを待たずにすぐ効きます。

キャラクターを作るための skill `make-mascot` があります。`mascot.toml` と、コマごとの画像の指示文を作ります（画像そのものは作りません。画像は好きな画像生成のサービスで作ってください）。コーディングエージェント用のプラグイン `kisui-mascot` として配っています。Claude Code：`/plugin marketplace add mm1995tk/kisui-terminal` のあと `/plugin install kisui-mascot --marketplace mm1995tk/kisui-terminal`。Codex：`codex plugin marketplace add mm1995tk/kisui-terminal` のあと `codex plugin add kisui-mascot@kisui-terminal`。

ssh 先では、kisui-terminal は聞いてから自分の `kisui` と `shj` を `~/.cache/kisui-terminal/<版>/` に入れます。その先の PATH の `shj` には触りません。

### キー操作

キーを覚えなくても使えます。リーダー（macOS は `Cmd+K`、Linux は `Ctrl+Shift+K`）を押すと、次に押せるキーが、その動きといっしょに窓の右下に出ます（同じ右下のお知らせのカードより手前に重なります）。押すと動くか、一段下のグループに入ります。`Backspace` は一段戻り、`Esc`（かリーダーをもう 1 度）で出て、`?` で全部のキーを一覧で見られます。一覧に無いキーは捨てて出るので、うっかり押した字がシェルに入ることはありません。`shj` には自分のキー（`Space` など）があり、ペインの中では今までどおり届きます。kisui-terminal が受けるのは、リーダーと下の近道だけで、`Ctrl` と字、`Alt` と字だけのキーは取りません。

| リーダーのあとのキー | 動き                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `h` `j` `k` `l`      | 左・下・上・右のペインへ移る（続けて押せる）。`Tab` は直前にいたペインへ戻る                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `w`                  | ワークスペースを切り替える窓を開く。ワークスペースの操作は、すべてこの窓でします（サイドバーの見出しのワークスペースの名前を押しても開きます。サイドバーにはフォーカスしているワークスペースだけを出し、名前の右に切り替えの印（⇄）を出します）。左に全ワークスペース（並びは、すべてのマシンのワークスペースを、ユーザーが並べた順に 1 列にしたもの）、右に選んでいる行のタブを出します（窓の大きさは、ワークスペースやタブの数によらず、メインのウィンドウの 60% で変わりません）。キーは 2 つの列のどちらか 1 つにだけ効きます：`h` `l`（`←` `→`）で列を移り（タブが無いワークスペースでは、タブの列には移れません）、`j` `k` でその列の行を選びます。移る：`Enter` で選んでいる行を開いて窓を閉じる（ワークスペースの列ならそのワークスペースへ移り、タブの列ならそのタブを出す。選んでいない行を押すと選ぶだけで、選んでいる行をもう 1 回押すと開く）、`Esc` で窓を閉じる。変える：ワークスペースの列の `n` は作る（左の列の一番下に名前の入力欄が出る。`Enter` で、その名前のタブの無い空のワークスペースを作って選ぶ。窓は閉じない。空なら「ws1」のような番号の名前になり、名前の決まりに合わなければ入力欄の下に理由が出て開けたまま。`Esc` でやめる。タブは、作ったあとにタブの列で足す。近道の `workspace.new` は、内蔵ブラウザを有効にしていれば、先にターミナルかブラウザかを選び、ターミナルならどのマシンに作るかを選ぶ（つながっているマシンが 1 つだけなら聞かない）。新しいワークスペースは一番下に入る。ワークスペースはマシンではなく手元のアプリが持ち、どのマシンのターミナルのタブも、ブラウザのタブも入れられる。名前・並び・中のタブは再起動しても残る）、`r` は名前を変える（行の名前がその場で入力欄になる。`Enter` で決め、`Esc` でやめる。空にすると「ws1」のような番号の名前に戻る）、`x` は閉じる（先に `y` / `n` で確かめる。中のターミナルのタブとブラウザのタブも閉じる）、`J` `K`（Shift+j・Shift+k）は 1 つ下・上へ並べ替える（行のドラッグでも並べ替えられる。並び順はアプリが覚え、再起動しても残る）。どのワークスペースの行にも、名前を変える鉛筆と、閉じる ✕（これも `y` / `n` で確かめる）が出ます。タブの列では、`n`（と右の列の上の右端の「＋」）は、右の列の一番下に、タブの名前の入力欄とマシンを 1 行で出す（#331。マシンは最初、そのワークスペースのマシン。`Tab` で次のマシン、`Shift+Tab` で前のマシンに替わり、`↓` かマシンを押すとつながっているマシンの一覧が開く。一覧では `j` `k`（`↓` `↑`）で選び、`Enter` で決めて入力欄に戻り、`Esc` は一覧だけを閉じる。マシンを押しても入力欄からフォーカスは外れない。タブの無いワークスペースでは、タブの列に移れないので「＋」で出す）。入力欄で `Enter` を押すと、そのマシンにその名前のターミナルのタブを作って右の列で選ぶ（窓は閉じない。空なら自動の名前（フォルダ名）。名前の決まりに合わなければ入力欄の下に理由を出して開けたまま。日本語の変換を確定する `Enter` では決めない）。`Esc` か行の外へのフォーカスの移りで、作らずにやめる。つながっているマシンが 1 つも無いと、行は出さず、できないことを伝える。`N`（Shift+n。どちらの列でも効く）と、右の列の上の「＋」の左の地球儀のボタンは、選んでいるワークスペースに新しいタブのページのブラウザのタブを開いて右の列で選ぶ（窓は閉じない。内蔵ブラウザが無効なら、地球儀のボタンも `N` も無い）。`r` は選んでいるタブの名前を変え（行の 1 行目が入力欄になる。空にすると自動の名前に戻る。ブラウザのタブの URL は変えません）、`x` は確かめずに閉じ（プログラムが動いているターミナルのタブだけ、`t x` と同じ確認が出る）、`J` `K` は 1 つ下・上へ並べ替えます。どのタブの行にも、鉛筆と ✕ が出ます。サイドバーのタブの行の左端の、縦の点 3 つのつかむ所をドラッグすると、タブを並べ替えられます（同じワークスペースの中だけ）。タブを別のワークスペースへ移すのは、この窓の右のタブの行のドラッグです。つかむ所をドラッグして左のワークスペースの行の上へ運ぶと、右がそのワークスペースのタブに替わり、落とした位置に入ります（左の行の上で落とすと一番後ろ。空のワークスペースにも落とせます）。キーでは `t m` です。`w` の下のキーはありません。窓を開かずに移りたいときは、`[gui.shortcuts]` に自分で近道を足します（`workspace.step:next`・`workspace.step:prev`・`workspace.nth:0`〜`workspace.nth:8`・`workspace.last`・`workspace.move:up`・`workspace.move:down`・`workspace.new`・`workspace.close`・`workspace.rename`） |
| `m`                  | マシン：すべてのマシンを、つながりの状態とターミナルのタブの数と一緒に並べるダイアログを開く（ターミナルのタブが無いマシンと、つながっていないマシンも出す）。中で `j` `k` は選ぶ、`a` 足す、`n` 名前を変える、`d` 一覧から外す、`x` 切る、`r` つなぎ直す（待ち時間中は今すぐつなぐ）、`?` はダイアログのキーの一覧、`Esc` は閉じる。設定ファイル（`[[gui.machines]]`）で決めたマシンは、名前を変えることも外すこともできない                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `p`                  | ペイン：`s` 分ける（続けて `h` 左、`j` 下、`k` 上、`l` 右）、`m` 隣のペインと入れ替える（続けて `h` `j` `k` `l`）、`x` 閉じる、`z` プライマリ以外を隠す・戻す、`r` 大きさを変える（`h` `j` `k` `l` も同じ）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `b`                  | サイドバーを開け閉めする（閉じるのは、このキーを押したときだけ。ファイルツリーか CHANGES にフォーカスが移る（`shj` の `Space e`・`Space E` など）と、閉じていても開く（`shj` を起動した直後の自動のフォーカスでは開かない）。開け閉めは覚えておく）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `y`                  | クリップボードの履歴                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `v`                  | 表示の大きさ：`+` 大きく、`-` 小さく、`0` 元に戻す（macOS では、`Cmd+=` `Cmd+-` `Cmd+0` が同じなので、案内には出しません。`?` の一覧にはどちらにも出ます）。内蔵ブラウザのページを出している間は、近道も含めて、そのページの表示の大きさを変えます（タブごとに覚えます）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `t`                  | 今のワークスペースのタブ（ターミナルのタブとブラウザのタブ）：`n` 今のターミナルのタブと同じマシン・同じフォルダにターミナルのタブを作る（ブラウザのタブを出しているときは、直前に出していたターミナルのタブのもの。ブラウザのタブだけのワークスペースと空のワークスペースでは、`N` と同じにマシンを選ぶ。サイドバーのカードの「+」のメニューも同じ）、`N`（Shift+n）マシンを選んでターミナルのタブを作る（`w n` と同じ窓）、`x` 今のタブを閉じる（ワークスペースの最後のタブを閉じても、ワークスペースは空のまま残る。空のワークスペースは `w` の窓の `x` で閉じる。プログラムが動いているターミナルのタブは確認が出る）、`j` `k` 次・前のタブ（端では反対の端へ回る。続けて押せる）、`J` `K`（Shift+j・Shift+k）今のタブを 1 つ下・上へ並べ替える（端では動かさない。続けて押せる）、`1`〜`9` 上から n 番目のタブ、`r` 今のタブの名前を変える（空にすると自動の名前（ターミナルはフォルダ名、ブラウザはページの題）に戻る）、`m` 今のタブを別のワークスペースへ移す（移す先を選ぶ窓が出る。`j` `k` で選び、`Enter` で決めると、移す先の一番後ろに入り、そのワークスペースへ移ってそのタブを出す。空のワークスペースも選べる。タブは閉じずに所属だけを変えるので、ターミナルで動いているプログラムと画面・分割、ブラウザのページはそのまま。タブのマシンも変わらない。移す元の最後のタブを移しても、元のワークスペースは空のまま残る。所属と並びは再起動しても残る） |
| `n`                  | お知らせ：`u` 新しい版に更新する（「新しい版があります」のカードの「更新して再起動」と同じ）、`d` 閉じる、`g` 最後に OS の通知を出したペインを前に出す、`o` 内蔵ブラウザが最後にダウンロードしたファイルを開く、`f` そのフォルダを表示する                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `o`                  | 内蔵ブラウザ（`[gui.browser] enabled = true` のときだけ）：`n` 今のワークスペースに新しいタブを開く（すぐ新しいタブのページを出す。検索窓とブックマークがあり、検索窓には URL か Google の検索語を打てる）、`N` 今のワークスペースにシークレットのタブを開く（同じ新しいタブのページ）、`u` ページの上の URL バーで URL を書き換える（URL でなければ Google で検索する）、`h` 戻る、`l` 進む（続けて押せる）、`r` 読み込み直す（ページを出している間は `Cmd+R` / `Ctrl+Shift+R` でも。ほかのときはリサイズモード）、`x` 今のタブを閉じる、`e` そのページを OS 既定のブラウザで開く、`b` 今のページをブックマークに足す、`B` ブックマークの一覧を開く（字を打って絞り込み、`Enter` で今のワークスペースの新しいタブに開く。`Ctrl+D` で消す（Chrome のブックマークは消せない）。ブックマークはすべてのワークスペースで共有）、`/` ページ内を検索する（ページを出している間は `Cmd+F` / `Ctrl+F` でも。`Enter` で次、`Shift+Enter` で前、`Esc` で閉じる）、`y` 今のページの URL をコピーする、`i` DevTools を開く、`s` 外のブラウザでこのサイトにログインする（`[gui.browser] passkey_sites` のサイトだけ）、`R` 今のタブの名前を変える（空にするとページの題に戻る）                                                                                                                                                                                                                                                                                                                                       |

リーダーを通さずに押せる近道もあります（`?` の一覧に、使っている OS のものが出ます）。`Cmd+Shift+W` / `Ctrl+Shift+W` はワークスペースの窓を開き、`Cmd+Shift+P` / `Ctrl+Shift+P` はペインのグループに 1 回で入ります。`Cmd+D` / `Ctrl+Shift+D` と `Cmd+Shift+D` / `Ctrl+Shift+E` はペインを右と下に分け（左と上に近道はありません。`p s h` と `p s k` を使います）、`Cmd+R` / `Ctrl+Shift+R` は大きさを変え、`Cmd+Shift+Enter` / `Ctrl+Shift+M` はほかのペインを隠し、`Cmd+Shift+H` / `Ctrl+Shift+H` はクリップボードの履歴、`Cmd+=` `Cmd+-` `Cmd+0`（Linux は `Ctrl+=` `Ctrl+0`）は表示の大きさを変えます。macOS では `Cmd+W` でペインを閉じます。次のキーは、`shj` やシェルが使うので、なくなりました。`Ctrl+Shift+矢印` と `Cmd+Option+矢印`（ペインの移動。リーダーを使います）、macOS の `Ctrl+Shift+M`、Linux の `Ctrl+-`（表示を小さくする。リーダーを使います）。

画像のペイン（`kisui open --pane` で開いたものと、`shj` から開いたもの）では、ペインにフォーカスがあるあいだ次のキーが効きます（リーダーには載せていません。`?` の一覧に出ます）。`+` / `=` で拡大、`-` で縮小、`0` でペインに収まる大きさに戻し、拡大中は `h` `j` `k` `l` か矢印で見える場所を動かし、`Esc` でターミナルへ戻ります。マウスでは、`Ctrl` + ホイールかトラックパッドのピンチで（ポインタの位置を中心に）拡大・縮小し、拡大中はドラッグで動かせます。画面全体の大きさを変えるキー（`Cmd+=` など）は修飾キーが付くので、重なりません。

ファイルツリー・変更一覧・動画のペインにも、フォーカスがあるあいだだけ効くその場所のキーがあります。そこで `?` を押すとその一覧が出ます（リーダーの `?` も、フォーカスがある場所のキーを、リーダーのキーの上に出します）。ファイルツリーでは、`c` で名前をコピー、`m` で「ここへ移動」（ターミナルで cd。フォルダの行だけ）、`.` か Menu キーで、選んでいる行に右クリックのメニューを開きます。これらは今まで右クリックのメニューにしかありませんでした。ダイアログの一覧（クリップボードの履歴、リモートを足すときの候補）では、`↓` `↑` と同じに、`Ctrl+J` / `Ctrl+K` で次・前の行を選べます。

キーで一覧を動かす窓（マシンのダイアログ、ワークスペースを切り替える窓、マシンや移す先を選ぶ窓、ブックマークの一覧、クリップボードの履歴）の下には、基本の操作（選ぶ・決める・やめる）だけが出ます。`?` を押すと、その窓で使えるキーの一覧が出て、`Esc` で元の窓の、選んでいた行に戻ります。ブックマークの一覧とクリップボードの履歴では、絞り込みが空のときだけ `?` で一覧が出ます（打っている途中の `?` は、探す字になります）。

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
npm run storybook      # 部品を 1 つずつブラウザで見る。Tauri は要らない（docs/design/storybook.md）
nix fmt                # 全部を整形する
nix flake check        # CI が回す検査を全部（整形・go test・ビルドとテスト）
```

`tauri dev` では、ペインの中のターミナルは PATH の `shj` を使います。配るアプリは自分の `shj` を同梱します（`packaging/`）。

置き場：`app/` が窓（`src/` に Solid + TypeScript。中は `ui/`・`features/`・`infrastructure/` に分けています：[docs/design/frontend-structure.md](docs/design/frontend-structure.md)。`src-tauri/` に Tauri の殻）、`cmd/kisui` と `server/`・`attach/`・`rpc/`・`config/` が `kisui`（Go）、`internal/` は kisui が持つ `shj` との取り決め（`ctl`）・PTY（`term`）・ビルドの情報（`buildinfo`）・メッセージ（`i18n`）です。`docs/design/` は設計の経緯です。

リリースの流れは [docs/releasing.md](docs/releasing.md) にあります。

## ライセンス

MIT
