# kisui-terminal のキー操作とマウスの操作の一覧

kisui-terminal の窓（`app/`）が受けているキー操作と、マウスでしかできない操作を、コードから洗い出した表。キー操作を作り直すときの土台にする。この文書は今のコードを並べただけで、キーを決める文書ではない。

- 新しいキー操作の表（リーダーと近道。#91 で決めた）は [`key-design.md`](key-design.md)。
- 書いたのは、`main` の d20d4db の時点。1.1・1.2 は #92（リーダーと案内）のあとの状態に直した。ほかの章の「定義の場所」の行番号は、そのときのまま。キーを足す・変えたら、この表も直す。#313 で `app/src/` の配置を変えたので、パスは新しい場所に直した（行番号はそのまま。`App.tsx` にあったものは、分けた先のファイルと関数の名前で書いた）。
- 「定義の場所」は `path:行`。`app/src/` の下のファイルは `app/src/` を省いて書く。1.1・1.2 のキーは `features/commands/commands.ts` の表が定義なので、行は書かない。
- キーは、窓の外の GUI（`app/`）が受けるものだけを書く。Go の `kisui`（`kisui serve`・`kisui attach`）にはキーの割り当てが無い。
- 洗い出しかた：`keydown` を受けている所（`git grep -nE "keydown|onKeyDown" app/src`）と、`metaKey`・`ctrlKey`・`altKey` を見ている所を全部たどった。`app/src-tauri/src` でキーを取るのは、`clipboard_popup.rs` の全体のキーと、`menu.rs` の差し替えたメニューの「閉じる」（Mac だけ。Cmd+W）の 2 つ。
- 「Mac」は macOS、「Linux」は Linux と Windows（Mac 以外）。Cmd は Mac の ⌘、Option は Mac の ⌥。

## 1. キー操作

### 1.1 全体（どこにフォーカスがあっても効く）

`features/commands/commands.ts` のコマンドの表が、リーダーと近道を持つ。`ui/main-window/keys.ts` の `onGuiKey` が `window` の `keydown` を capture（ペインに届く前）で受け、表の `route` に渡す。表のキーに当たったキーは `preventDefault` と `stopPropagation` をして、シェルにも shj にも送らない。当たらないキーは何も受けず、今までどおりターミナル（shj やシェル）に届く（リーダーに入っている間だけは、一覧に無いキーも捨てて出る）。

リーダー（Mac は Cmd+K、Linux は Ctrl+Shift+K）を押すと、次に押せるキーの一覧が画面の右下に出る（`ui/main-window/commands/LeaderMenu.tsx`。右下のお知らせのカードより手前に重なる）。案内の文は短くしてあり（「左のペインへ」「ワークスペースを作る」など）、補足は下のリーダーの説明に書く。Mac では `v`（表示の大きさ）のグループを案内に出さない（Cmd+= / Cmd+- / Cmd+0 が共通の操作のため）。Linux では出す（Ctrl+- が端末の Ctrl+_ と同じ信号で近道が無く、`v -` しか小さくするキーが無いため）。`1`〜`9` は案内では 1 行にまとめる（`1–9  上から N 番目へ`）。向きの `h` `j` `k` `l` も 1 行にまとめる（`h|j|k|l  ペインを移動`。ワークスペースの中だけ `j|k` と `h|l` の 2 行）。`?` の一覧は、どの OS でも全部出す。リーダーの木と、そこへの近道は `key-design.md` の 3 章・4 章。`?` で全部のキーの一覧（`ui/main-window/commands/KeyListDialog.tsx`）が出る。

| どこで                              | Mac のキー                          | Linux のキー                      | 動き                                                                                                                         | リーダー |
| ----------------------------------- | ----------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------- |
| 全体                                | Cmd+K                               | Ctrl+Shift+K                      | リーダーに入る（かな漢字変換中・ダイアログが出ている間・リサイズモードの中は入らない）                                       | —        |
| 全体                                | Cmd+Shift+W                         | Ctrl+Shift+W                      | ワークスペースを切り替える窓を開く                                                                                 | `w`      |
| 全体                                | Cmd+Shift+P                         | Ctrl+Shift+P                      | リーダーの「ペイン」のグループに入る                                                                                         | `p`      |
| 全体                                | Cmd+`+` / Cmd+`=`（Shift 付きも可） | Ctrl+`+` / Ctrl+`=`（Shift 付き） | 表示を大きくする（0.7 / 0.8 / 0.9 / 1 / 1.1 / 1.25 / 1.5 / 1.75 / 2 の次の段）。大きさは覚えて、起動し直しても残す           | `v +`    |
| 全体                                | Cmd+`-`                             | （無い）                          | 表示を小さくする（1 段）。Linux の Ctrl+`-` は端末の C-\_（shj のコメントの切り替え、readline の undo）を奪うので消した      | `v -`    |
| 全体                                | Cmd+`0`                             | Ctrl+`0`                          | 表示の大きさを 1 に戻す                                                                                                      | `v 0`    |
| 全体                                | Cmd+Shift+Enter                     | Ctrl+Shift+M                      | プライマリ以外のペインを隠す・戻す（押しっぱなしは 1 回だけ）。Mac の Ctrl+Shift+M は消した                                      | `p z`    |
| 全体                                | Cmd+Shift+H                         | Ctrl+Shift+H                      | クリップボードの履歴の窓を開く（出ている間は何もしない）。押したときにキーが向いていたペインが、貼る先になる                     | `y`      |
| 全体                                | Cmd+D                               | Ctrl+Shift+D                      | 今のペインを右に分ける（新しいターミナル。押しっぱなしは 1 回だけ）                                                              | `p s l`  |
| 全体                                | Cmd+Shift+D                         | Ctrl+Shift+E                      | 今のペインを下に分ける（同上）                                                                                                   | `p s j`  |
| 全体（リサイズモードに入る・出る）  | Cmd+R                               | Ctrl+Shift+R                      | リサイズモードに入る（入っている間に押すと出る）。Alt+R は端末に渡す。内蔵ブラウザのタブを出している間は、下の行（リサイズモードの中では、出る）                                                         | `p r`    |
| 全体（内蔵ブラウザのタブを出している間。設定で有効にしたときだけ） | Cmd+R                               | Ctrl+Shift+R                      | ページを読み込み直す（#202）。ページにキーがあっても効く                                                                     | `o r`    |
| 全体（`kisui-terminal` の外）       | Option+Space                        | Alt+Space                         | OS から取る全体のキー。小さいクリップボードの履歴の窓を出す。登録できないとき（ウィンドウマネージャーが先に取っているなど）は標準エラーに書くだけ | （無い。アプリの外から出すので、リーダーでは代われない） |

リーダーだけにある操作（近道は無い）：サイドバーを開け閉めする（`b`。閉じるのはこのキーを押したときだけで、自動では閉じない。閉じている間にファイルツリーか CHANGES へフォーカスが移る（shj の `Space e`・`Space E` など）と開く。shj を起動した直後の自動のフォーカスでは開かない。キーがサイドバーの中にあるときに閉じると、キーはターミナルへ戻る。開け閉めは覚えて、起動し直しても残す）・隣のペインへ移る（`h` `j` `k` `l`。続けて押せる）・直前のペインへ戻る（`Tab`）・ワークスペースを切り替える窓を開く（`w`。サイドバーの見出しのワークスペースの名前を押しても開く。サイドバーにはフォーカスしているワークスペースだけを出し、見出しの名前の右に切り替えの印（⇄）を出す。ワークスペースの操作（移る・作る・名前を変える・閉じる・並べ替える）は、すべてこの窓の中のキーでする。中のキーは 1.6）。ワークスペースは手元の GUI が持ち（#231）、中のターミナルのタブとブラウザのタブを束ねる。窓の `n` は、内蔵ブラウザを有効にしていれば、先にターミナルかブラウザかを選ぶ窓を出す（無効なら出さずに、ターミナルで作る。キーは 1.6）。ターミナルを選ぶと、どのマシンに作るかを選ぶ窓を出し（つながっているマシンが 1 つだけなら出さずにそこへ作る。キーは 1.6）、そのマシンのターミナルのタブ 1 つを持つ新しいワークスペースを作る。ブラウザを選ぶと、新しいタブのページのブラウザのタブ 1 つだけの新しいワークスペースを作る（ターミナルのタブは無くてよい。#257）。新しいワークスペースは並びの一番下に入る。窓の `x` は、`y` / `n` で確かめてから、中のタブを全部閉じる（確認が出ることもある）。窓の `r` は、行の名前をその場で入力欄にする。リーダーの木には、`w` の下の操作も Cmd+1〜9 も無い。窓を開かずに 1 回で動かしたい人のために、コマンド（`workspace.step:next` `workspace.step:prev` `workspace.nth:N` `workspace.last` `workspace.move:up` `workspace.move:down` `workspace.new` `workspace.close` `workspace.rename`）は残してあり、設定の `[gui.shortcuts]` から近道を足せる（木に載らないので、案内にも `?` の一覧にも出ない）・今のワークスペースのタブ（ターミナルのタブもブラウザのタブも）の操作は、リーダーの `t` のグループにある：作る（`t n` は今のターミナルのタブと同じマシン・同じフォルダに作る。ブラウザのタブを出しているときは、直前に出していたターミナルのタブのマシンとフォルダを使う。ブラウザのタブだけのワークスペースには元のターミナルのタブが無いので、`t N` と同じにマシンを選ぶ窓を出す。`t N`（Shift+n）は、マシンを選ぶ窓（窓の `n` と同じ）を出して、そのマシンに作る）・閉じる（`t x`。ワークスペースの最後のタブ（ターミナルのタブでもブラウザのタブでも）を閉じると、ワークスペースも閉じる。プログラムが動いているターミナルのタブは、確認が出る）・順に回る（`t j` `t k`。最後の次は最初。続けて押せる）・並べ替える（`t J` `t K`。端では動かさない。続けて押せる）・n 番目へ移る（`t 1`〜`t 9`）・名前を変える（`t r`。名前の窓が出る。空にすると自動の名前（ターミナルはフォルダ名、ブラウザはページの題）に戻る）・マシンのダイアログを開く（`m`。すべてのマシンを、つながりの状態とターミナルのタブの数と一緒に並べる。中で、足す・名前を変える・外す・切る・つなぎ直す（今すぐつなぐ）を、キーで行う。中のキーは 1.6）・ペインを左・上に分ける（`p s h` `p s k`。右と下は近道の Cmd+D など）・ペインを隣のペインと入れ替える（`p m h` `p m j` `p m k` `p m l`。場所だけを替え、フォーカスは今のペインについていく。プライマリのペインも替えられ、プライマリの役目はそのペインについたまま。隣が無ければ何もしない）・ペインを閉じる（`p x`。Mac は近道の Cmd+W もある。1.2）・新しい版に更新する（`n u`。「新しい版があります」の「更新して再起動」と同じ）・お知らせを閉じる・最後に OS の通知を出したペインを前に出す（`n d` `n g`）・内蔵ブラウザでダウンロードしたファイルを開く・そのフォルダを表示する（`n o` `n f`。#204）・キャラクターを選ぶ・読み直す（`c s` `c r`。実験的な機能。`c s` は `mascot/` の中のキャラクターを並べた窓を出し、決めると `config.local.toml` の `[gui] mascot` に書いて読み込む（`config.toml` には書かない）。`c r` は今選んでいるキャラクターの `mascot.toml` と画像を、窓を開き直さずに読み直す。どちらも、次にリーダーを開いたときから新しい絵になる。読めないときは右下のお知らせで理由を伝え、前のキャラクターをそのまま使う。キーは 1.6。形式は `docs/mascot.md`）。お知らせのボタンの「つなぎ直す」「切る」は、マシンのダイアログの `r` `x` と同じ動き（お知らせのカードの文に、`m` でダイアログを開き、そのマシンを `j` `k` で選んでから `r` `x` を押す、と書き添える）。

内蔵ブラウザ（#202。設定の `[gui.browser] enabled = true` のときだけ。`browser/`・`app/src-tauri/src/browser.rs`）の操作は、リーダーの `o` のグループにある：新しいタブを開く（`o n`。#238。URL は聞かず、すぐ「新しいタブのページ」のタブを開いて出す。ページには Google の検索窓と、ブックマーク（`o b` で足したもの）の一覧が出て、出たら検索窓にキーがある。検索窓に打ったものは URL バー（`o u`）と同じ決まりで、URL ならその URL（scheme を省くと https、`localhost`・`127.0.0.1`・`[::1]` は http）、そうでなければ Google で検索し、`Enter` で開くと、そのタブがそのページになる。打つとブックマークを題か URL で絞り込み、`↓` `↑`・Ctrl+J / Ctrl+K で選び（検索窓から出入りする）、`Enter` で選んだブックマークを開く（Chrome のフォルダを選んでいるときは開け閉めする）。マウスでブックマークを押しても開く。`Esc` で打ったものを消す。ページを開くまで、ページが要る操作（`o b`・`o e`・`o y`・`o /`・`o i`）はできない。シークレットのタブの `o N` も、同じページから始める。サイドバーの帯の「+」のメニューの「ブラウザ」も同じ動き。新しいタブのページのまま kisui-terminal を終えると、再起動したときも新しいタブのページのまま戻る）・今のワークスペースにシークレットのタブを開く（`o N`。Shift+n。#204。タブだけの、ディスクに残さないデータを使い、閉じるとログインが消え、覚えない。サイドバーの行に「シークレット」の札が付く。パスキーを外のブラウザに移す仕組み（#206）は使わない）・今のタブの URL を書き換える（`o u`。#232。ブラウザのタブを出している間、ページの上の端に URL バーがあり、今のページの URL（リモートのマシンの `localhost` 系は中継前の元の URL）と、戻る・進む・読み込み直すのボタンを出す。`o u` かバーのクリックでキーがバーに移り、書き換えられる。`Enter` で開く。打ったものが URL ならその URL（scheme を省くと https、`localhost` などは http。host に「.」があるものだけ。「example.com」は URL、「foo」は検索語）、そうでなければ Google で検索する（`https://www.google.com/search?q=…`）。`Esc` か、キーがほかへ移ると元の URL に戻り、`Esc` ではキーをページに戻す。シークレットのタブでも同じ）・戻る・進む（`o h` `o l`。続けて押せる）・読み込み直す（`o r`。ブラウザを出している間は Cmd+R / Ctrl+Shift+R も）・タブを閉じる（`o x`。同じワークスペースの次のタブ（ターミナルのタブでもよい）、無ければ前のタブを出す）・外のブラウザで開く（`o e`）・今のページをブックマークに足す（`o b`。#205。ブックマークはすべてのワークスペースで共有し、データのフォルダの `browser-bookmarks.json` に覚える。同じ URL は 1 つにまとめる）・ブックマークの一覧を開く（`o B`。Shift+b。字を打つと題か URL で絞り込み、`↓` `↑`・Ctrl+J / Ctrl+K で選び、`Enter` で今のワークスペースの新しいタブに開く。Ctrl+D で選んだものを消す（#239。手元の Chrome の `Default` プロファイルのブックマークも、読むだけで、Chrome と同じフォルダの入れ子で（#275。ブックマークバー・その他のブックマーク・モバイルを根にし、フォルダの中は Chrome の順）、札を付けて自身のものの後ろに出る。新しいタブのページにも同じ形で出る。根は最初から開き、その下のフォルダは閉じている。フォルダは `↓` `↑` で選んで `Enter`（マウスなら 1 回押す）で開け閉めする。絞り込むと、当たったブックマークと、それが入っているフォルダ（開いた状態）だけを出す。開くたびに読み直す。Chrome のものは消せない）。絞り込みが空のときの `?` でダイアログのキーの一覧、`Esc` で閉じる）・ページ内を検索する（`o /`。ブラウザを出している間は Cmd+F / Ctrl+F も。ページの下の端に検索の欄が出て、字を打つたびに探す。`Enter` で次、`Shift+Enter` で前、端では折り返す。`Esc` か × で閉じてページにキーを戻す）・今のページの URL をコピーする（`o y`。リモートのマシンの `localhost` 系は中継前の元の URL）・DevTools を開く（`o i`。macOS は別の窓で開く。Linux はページの領域の中にくっつく）・今のタブに名前を付ける（`o R`。Shift+r。#231。名前の入力欄が出る。付けた名前をサイドバーの 1 行目に出し、ページの題は出さない。空にして決めるとページの題に戻る）。ブラウザを出している間は、表示の大きさ（`v + - 0` と近道の Cmd+= / Cmd+- / Cmd+0・Ctrl+= / Ctrl+0）は、画面全体ではなくページの表示の大きさを変える（#205。タブごとに覚え、ページを移っても変わらず、タブと一緒に再起動しても戻る。画面全体の大きさは、グリッドに戻してから変える）。`kisui open <URL>`・shj の URL を開く要求・ターミナルの URL の Cmd+クリック（下の 2 章）も、そのワークスペースの新しいタブで開く（#203）。ページにキーがある間も、リーダーと近道は効く（ページに入れたスクリプトが、当たるキーだけを kisui-terminal に渡す）。ほかのキーはページに届く。ページが開く新しい窓（`target=_blank` のリンク・`window.open`）は、同じワークスペースの新しいタブになって前に出る（#204。開いた元のページとの連絡 `window.opener` を保つので、OAuth の小窓は元のページに結果を返せる。データは開いた元のタブと同じ）。そのページが自分を閉じたら（`window.close()`）タブも閉じ、開いた元のタブに戻る。ページがダウンロードしたファイルは、OS のダウンロードのフォルダ（`~/Downloads`）に、場所を聞かずに保存し（同じ名前があれば `名前 (1).拡張子` と番号を付ける）、右下のお知らせで知らせる。お知らせの「開く」「フォルダを表示」はリーダーの `n o` `n f`（いちばん新しいダウンロード）、閉じるのは `n d`。タブを出している間のペインの操作（`h` `j` `k` `l`・`Tab`・`p` の下）は、まずグリッドに戻してから行う。ペインを閉じる（`p x`・Cmd+W）は、グリッドに戻すだけで閉じない。

**ユーザーが足す近道**（#199）：設定ファイルの `[gui.shortcuts]` に `"Ctrl+Alt+N" = "workspace.new"` のように書くと、そのキーで 1 回でコマンドを動かせる（コマンドの名前・間違いの扱い・既定の近道との重なりは `key-design.md` の 4.3）。足した近道は、`?` の一覧（リーダーの `?`）の、そのコマンドの行の「近道」に出る（リーダーの木に載せないワークスペースのコマンドは、行が無いので出ない）。同じキーの既定の近道は、設定のほうが勝つ。コマンドに `none` と書くと、そのキーの既定の近道を消す。

### 1.2 ターミナルのペインにフォーカスがあるとき（Cmd+W は、どこにもフォーカスが無いときも）効く GUI のキー

表の `shortcutInPane` が付いた近道は、キーの向き先がターミナルのペイン（`mainEl` の `.terminal`）の中のときだけ受ける。Cmd+W だけがそれで、フォーカスがどの要素にも無いとき（`body`・`html`）も受ける。

| どこで                                                  | Mac のキー | Linux のキー | 動き                                                                       | リーダー |
| ------------------------------------------------------- | ---------- | ------------ | -------------------------------------------------------------------------- | -------- |
| ターミナルのペイン（画像・動画・PDF のペインを含む。キーがどのペインにも向いていないときも） | Cmd+W | （無い） | 分割したペインか、画像・動画・PDF のペインを閉じる（アプリの窓は閉じない）。プライマリのペインは閉じず、何もしない（押しっぱなしは 1 回だけ）。Mac は PDF のペインの中を押した後も効く（メニューの「閉じる」を通す。下の補足） | `p x` |

Mac の Cmd+W の補足（#111）：PDF のペインは iframe で、ペインの中を押すとキーが PDF の表示に取られ、画面の `keydown` に届かない。そのため、メニューバーの「閉じる」（File）を差し替えてある（`app/src-tauri/src/menu.rs`）。選ばれると、画面が今のフォーカスを見て、ターミナルのペインの中（PDF の iframe を含む）かどこにも向いていないときは上の表の動き、サイドバー・入力欄・窓の中では今までどおりアプリの窓を閉じる。閉じるペインを持つ画面が無いとき（ワークスペースを選んでいないなど）も窓を閉じる（`features/commands/guiKeys.ts` の `closeTarget`）。

隣のペインへ移る Ctrl+Shift+矢印（Linux）と Cmd+Option+矢印（Mac）は消した（`key-design.md` の 4.2）。リーダーの `h` `j` `k` `l` で移る。

### 1.3 リサイズモード

Cmd+R（Mac）か Ctrl+Shift+R（Linux）で入る（1.1 の表）。入っている間、`Ctrl`・`Cmd`・`Alt` を押していない矢印・`Esc`・`Enter`・`Tab` と 1 文字のキーは、境界を動かすのに使い、端末には送らない（割り当ての無い字のキーも消える）。入るたびに、動かす境界はサイドバーから始まる。動かせる境界は、サイドバーの幅、サイドバーの中のタブの段とファイルツリーの境目（`shj` が動いていて、3 段に分けているとき。ブラウザのタブを出している間は無い。タブの段の高さの上限が変わる）、ファイルツリーと CHANGES の境目（CHANGES が出ているとき。CHANGES の一覧の高さが変わる）、ペインどうしの境界（ペインを分けているとき。隠している間は無い）。

| どこで         | Mac のキー                                | Linux のキー                              | 動き                                                                                                   | 定義の場所                                                        |
| -------------- | ----------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| リサイズモード | `←` / `h`                                 | `←` / `h`                                 | 選んでいる境界を左へ動かす（サイドバーは 20px。ペインどうしは 2%。横の境界と、サイドバーの中の 2 つの境目には効かない）                   | `ui/main-window/panes.ts:130`・`ui/main-window/panes.ts:28`・`ui/main-window/panes.ts:175`・`ui/main-window/paneResize.ts` の `resizeKey`     |
| リサイズモード | `→` / `l`                                 | `→` / `l`                                 | 右へ動かす（同上）                                                                                     | `ui/main-window/panes.ts:130`・`ui/main-window/paneResize.ts` の `resizeKey`                                     |
| リサイズモード | `↑` / `k`                                 | `↑` / `k`                                 | 上へ動かす（ペインどうしの横の境界と、サイドバーの中の 2 つの境目。タブの段とファイルツリーの境目は、タブの段の高さの上限が 5% 低くなる（動かし始めは、画面に出ているタブの段の高さから。タブが少なければ、出ている高さから 5% 低くなり、見た目も変わる）。ファイルツリーと CHANGES の境目は、CHANGES が 22px 高くなる。ただし一覧は中身の高さまでしか伸びないので、行が少なければ、高さを決めても見た目は変わらない（行が増えたときに効く）。サイドバーの幅には効かない）                                           | `ui/main-window/panes.ts:130`・`ui/main-window/paneResize.ts` の `resizeKey`                                     |
| リサイズモード | `↓` / `j`                                 | `↓` / `j`                                 | 下へ動かす（同上。タブの段とファイルツリーの境目は、上限が 5% 高くなる。ただしタブの段は中身の高さまでしか伸びないので、タブが少なければ、上限を決めても見た目は変わらない（タブが増えたときに効く）。ファイルツリーと CHANGES の境目は CHANGES が 22px 低くなる）                                                                                     | `ui/main-window/panes.ts:130`・`ui/main-window/paneResize.ts` の `resizeKey`                                     |
| リサイズモード | `Tab` / `Shift+Tab`                       | `Tab` / `Shift+Tab`                       | 動かす境界を次・前へ替える（サイドバーの幅、タブの段とファイルツリーの境目、ファイルツリーと CHANGES の境目、ペインどうしの境界の順に回る。3 段に分けていなければ 1 つ目の境目を、CHANGES が出ていなければ 2 つ目の境目を飛ばす）                                     | `ui/main-window/panes.ts:144`・`ui/main-window/paneResize.ts` の `resizeKey`                                     |
| リサイズモード | `=`                                       | `=`                                       | 選んでいる境界を元に戻す（サイドバーは 300px、タブの段の高さの上限は設定 `[gui.sidebar] tabs-height` の値（無ければ 40%）、CHANGES の高さは 143px、ペインどうしは 50%）                                         | `ui/main-window/panes.ts:148`・`ui/main-window/paneResize.ts` の `resizeKey`                                     |
| リサイズモード | `Esc` / `Enter` / `q` / Cmd+R             | `Esc` / `Enter` / `q` / Ctrl+Shift+R      | リサイズモードを出る                                                                                   | `ui/main-window/panes.ts:150`・`ui/main-window/paneResize.ts` の `resizeKey`                                     |

### 1.4 サイドバーとファイルツリー

プライマリで `shj` が動いているときは、サイドバーのヘッダーの下を「タブ」「ファイルツリー」「CHANGES」の 3 段に分け、段ごとにその中だけでスクロールする（#284）。ファイルツリーと CHANGES は、タブの行の中ではなく、タブの段の下の段に出す。タブの段の高さには上限があり（設定 `[gui.sidebar] tabs-height`・境目のドラッグ・リサイズモード。上限より少なければ中身の高さまで縮め、余りはファイルツリーに回る）、タブが多ければタブの段の中でスクロールする。タブを足したときと、出しているタブが替わったときは、その行が見える所までタブの段をスクロールする。`shj` が動いていないときは、段に分けず、タブがサイドバーの高さを全部使う。ブラウザのタブを出している間は隠し、ターミナルのタブに戻ると、開いているフォルダ・選んでいる行・境目の位置はそのままで出す（#268）。隠している間に `shj` の `Space e` でファイルツリーへフォーカスを移しても、サイドバーが閉じていれば開くが、ファイルツリーは見えないのでキーはブラウザのページに残る。

| どこで                                          | Mac のキー                | Linux のキー              | 動き                                                                                           | 定義の場所                                              |
| ----------------------------------------------- | ------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| ファイルツリーの行（フォーカスがあるとき）      | `Esc` / Ctrl+E                     | `Esc` / Ctrl+E                     | 端末（shj のエディタ）へ戻る（かな漢字変換中は除く）。メニューや窓の中の Esc には触らない                        | `ui/main-window/sidebar/file-tree/explorerFocus.ts:7`・`ui/main-window/keys.ts` の `onGuiKey`                    |
| ファイルツリーの行                              | `j` / `↓`                 | `j` / `↓`                 | 次の行へ                                                                                       | `features/file-tree/keys.ts:52`・`ui/main-window/sidebar/file-tree/TreeView.tsx:112`             |
| ファイルツリーの行                              | `k` / `↑`                 | `k` / `↑`                 | 前の行へ                                                                                       | `features/file-tree/keys.ts:55`                                      |
| ファイルツリーの行                              | `g` / `Home`              | `g` / `Home`              | 最初の行へ                                                                                     | `features/file-tree/keys.ts:58`                                      |
| ファイルツリーの行                              | `G` / `End`               | `G` / `End`               | 最後の行へ                                                                                     | `features/file-tree/keys.ts:61`                                      |
| ファイルツリーの行                              | `l` / `→`                 | `l` / `→`                 | ファイルは開く。閉じたフォルダは開く。開いたフォルダでは何もしない                             | `features/file-tree/keys.ts:64`                                      |
| ファイルツリーの行                              | `h` / `←`                 | `h` / `←`                 | 開いたフォルダは閉じる。ほかは親のフォルダの行へ                                               | `features/file-tree/keys.ts:68`                                      |
| ファイルツリーの行                              | `Enter` / `Space`         | `Enter` / `Space`         | 行を押したのと同じ（フォルダの開け閉め・ファイルを開く）                                       | `features/file-tree/keys.ts:89`・`features/file-tree/model.ts:319`                 |
| ファイルツリーの行                              | `a` / `n`                 | `a` / `n`                 | 新しいファイルを作る（名前の窓を出す）                                                         | `features/file-tree/keys.ts:73`                                      |
| ファイルツリーの行                              | `A` / `N`                 | `A` / `N`                 | 新しいフォルダを作る（名前の窓を出す）                                                         | `features/file-tree/keys.ts:76`                                      |
| ファイルツリーの行                              | `r`                       | `r`                       | 名前の変更（名前の窓を出す）                                                                   | `features/file-tree/keys.ts:79`                                      |
| ファイルツリーの行                              | `d` / `Delete`            | `d` / `Delete`            | 削除（確認の窓を出す）                                                                         | `features/file-tree/keys.ts:81`                                      |
| ファイルツリーの行                              | `y`                       | `y`                       | 相対パスをコピー                                                                               | `features/file-tree/keys.ts:84`                                      |
| ファイルツリーの行                              | `Y`                       | `Y`                       | 絶対パスをコピー                                                                               | `features/file-tree/keys.ts:86`                                      |
| ファイルツリーの行                              | `c`                       | `c`                       | 名前をコピー（右クリックのメニューの「名前をコピー」と同じ）                                   | `features/file-tree/keys.ts`（`treeKey`）                            |
| ファイルツリーの行                              | `m`                       | `m`                       | ここへ移動（ターミナルで cd する。フォルダの行だけ。メニューの「ここへ移動」と同じ）           | 同上                                                   |
| ファイルツリーの行                              | `.` / `Menu`              | `.` / `Menu`              | 右クリックのメニューを、この行で開く。閉じたら行にフォーカスが戻る                             | `features/file-tree/keys.ts`・`ui/main-window/sidebar/file-tree/TreeView.tsx`・`ui/main-window/sidebar/file-tree/TreeMenu.tsx` |
| ファイルツリーの行                              | `?`                       | `?`                       | この場所のキーの一覧を出す（リーダーの `?` と同じ窓。この場所のキーを先に出す）                | `features/commands/placeKeys.ts`・`ui/main-window/sidebar/file-tree/TreeView.tsx`                    |
| CHANGES の行（フォーカスがあるとき）            | `j` / `↓`                 | `j` / `↓`                 | 次の行へ                                                                                       | `features/changes/keys.ts:58`・`ui/main-window/sidebar/changes/ChangesView.tsx:93`     |
| CHANGES の行                                    | `k` / `↑`                 | `k` / `↑`                 | 前の行へ                                                                                       | `features/changes/keys.ts:61`                                   |
| CHANGES の行                                    | `g` / `Home`              | `g` / `Home`              | 最初の行へ                                                                                     | `features/changes/keys.ts:64`                                   |
| CHANGES の行                                    | `G` / `End`               | `G` / `End`               | 最後の行へ                                                                                     | `features/changes/keys.ts:67`                                   |
| CHANGES の行                                    | `h` / `←`                 | `h` / `←`                 | 開いたフォルダは閉じる。ほかは親のフォルダの行へ                                               | `features/changes/keys.ts:70`                                   |
| CHANGES の行                                    | `l` / `→`                 | `l` / `→`                 | フォルダは開く。変更の行は差分を開く（shj.diff）                                               | `features/changes/keys.ts:75`                                   |
| CHANGES の行                                    | `Enter` / `o`             | `Enter` / `o`             | フォルダは開け閉め。変更の行は差分を開く                                                       | `features/changes/keys.ts:78`                                   |
| CHANGES の行                                    | `s`                       | `s`                       | shj に渡す（split / unified の切り替え）                                                       | `features/changes/keys.ts:81`・`ui/main-window/sidebar/changes/actions.ts:52`          |
| CHANGES の行                                    | `r` / `R`                 | `r` / `R`                 | shj に渡す（読み直し。PR モードでは PR を読み直す）                                            | `features/changes/keys.ts:82`                                   |
| CHANGES の行                                    | `:`                       | `:`                       | shj に渡す（コマンド行）。続きのキーは端末から shj に届く                                      | `features/changes/keys.ts:84`                                   |
| CHANGES の行                                    | `Space`                   | `Space`                   | shj に渡す（Space メニュー）。PR モードでは続けて `v`（レビュー）・`g`（PR との差分）を打つ    | `features/changes/keys.ts:86`・`features/changes/keys.ts:177`            |
| CHANGES の行                                    | `?`                       | `?`                       | この場所のキーの一覧を出す（shj には渡さない）                                                 | `features/commands/placeKeys.ts`・`features/changes/keys.ts`・`ui/main-window/sidebar/changes/actions.ts` |
| CHANGES の行                                    | `Tab`（Shift なし）       | `Tab`（Shift なし）       | ファイルツリー（kisui のエクスプローラ）へ移る。Shift+Tab は既定の動き                         | `features/changes/keys.ts:88`・`ui/main-window/sidebar/changes/actions.ts:56`          |
| CHANGES の行                                    | `Esc` / `q` / Ctrl+E               | `Esc` / `q` / Ctrl+E               | 一覧を出て端末（shj のエディタ）へ戻る                                                                           | `features/changes/keys.ts:90`・`ui/main-window/sidebar/changes/actions.ts:60`          |
| ファイルツリー・CHANGES のどちらも              | Ctrl・Cmd・Alt を押したキー | Ctrl・Cmd・Alt を押したキー | 受けない（窓全体のキーに残す）。ただし Ctrl+E だけは、ツリーでも CHANGES でも端末へ戻る。かな漢字変換中も受けない                                       | `features/file-tree/keys.ts:44`・`features/changes/keys.ts:54`・`features/commands/guiKeys.ts:81`               |

shj の側から `Space e` でツリーにキーを向けるのは、shj が出す `explorer` のイベント（`features/workspaces/paneEvents.ts`）で、GUI のキーの割り当てではない。

shj を引数なしで起動した直後は、kisui が同じ `explorer` の通知を自分で出して、ツリーにキーを向ける（単独の shj がツリーから始まるのと同じ）。`shj <ファイル>` で起動したとき、つなぎ直したとき、kisui serve を入れ替えたときは向けない。

### 1.5 動画のペイン

動画のペイン（`.video-cell`）にフォーカスがあるとき。`Ctrl`・`Alt`・`Cmd` を押したキーは受けない（全体のキーなどに回る）。

| どこで         | Mac のキー      | Linux のキー    | 動き                           | 定義の場所                                    |
| -------------- | --------------- | --------------- | ------------------------------ | --------------------------------------------- |
| 動画のペイン       | `Space` / `k`   | `Space` / `k`   | 再生・一時停止                 | `features/terminal/media.ts:107`・`ui/main-window/content/media/VideoView.tsx:44` |
| 動画のペイン       | `←`             | `←`             | 5 秒戻る（Shift 付きは受けない） | `features/terminal/media.ts:110`                       |
| 動画のペイン       | `→`             | `→`             | 5 秒進む（同上）               | `features/terminal/media.ts:112`                       |
| 動画のペイン       | `j`             | `j`             | 10 秒戻る                      | `features/terminal/media.ts:114`                       |
| 動画のペイン       | `l`             | `l`             | 10 秒進む                      | `features/terminal/media.ts:116`                       |
| 動画のペイン       | `m`             | `m`             | 消音の入り・切り                | `features/terminal/media.ts:118`                       |
| 動画のペイン       | `?`             | `?`             | この場所のキーの一覧を出す      | `features/terminal/media.ts`・`features/commands/placeKeys.ts`           |

### 1.5.1 画像のペイン

画像のペイン（`kisui open --pane` と shj の `image` の要求で開いたもの。種類 `image` の `FileView`）にフォーカスがあるとき。`Ctrl`・`Alt`・`Cmd` を押したキーは受けない（全体の倍率の Cmd+= などは重ならない）。倍率 1 はペインに収めた大きさ（0.25〜16 倍）。

| どこで   | Mac のキー                  | Linux のキー                | 動き                                                       | 定義の場所                                              |
| -------- | --------------------------- | --------------------------- | ---------------------------------------------------------- | ------------------------------------------------------- |
| 画像のペイン | `+` / `=`                   | `+` / `=`                   | 拡大（1.25 倍）                                            | `ui/main-window/content/media/imageView.ts`（`imageKey`）・`ui/main-window/content/media/FileView.tsx` |
| 画像のペイン | `-`                         | `-`                         | 縮小                                                       | 同上                                                    |
| 画像のペイン | `0`                         | `0`                         | ペインに収まる大きさに戻す                                     | 同上                                                    |
| 画像のペイン | `h` `j` `k` `l`・矢印（Shift 付きは受けない） | 同左 | 拡大中に見える場所を動かす（見える幅の 10%）               | 同上                                                    |
| 画像のペイン | `Esc`                       | `Esc`                       | ターミナルへ戻る                                           | 同上（`ui/main-window/content/ContentArea.tsx` の `onLeaveExtra`）                     |
| 画像のペイン | `?`                         | `?`                         | キーの一覧（リーダーの `?` と同じ窓）を出す                | `features/commands/placeKeys.ts`・`ui/main-window/commands/KeyListDialog.tsx`                     |
| 画像のペイン | Ctrl+ホイール・ピンチ       | Ctrl+ホイール・ピンチ       | ポインタの位置を中心に拡大・縮小                           | `ui/main-window/content/media/FileView.tsx`                                 |
| 画像のペイン | ドラッグ                    | ドラッグ                    | 拡大中に画像を動かす                                       | 同上                                                    |

### 1.6 窓・メニューの中

| どこで                                                          | Mac のキー                   | Linux のキー                 | 動き                                                                                                  | 定義の場所                                                                         |
| --------------------------------------------------------------- | ---------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| クリップボードの履歴の窓（Cmd+Shift+H / Ctrl+Shift+H で開いたもの）の入力欄 | `↑` / `↓`・`Ctrl+J` / `Ctrl+K`                    | `↑` / `↓`・`Ctrl+J` / `Ctrl+K`                    | 選んでいる行を動かす（端で止まる。Ctrl+J が次、Ctrl+K が前）                                                                    | `ui/main-window/clipboard/ClipboardHistoryDialog.tsx:143`・`features/clipboard/history.ts:61`                          |
| 同上                                                            | `Enter`                      | `Enter`                      | 貼る（開いたときに貼るペインが無ければ、クリップボードに戻す）                                            | `ui/main-window/clipboard/ClipboardHistoryDialog.tsx:151`                                                   |
| 同上                                                            | `Shift+Enter`                | `Shift+Enter`                | OS のクリップボードに戻す（「コピーしました」を 0.6 秒ほど出してから閉じる）                                                                           | `ui/main-window/clipboard/ClipboardHistoryDialog.tsx:150`                                                   |
| 同上                                                            | `Esc`                        | `Esc`                        | 閉じる（`<dialog>` の cancel）                                                                        | `ui/components/Card.tsx:49`                                                              |
| 同上                                                            | 文字を打つ                   | 文字を打つ                   | 履歴を絞り込む（空白で区切った語がすべて含まれるもの）                                                | `features/clipboard/history.ts:48`                                                           |
| `kisui-terminal` の外から開く履歴の窓（Option+Space / Alt+Space）| `↑` / `↓`・`Ctrl+J` / `Ctrl+K`・`Enter`・文字 | `↑` / `↓`・`Ctrl+J` / `Ctrl+K`・`Enter`・文字 | 上の窓と同じ。Enter は OS のクリップボードに戻し、「コピーしました」を 0.6 秒ほど出してから窓を隠す（貼るのは自分で Cmd+V / Ctrl+V）           | `ui/utilities/clipboard/page.tsx:28`・`ui/main-window/clipboard/ClipboardHistoryDialog.tsx:122`                   |
| 同上                                                            | `Esc`                        | `Esc`                        | 何もせず閉じて、前のアプリに戻る（かな漢字変換中は除く）                                              | `ui/utilities/clipboard/page.tsx:28`                                                     |
| ワークスペースを切り替える窓（リーダーの `w`） | `j` `k` / `↓` `↑`・`Ctrl+J` / `Ctrl+K`・`Enter`・`Esc`・`J` `K`・`n`・`r`・`x` | 同左 | 移る：`j` `k` で選ぶ行を動かし（端で止まる。右にその行のワークスペースのタブの行が出る）、`Enter` でそのワークスペースへ移って窓を閉じ、`Esc` で何もせず閉じる。変える：`n` はワークスペースを作る（窓を閉じて、今の「ワークスペースを作る」と同じ流れに入る。「+ ワークスペースを作る」の行にも `n` を出す）、`r` は選んでいる行の名前を、行の中の入力欄で変える（`Enter` で決め、`Esc` でやめる。空にすると番号の名前に戻る。日本語の変換を確定する `Enter` では決めない）、`x` は選んでいる行のワークスペースを閉じる（先にその行で `y` / `n` を聞く。`y` で閉じ、`n` か `Esc` でやめる。確認の間は、ほかのキーは何もしない）、`J` `K`（Shift+j・Shift+k）は選んでいるワークスペースを 1 つ下・上へ並べ替える。番号の `1`〜`9` と `Tab`（直前）は無い。打った字で絞り込む入力欄は無い。下の説明は、「移る」と「変える」の 2 列の表 | `ui/main-window/workspaces/WorkspaceSwitcher.tsx`・`ui/main-window/workspaces/switcherKey.ts`・`ui/main-window/workspaces/SwitcherParts.tsx` |
| ワークスペースを作るマシンを選ぶ窓（窓の `n`） | `j` `k` `g` `G` / `↓` `↑` `Home` `End`・`Ctrl+J` / `Ctrl+K`・`Enter` | 同左 | 選ぶマシンを動かし（端で止まる）、`Enter` でそのマシンにワークスペース（`t N` のときはターミナルのタブ）を作る。`Esc` でやめる | `ui/main-window/sessions/MachinePicker.tsx`・`features/sessions/machineList.ts`（`pickerKey`） |
| ワークスペースの種類（ターミナルかブラウザか）を選ぶ窓（窓の `n`。内蔵ブラウザを有効にしているとき） | `j` `k` `g` `G` / `↓` `↑` `Home` `End`・`Ctrl+J` / `Ctrl+K`・`Enter` | 同左 | 選ぶ種類を動かし（端で止まる）、`Enter` で決める（ターミナルならマシンを選ぶ窓へ、ブラウザならブラウザのタブだけのワークスペースを作る）。`Esc` でやめる | `ui/main-window/workspaces/WorkspaceKindPicker.tsx`・`features/sessions/machineList.ts`（`pickerKey`） |
| キャラクターを選ぶ窓（リーダーの `c s`） | `j` `k` `g` `G` / `↓` `↑` `Home` `End`・`Ctrl+J` / `Ctrl+K`・`Enter` | 同左 | 選ぶキャラクターを動かし（端で止まる）、`Enter` で決める（`config.local.toml` に書いて読み込む）。使えないキャラクターは理由を窓に出して選ばない。`Esc` でやめる | `ui/main-window/mascot/MascotDialog.tsx`・`features/sessions/machineList.ts`（`pickerKey`） |
| マシンのダイアログ（リーダーの `m`） | `j` `k` `g` `G` / `↓` `↑` `Home` `End`・`Ctrl+J` / `Ctrl+K` | 同左 | 選んでいるマシンを動かす（端で止まる）。入力欄が無いので、字をそのまま使える | `ui/main-window/sessions/MachineDialog.tsx`・`features/sessions/machineList.ts`（`machineKey`） |
| 同上 | `a` | `a` | マシンを足す（リモートを足す窓を、このダイアログの上に出す） | 同上 |
| 同上 | `n` `d` | `n` `d` | 選んでいるマシンの名前を変える・一覧から外す。設定ファイルで決めたマシンと「ローカル」には使えず、理由をダイアログに出す | 同上 |
| 同上 | `x` `r` | `x` `r` | 選んでいるマシンを切る・つなぎ直す（待ち時間中は今すぐつなぐ）。つながっていない・つなぐ必要が無いときは、理由をダイアログに出す | 同上 |
| 同上 | `?` | `?` | このダイアログのキーの一覧を出す | 同上 |
| リモートを足す窓の「行き先」のペイン                                | `↓` / `↑`・`Ctrl+J` / `Ctrl+K`                    | `↓` / `↑`・`Ctrl+J` / `Ctrl+K`                    | `~/.ssh/config` の候補を選ぶ（Ctrl+J が次、Ctrl+K が前）                                                                          | `ui/main-window/sessions/AddMachine.tsx:83`                                                        |
| 同上                                                            | `Enter`                      | `Enter`                      | 選んだ候補を入れる。選んでいなければ足す                                                              | `ui/main-window/sessions/AddMachine.tsx:88`                                                        |
| リモートを足す窓の「名前」のペイン                                  | `Enter`                      | `Enter`                      | 足す                                                                                                  | `ui/main-window/sessions/AddMachine.tsx:139`                                                       |
| マシンの名前を変える窓の入力欄                                  | `Enter`                      | `Enter`                      | 名前を変える                                                                                          | `ui/components/dialogs/RenameDialog.tsx:37`                                                     |
| ワークスペースの帯の名前の入力欄                                | `Enter`                      | `Enter`                      | 名前を変える（空なら「ws1」のような番号の名前に戻す）。長すぎる名前などは、入力欄の下に理由を出し、開けたままにする            | `ui/main-window/sidebar/Sidebar.tsx`・`ui/main-window/sidebar/renameInput.ts`                                   |
| 同上                                                            | `Esc`                        | `Esc`                        | やめる（キーはターミナルに戻る）。フォーカスが外れてもやめる                                          | `ui/main-window/sidebar/Sidebar.tsx`・`ui/main-window/sidebar/renameInput.ts`                                   |
| ssh の質問の窓の入力欄 | `Enter` | `Enter` | 答えを返す（`<form>` の submit）。`Esc` は答えずに閉じる（`ModalCard`） | `ui/main-window/sessions/AskpassDialog.tsx:35`・`ui/main-window/sessions/AskpassDialog.tsx:37` |
| ツリーの新規作成・名前の変更の窓の入力欄                        | `Enter`                      | `Enter`                      | 決める                                                                                                | `ui/main-window/sidebar/file-tree/TreeDialogs.tsx:57`                                                          |
| 窓（`ModalCard`）                                               | `Esc`                        | `Esc`                        | 閉じる（キャンセル）。リモートを足す・名前を変える・ツリーの窓・履歴の窓・確認の窓など、どれも同じ    | `ui/components/Card.tsx:49`                                                              |
| ツリーの右クリックのメニュー                                    | `↓` / `↑`                    | `↓` / `↑`                    | 項目を選ぶ（端でぐるっと回る）                                                                        | `ui/main-window/sidebar/file-tree/TreeMenu.tsx:22`                                                             |
| 同上                                                            | `Esc`                        | `Esc`                        | メニューを閉じる                                                                                      | `ui/main-window/sidebar/file-tree/TreeMenu.tsx:23`                                                             |
| ワークスペースの帯の右クリックのメニュー                        | `↓` / `↑`                    | `↓` / `↑`                    | 項目を選ぶ（同上）                                                                           | `ui/main-window/sidebar/Sidebar.tsx`                                                              |
| 同上                                                            | `Esc`                        | `Esc`                        | メニューを閉じる                                                                                      | `ui/main-window/sidebar/Sidebar.tsx`                                                          |

メニューの項目や窓のボタンは、`Tab` でフォーカスを動かして `Enter` / `Space` で押せる（ブラウザの既定の動き。割り当てではない）。

### 1.7 kisui-terminal が割り当てていないキー

次のキーは、ペインの中のプログラムか WebView に任せていて、kisui-terminal は割り当てを持たない。

- ターミナルのペインの中の字・Ctrl・Alt のキー、貼り付け、マウスの報告：`coneko-term` が受けて（`ui/main-window/content/terminal/TerminalView.tsx:88`）、バイト列にして shj やシェルへ送る。Mac の `Cmd+C` でのコピーはしない（選んで離すとコピーする。2.1 の表）。
- 上の表に無い Ctrl・Cmd・Alt 付きのキー：全体のキーに当たらなければ、そのままペインに届く。

## 2. マウスでしかできない操作

キーが無い操作だけを書く（キーでもできるものは 1 の表に書いた）。

### 2.1 ターミナルのペイン

| どこで                       | 操作                                                                 | 動き                                                                                                                                                     | 定義の場所                                                            |
| ---------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| ターミナルのペイン               | 文字をドラッグで選んで離す                                           | 選んだ文字を OS のクリップボードに入れ、知らせを出す（プログラムがマウスを受けている間は選択が変わらないので、コピーしない）                             | `ui/main-window/content/terminal/TerminalView.tsx:261`・`ui/main-window/content/terminal/selectionCopy.ts:6`        |
| ターミナルのペイン               | 出ている URL を Cmd+クリック（Mac）/ Ctrl+クリック（Linux）          | 内蔵ブラウザを有効にしていれば、今のワークスペースの新しいタブで開く。無効なら OS 既定のブラウザで開く（#203）。URL には波線が付く                                                   | `features/terminal/urlOpen.ts`・`ui/main-window/content/terminal/TerminalView.tsx:91`・`features/browser/pages.ts` の `openUrl` |
| ターミナルのペイン               | URL を Cmd+Shift+クリック（Mac）/ Ctrl+Shift+クリック（Linux）       | Cmd+クリックと同じ（マウスの報告を有効にしたアプリが動いていても届く）                                                                                                                                           | `features/terminal/urlOpen.ts`                                              |
| ターミナルのペイン               | URL を Cmd+Option+クリック（Mac）/ Ctrl+Alt+クリック（Linux）。Shift を足しても同じ | 内蔵ブラウザの有無にかかわらず、OS 既定のブラウザで開く（#203）                                                                                                                                           | `features/terminal/urlOpen.ts`                                              |
| ターミナルのペイン               | OS からテキストやファイルをドロップ                                  | 受け付けているプログラムにだけ渡す（受け付けていなければ何もしない）。ほかのペイン・窓へのドロップは断る                                                     | `ui/main-window/content/terminal/TerminalView.tsx:218`・`ui/main-window/content/terminal/TerminalView.tsx:236`・`index.tsx:10` |
| ペイン（ターミナル・動画・ファイル） | ペインを押す                                                             | そのペインに GUI のフォーカスを移す                                                                                                                          | `ui/main-window/content/media/VideoView.tsx:65`・`ui/main-window/content/media/FileView.tsx:89`・`ui/main-window/content/terminal/TerminalView.tsx:355`（`onFocusIn`） |

### 2.2 境界とリサイズ

| どこで                         | 操作                         | 動き                                                          | 定義の場所                                    |
| ------------------------------ | ---------------------------- | ------------------------------------------------------------- | --------------------------------------------- |
| サイドバーとターミナルの境界   | ドラッグ                     | サイドバーの幅を変える（200〜640px。覚えておく）              | `ui/main-window/paneResize.ts` の `dragBorder`・`ui/main-window/layout.tsx`・`ui/main-window/panes.ts:23`  |
| 同上                           | ダブルクリック               | 幅を元（300px）に戻す                                         | `ui/main-window/layout.tsx`                                |
| タブの段とファイルツリーの境目 | ドラッグ                     | タブの段の高さの上限を変える。下へ動かすと高くなる（サイドバーの高さの 10〜90%。覚えておく）。`shj` が動いていて、ブラウザのタブを出していないときだけある | `ui/main-window/paneResize.ts` の `dragTabs`・`ui/main-window/sidebar/Sidebar.tsx`・`ui/main-window/panes.ts` |
| 同上                           | ダブルクリック               | 上限を設定 `[gui.sidebar] tabs-height` の値（無ければ 40%）に戻す | `ui/main-window/paneResize.ts` の `resetSize`・`ui/main-window/sidebar/Sidebar.tsx`              |
| ファイルツリーと CHANGES の境目（CHANGES の上の縁） | ドラッグ                     | CHANGES の一覧の高さを変える。上へ動かすと高くなる（44〜640px で、窓の高さの半分まで。覚えておく） | `ui/main-window/paneResize.ts` の `dragChanges`・`ui/main-window/sidebar/changes/ChangesView.tsx`・`ui/main-window/panes.ts` |
| 同上                           | ダブルクリック               | 高さを元（143px）に戻す                                       | `ui/main-window/paneResize.ts` の `resetSize`・`ui/main-window/sidebar/changes/ChangesView.tsx`          |
| ペインどうしの境界（隙間のつまみ） | ドラッグ                     | 境界の割合を変える（両側の最小の大きさまで）                  | `ui/main-window/content/terminal/TerminalGrid.tsx:123`・`ui/main-window/content/terminal/TerminalGrid.tsx:252` |
| 同上                           | ダブルクリック               | 割合を 50% に戻す                                             | `ui/main-window/content/terminal/TerminalGrid.tsx:253`               |

### 2.3 サイドバー

| どこで                              | 操作                         | 動き                                                                                               | 定義の場所                                |
| ----------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| ワークスペースの帯                  | クリック                     | そのワークスペースに移り、そのワークスペースが出していたもの（ターミナルのタブか、ブラウザのページ）を出す（#231。前は、ブラウザのタブを出していてもターミナルのグリッドに戻った）。キーでは、窓（リーダーの `w`）の `j` `k` `Enter` | `ui/main-window/sidebar/Sidebar.tsx:511`                 |
| ワークスペースの帯の下のタブの行（ターミナルのタブ・ブラウザのタブ） | クリック                     | そのワークスペースに移り、そのタブを出す（キーでは `t j` `t k` `t 1`〜`t 9`）。つながっていないマシンのターミナルのタブは薄く出て、押すとつなぎ直す案内を出す | `ui/main-window/sidebar/Sidebar.tsx` の `BandTabRows`     |
| タブの行の ×                        | クリック                     | タブを閉じる（キーでは `t x`。ブラウザのタブは `o x` でも）。最後のタブの行の × で閉じると、ワークスペースも閉じる                                                                     | `ui/main-window/sidebar/Sidebar.tsx` の `BandTabRows`     |
| タブの行の左端の「つかむ所」（縦の点 3 つ）・切り替えの窓の左の行 | ドラッグ（上下だけ。Esc でやめる） | ワークスペースを並べ替える（窓の左の行。マシンをまたいだ 1 列の中で。キーでは、窓の `J` `K`）・タブの行を同じワークスペースの中で並べ替える（別のワークスペースへは移せない。キーでは `t J` `t K`）。並びは覚えて、再起動しても残る。一覧の端に寄せると自動でスクロールする（#236） | `ui/main-window/sidebar/Sidebar.tsx` の `Grip`・`ui/main-window/sidebar/drag.ts` |
| ワークスペースの帯の ×              | クリック                     | ワークスペースを閉じる：中のターミナルのタブを全部閉じ、ブラウザのタブも閉じる（確認の窓が出る）。つながっていないマシンのタブは、閉じられないので記録から外すだけ | `ui/main-window/sidebar/Sidebar.tsx:540`                 |
| ワークスペースの帯の鉛筆            | クリック                     | 帯の名前をその場で入力欄にする（`Enter` で決め、`Esc` でやめる。空にすると「ws1」のような番号の名前に戻る）。キーでは、窓（リーダーの `w`）の `r` | `ui/main-window/sidebar/Sidebar.tsx`                     |
| ワークスペースの帯                  | 右クリック                   | メニュー（名前を変える）を出す。「名前を変える」は鉛筆と同じ入力欄を開く。キーでは、窓（リーダーの `w`）の `r`          | `ui/main-window/sidebar/Sidebar.tsx`                     |
| 切り替える窓の「ワークスペースを作る」・今のワークスペースが無いときのサイドバーの「ワークスペースを作る」（#283） | クリック                     | ターミナルかブラウザかを選ぶ窓（内蔵ブラウザを無効にしていれば、どのマシンに作るかを選ぶ窓）を出す（つながっているマシンが 1 つだけなら、マシンは聞かずにそこへ作る。キーでは、窓の `n`）。マシンの操作（足す・名前を変える・外す・切る・つなぎ直す）はサイドバーには無く、リーダーの `m` のダイアログにある | `ui/main-window/workspaces/WorkspaceSwitcher.tsx`・`ui/main-window/sidebar/Sidebar.tsx` |
| ファイルツリーの行                  | クリック                     | フォルダの開け閉め・ファイルを開く（キーでは Enter / Space / l / h でできる）                      | `ui/main-window/sidebar/file-tree/TreeView.tsx:201`                   |
| ファイルツリーの行                  | 右クリック                   | メニュー（名前・相対パス・絶対パスをコピー、新しいファイル・フォルダ、名前の変更、削除、ここへ移動）を出す（キーでは `.` か `Menu` で同じメニューを開ける。「ここへ移動」は `m`、「名前をコピー」は `c`） | `ui/main-window/sidebar/file-tree/TreeView.tsx:202`・`features/file-tree/menu.ts:7`・`features/file-tree/menu.ts:30` |
| ツリーのメニューの項目              | クリック                     | 選んだ項目を行う（キーは 1.4）                                                                     | `ui/main-window/sidebar/file-tree/TreeMenu.tsx:70`                    |
| CHANGES の行                        | クリック                     | フォルダの開け閉め・差分を開く                                                                     | `ui/main-window/sidebar/changes/ChangeTreeRow.tsx:34`・`ui/main-window/sidebar/changes/ChangesView.tsx:89` |
| CHANGES の行（PR モード）の viewed の `[ ]` `[x]` | （操作は無い） | 確認済みかを出すだけの表示。クリックもキーも受けない | `ui/main-window/sidebar/changes/ChangeTreeRow.tsx:60` |

### 2.4 ペインのヘッダのボタン

| どこで                       | 操作       | 動き                                                           | 定義の場所                          |
| ---------------------------- | ---------- | -------------------------------------------------------------- | ----------------------------------- |
| 動画のペインの ×                 | クリック   | 動画のペインを閉じる                                               | `ui/main-window/content/media/VideoView.tsx:76`         |
| ファイル（画像・PDF）のペインの × | クリック   | ペインを閉じる                                                     | `ui/main-window/content/media/FileView.tsx:100`         |

動画のペインのシークバー・音量など、`<video>` の部品は WebView の既定の動き。

### 2.5 窓とお知らせ

| どこで                                   | 操作                              | 動き                                                       | 定義の場所                                                        |
| ---------------------------------------- | --------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------- |
| クリップボードの履歴の窓の行             | クリック / ダブルクリック         | 行を選ぶ / 選んで貼る（なければ戻す）                      | `ui/main-window/clipboard/ClipboardHistoryDialog.tsx:253`・`ui/main-window/clipboard/ClipboardHistoryDialog.tsx:254` |
| クリップボードの履歴の窓の ✕ | クリック | 閉じる（Esc と同じ。下のボタンは無い。戻すのは Shift+Enter、貼るのは Enter か行のダブルクリック） | `ui/main-window/clipboard/ClipboardHistoryDialog.tsx` の `history-close` |
| マシンのダイアログの行 | クリック | その行のマシンを選ぶ（操作はキーで。`a` `n` `d` `x` `r`） | `ui/main-window/sessions/MachineDialog.tsx` |
| キャラクターを選ぶ窓の行 | クリック / ダブルクリック | 行を選ぶ / 選んで決める（キーでは `j` `k` と `Enter`） | `ui/main-window/mascot/MascotDialog.tsx` |
| 窓（リモートを足す・名前を変える・ツリーの窓・確認・ssh の質問・クリップボードや転送の許可・ワークスペースを閉じる・kisui を入れる） | ボタンをクリック | 決める・やめる（キーでは入力欄の Enter と Esc だけ）。確認の窓のボタンは、キーでは Tab でフォーカスを動かして Enter で押す | `ui/main-window/sessions/AddMachine.tsx:162`・`ui/components/dialogs/RenameDialog.tsx:53`・`ui/main-window/sidebar/file-tree/TreeDialogs.tsx:85`・`ui/main-window/workspaces/CloseWorkspaceCard.tsx:34`・`ui/main-window/sessions/InstallCard.tsx:49`・`ui/main-window/sessions/AskpassDialog.tsx:66`・`ui/main-window/clipboard/ClipboardDialog.tsx:34`・`ui/main-window/file-transfer/TransferDialog.tsx:91` |
| リモートを足す窓の候補                   | クリック                          | 候補の行き先を入れる                                       | `ui/main-window/sessions/AddMachine.tsx:120`                                      |
| 右下のお知らせ（つながらない・引き継がれた） | ボタンをクリック              | お知らせのボタンの動き                                     | `ui/main-window/notifications/Notices.tsx:53`・`ui/main-window/notifications/Notices.tsx:63`                |
| 右下の「新しい版があります」             | 「あとで」「更新」をクリック      | 閉じる・更新して起動し直す                                 | `ui/main-window/notifications/UpdateBar.tsx:60`・`ui/main-window/notifications/UpdateBar.tsx:63`              |
| OS の通知                                | クリック                          | 通知に `a=focus` があれば、そのペインを前に出す                | `ui/main-window/content/terminal/TerminalView.tsx:118`                                   |

## 3. 気づいたこと（表を作って分かったもの。変える・変えないはこの Issue では決めない）

この章は、#92 より前のコードを見て書いたまま残してある。#92 で、リーダーに入れたキー（ワークスペースを閉じる・マシンの操作・ワークスペースを作る・Linux の分割したペインを閉じる操作）はキーでできるようになり、Mac の Ctrl+Shift の別名・Ctrl+Shift+矢印・Linux の Ctrl+`-` は消えた。

- Mac と Linux で形が違う：分割は Mac が Cmd+D / Cmd+Shift+D、Linux が Ctrl+Shift+D / Ctrl+Shift+E。Cmd+W（分割したペインを閉じる）は Mac だけで、Linux には同じ操作のキーが無い。リサイズモードに入るのは Cmd+R / Ctrl+Shift+R。
- Mac でも効く Ctrl+Shift の形がある：Ctrl+Shift+矢印（ペインの移動）と Ctrl+Shift+M（ペインを隠す）は Mac でも受ける（`directionKey`・`isZoomKey` は `isCtrlShift` を Mac でも見る）。分割とリサイズに入るキーは Mac では Ctrl+Shift の形を受けない。
- キーでできないもの：ワークスペースを閉じる・マシンを足す・マシンを切る／外す／名前を変える・つなぎ直す・ワークスペースを作る・動画のペインとファイルのペインの ×（ペインを閉じる）・Linux の分割したペインを閉じる操作・ペインどうしのフォーカス移動以外のペインの選択は、マウスだけ（2 の表）。
- 同じ字のキーが場所ごとに別の意味：`j` `k` `l` `h` はツリー・CHANGES・リサイズモードで移動、動画のペインでは `j` `l` が 10 秒の移動、`k` が再生・停止。`r` はツリーでは名前の変更、CHANGES では読み直し、リサイズモードでは何もしない。`Esc` はツリーでは端末へ戻る、CHANGES では一覧を出る、窓・メニューでは閉じる、リサイズモードでは出る。
- 全体のキーが、ターミナルのペインの外（ツリー・CHANGES・動画のペイン・窓の中）でも効くものと、ペインの中だけで効くもの（ペインの移動・Cmd+W）が混ざっている。
- `Ctrl`+`-`（Linux の表示を小さく）は、端末の `C-_`（readline の undo）を奪う（`features/scale/scale.ts:25` に承知の上と書いてある）。
