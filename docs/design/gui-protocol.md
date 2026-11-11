# GUI 版の設計：GUI と shj のプロトコル、`internal/ui` の切り離し方

Issue #270 の設計書（親は #271）。決めるのは次の 2 つ。

1. GUI と shj の間のプロトコル（JSON-RPC）。
2. `internal/ui` を「中身」と「TUI の描画」に分ける方法と順番。

この文書は設計だけで、コードは変えない。実装は末尾の一覧を Issue にして進める。画面のデザインは扱わない（ユーザーと決めたモックを使う）。

**2026-11-06 の方針変更（#549〜#557）**：GUI はターミナルマルチプレクサ（マシン・ワークスペース・ターミナルの欄・ファイルツリー）を受け持ち、編集は GUI のターミナルの欄の中で TUI の `shj` を動かして行う。TUI と GUI の機能を揃える方式はやめた。#557 で、GUI のファイルの欄（編集画面）と、それを支えた `kisui serve` の中の編集の部品（ワークスペースごとの `core`、画面と入力のプロトコル、制御用ソケットと Claude Code 連携、言語サーバーと整形の起動）を外した。プロトコルの `major` は 4。この文書の画面（`Screen`）を GUI へ送る話は、外したものを「（#557 で外した）」と書いて残し、今もある部分と区別する。

## 方針（決まっていること）

- GUI の殻は Tauri。画面は Web（WebView）。対応 OS は Linux と macOS。
- 中身の shj は Go のまま。将来 GPU で描くネイティブの画面にするときは、画面を描く部分だけを Rust で作り、shj とはこのプロトコルでつなぐ。だからプロトコルは Web にもネイティブにも使える形にする（ブラウザの API や DOM を前提にしない）。
- 編集は GUI のターミナルの欄（プライマリ）の中で動く TUI の `shj` がする。GUI は編集画面を持たず、キーやマウスを `kisui serve` に送って編集させることもしない。Helix 風のキー操作を GUI で作り直さない（#557）。
- GUI にしかできないもの（動画など）だけを、あとから GUI の欄として足す。
- 「ローカル」の shj も、リモートと同じプロトコルで話す。
- TUI は中身（`core`）と同じプロセスで動く。TUI は core の関数を直接呼び、core からの呼び出し（Port）も直接受ける。`kisui serve` は `core` を持たない（以前は、同じ境目を JSON-RPC に直すアダプターとして `core` をワークスペースごとに持っていた。#557 で外した）。
- ターミナルは「画面に何を出すか」に変換しない。PTY の出力をそのまま GUI（coneko-term）に流し、入力もそのまま PTY に流す。
- GUI を閉じても、リモートの shj とシェルは動き続ける。7 日間（`config.toml` で変更可）どの GUI からもつながらなければ、shj は自分で止まる。
- 2 台の GUI が同じ shj につないだら、あとからつないだほうに引き継ぐ。

## 全体像

```
手元                                      各マシン（「ローカル」も同じ）
┌────────────────────┐                   ┌───────────────────────────────────────┐
│ GUI (Tauri + Web)  │  ssh の標準入出力    │ kisui attach ──┐ （ssh が切れたら終わる） │
│  ・サイドバー        │ ◀─── JSON-RPC ───▶ │              ▼ Unix ソケット          │
│  ・ターミナルの欄    │                   │ kisui serve （ssh から切り離して動く）   │
│  ・coneko-term    │                   │  ├ ワークスペース（フォルダ・ターミナル）│
└────────────────────┘                   │  ├ ターミナル管理（PTY・cwd の監視）    │
                                          │  ├ ツリー・git                        │
                                          │  └ プライマリの shj との連携           │
                                          └───────────────────────────────────────┘
                                                  ▲ serve-primary.rpc
プライマリのターミナルの中:  shj  =  core + TUI の描画  （同じプロセス、関数を直接呼ぶ）
```

- `kisui serve`：画面を持たない（headless）常駐プロセス。編集はせず、ワークスペース・ターミナル・ファイルツリー・プライマリの `shj` との連携だけを持つ。ユーザーごと・チャンネルごと（nightly は別）に 1 つ。
- `kisui attach`：ssh の先で動く小さな橋渡し。標準入出力と `kisui serve` の Unix ソケットをつなぐ。ssh が切れると終わるが、`kisui serve` は残る。
- ソケットの置き場所は今の制御用ソケットと同じ作り（`$XDG_RUNTIME_DIR/shijimi-<uid>/`、0700。nightly は `shijimi-nightly-<uid>`）。

## 1. 中身と TUI の描画の境目

この章は `core` を TUI の描画から切り出したときの設計で、今も TUI の構造として生きている。GUI が `Screen` を受け取る部分（`kisui serve` の中のアダプター、GUI の描画）は #557 で外したので、GUI に触れた文は当時の設計の記録として読む。`core/screen` は TUI が描くためのデータとして残る。

### 3 つに分ける

| 部品 | 持つもの | 依存してよいもの |
| --- | --- | --- |
| 中身（`core`） | 編集・補完・LSP・差分・検索・エージェントなどの状態。入力を受け取り、「画面に何を出すか」（`Screen`）を作る | `buffer`・`lsp`・`config` など。bubbletea・lipgloss・端末のマス目の幅は使わない |
| TUI の描画 | `Screen` を文字のマス目にして描く。端末の大きさ、ペインの幅、端末の機能（キーを離した通知、カーソルの位置）を持つ | `core`、bubbletea |
| GUI の描画（#557 で外した） | プロトコルで受け取った `Screen` を描く | プロトコルだけ（Tauri の Web 画面） |

`core/screen`（`Screen` のデータ型だけ。外に依存しない）を作る。`core` が作り、TUI の描画とプロトコルが読む。

### core が知る相手は Port だけ

境目は UI の種類によらない形にする。core は 1 つのインターフェース（以下 Port）だけを知り、TUI がそれを満たす（GUI 用のアダプターが `kisui serve` の中にあったが、#557 で外した）。UI から core へは `Input` と `core.Screen()`、core から UI へは Port の呼び出しで、どちらも相手が TUI か GUI かで形が変わらない。

Port のメソッドの条件は 2 つ。

1. **どの UI でも同じ意味になる**。「通知を出す」「終了する」「クリップボードに書く」のように、UI の違いに左右されない言い方にする。「ターミナルのパネルを開く」「境目をドラッグする」のように、特定の UI の部品を前提にした言い方は入れない。
2. **戻り値を待たない**。core は呼んだら先へ進む。答えが要るときは、UI が後から `Input` で core に返す。GUI へ運ぶときに JSON-RPC の往復を待たずに済み、TUI と GUI で core の動きが変わらない。

運び方だけが違う。

| | core を呼ぶ | core からの呼び出しを受ける |
| --- | --- | --- |
| TUI | core の関数を直接呼ぶ（同じプロセス） | Port を満たす TUI が直接受ける |
| GUI | アダプターが JSON-RPC（`input.*` など）を受けて core の関数を呼ぶ | アダプターが Port を満たし、呼び出しを JSON-RPC の通知に直して GUI へ送る |

TUI 専用のものは core に置かず、`ui/tui` に出す。`ui/tui/vt` のターミナルのパネル、マルチプレクサのペイン、OSC 52、境目のドラッグ、レイアウトの状態がそうである。P12 のエクスプローラ・変更一覧・エージェントのパネルも、TUI はツリーと git のデータから自分で描く（GUI がツリーの API から描くのと同じ）。端末の画像（Kitty のグラフィックス）も TUI の都合で、core は `ui/tui/kitty` を知らない（画像の大きさの上限は TUI が `core.MaxImageCells` に入れ、画像を端末へ送る・消すのは TUI が Port の `ImageClosed` を受けて行う）。

単体編集モード（`single`）は core のモードのままにする。1 ファイルを閉じたときの終了は、core から UI への呼び出し（例 `Exit()`）にし、TUI はプロセスを終え、GUI のアダプターは通知に直す。

Port は `core/port.go` の `core.Port` で、`WriteClipboard`・`OpenURL`・`Exit` と、レイアウトの `ShowSide`・`ShowTerm`・`ShowAgent`・`DragBorder`・`StartResize`・`ResizeKey`・`ResetPanes`、ターミナルのパネルの `TermFocus`・`TermToggle`・`TermKey`・`TermRun`・`TermPaste`・`TermClose`、マルチプレクサのペインで終わったコマンドの `CommandEnded`、画像を見せなくなったことの `ImageClosed`、テーマの色の反映の `SetPalette`、文言を訳してもらう `Text` と、設定を読んだことを伝えて UI 自身の設定（表示言語など）を取らせる `ConfigRead` を持つ。ターミナルのパネル（`ui/tui/vt`）とマルチプレクサ（herdr・tmux・zellij・cmux）のペインは tui だけが持ち、core は意味（走らせたい行、貼り付けたい文字）だけを Port で伝える（ペインのときは `core.Layout` の `TermInPane` が立ち、core はパネルの表示とフォーカスを持たずに `TermToggle`・`ShowTerm`・`TermRun`・`TermPaste` だけを呼ぶ）。tui はシェルが見せた失敗を `core.AddFailureTab`・`ClearFailure`・`KeepFailuresOf` で core へ返す。表示中かどうかは UI が `core.Layout` の入力で返す。TUI（`tui.App`）が満たし、`core.Host` は無い。`OpenURL` の結果は `core.OpenURLResult` の Event で返る。マウスは `Input`（`core.Mouse`）の形で TUI が扱う（`tui.App.HandleMouse`。画面のマス目の当たり判定のポップアップ・境目・ターミナルを済ませて、core の関数を呼ぶ）。ホバーの下の単語は core が決め（`Core.HoverCellWord`）、ホバーのスクロール（`Core.ScrollHover`）の上限だけは、ポップアップの大きさを知る UI が合わせる。レビューのコメントの入力欄は core の `core.TextArea` で、編集と折り返しは core が行い、UI は `Rows`・`CursorCell` を描く。キーの離しの通知は `core.ReleasesReported` の Input で core が受けて覚え、テーマの色の反映は Port の `SetPalette` で UI に頼む。`core.New`・`NewIn`・`NewSingle` は Port を受け取る。core が UI を知るのは Port だけで、`core.FrontEnd` と `headless` は無い。

### 「画面に何を出すか」（`Screen`）のデータの形

要点は次の 5 つ。

1. **意味で伝える。** 色は RGB ではなく「テーマ上の名前」（`syntax.keyword`、`diag.error`、`selection` など）で伝える。名前と色の対応表（テーマ）は別に送る（`theme.get`）。TUI の描画は同じ名前を lipgloss のスタイルにする。
2. **マス目に変換しない。** 行は「文字列 + スタイルの区間」で表す。文字の幅の計算と、字下げの線の引き方は描く側の仕事（ただしマウスの位置のマス目 → rune の位置の変換だけは `core` が行う。「入力」の節）。ただし見える行数と桁数は GUI が送り（`view.resize`）、スクロールや折り返しは shj が決める。等幅フォントで描く前提。
3. **領域（region）ごとに分ける。** TUI は全部を並べて描き、GUI は必要な領域だけ受け取る（左の一覧と右下のターミナルは GUI が自前で作るので、`Screen` の購読に入れない）。
4. **位置は「ペインの中の行と桁」。** 画面全体の座標を持たない。マウスの位置も同じ形で送る。
5. **文言はキーと値（`msg.Msg`）。** `core` と `screen.Screen` は文言を訳さず、i18n のキーと埋める値（`core/msg`）で持つ。訳すのは UI で、TUI は描くとき、GUI は受け取ったあとに訳す。`kisui serve` は `Msg` を訳さずに送り、翻訳の表は `i18n.get` で渡す（「画面の送り方」の表）。`Msg` の JSON は、キーの無い文字だけのもの（ファイル名、他のプログラムの文言）は文字列のまま、それ以外は `{key?, args}`（`args` の要素は文字列・数・真偽、または入れ子の `Msg`。エラーは `Msg` か文字列）。表の `%s`・`%d`・`%q`・`%v`・`%c` は GUI が埋める。`core` が言葉そのものを要るのは、検索の一致・折り返し・エージェントや git に渡す文だけで、そこは Port の `Text` で UI に訳を借りる。

```go
// core/screen（イメージ。名前と細部は実装の PR で決める）
type Screen struct {
    Rev     uint64      // 作るたびに増える。GUI はこれで抜けを見つける
    AckSeq  uint64      // どの入力（Input.Seq）までがこの画面に入っているか
    Focus   Region      // 今キーを受ける領域
    Files   *Files      // ファイルの欄
    Status  Status      // 状態行（モード、メッセージ、ブランチ、診断の数 …）
    Cmdline *Cmdline    // ":" と "/" の入力行。無ければ nil
    Overlay []Overlay   // 補完・ホバー・シグネチャ・確認・パレット・メニュー・レビューカード・検索の窓・エージェントの変更の承認の窓
}

type Files struct {
    Panes  []Pane // 普段は 1 つ、必要なら左右に 2 つ（#264）
    Active int
}

type Pane struct {
    ID         string
    Title      Title    // タイトル行（ファイル名、変更あり、読み取り専用、差分の相手 …）
    Kind       string   // "text" | "image" | "diff" | "preview" | "welcome"
    Viewport   Viewport // 先頭の行、行数、桁数、横スクロール量
    Lines      []Line   // 見えている行だけ
    Cursors    []Pos    // 複数カーソル
    Selections []Range
    Image      *ImageRef // Kind=="image" のとき。実体は blob.get で取る
}

type Line struct {
    No     int          // バッファの行番号（0 始まり）
    Spans  []Span       // {Text, Style} の並び
    Marks  []Mark       // 行番号の横の印（git の変更、診断 …）
    Diag   []Diagnostic // この行の診断（範囲、重さ、文言）
    Guides []int        // インデントガイドの位置
}
```

差分モード・Markdown プレビュー・画像は `Pane.Kind` で分ける。差分は左右の `Pane` を 2 つ返す。

`Pos` は「バッファの行番号 + その行の中の文字（rune）の位置」。UTF-16 などへの変換は描く側がする。結合文字と全角の幅の扱いは、最初の実装 PR（P8）で確かめて固定する。

### 今の `App` のフィールドの分け方

分類は 3 つ。

- **中身**：`core` に移す。
- **TUI**：TUI の描画に残す（GUI では GUI が自分で持つか、いらない）。
- **どちらでもない**：プロセス全体で 1 つ持つもの（サーバー側）。

`type App struct`（`internal/ui/app.go`）の全フィールド。

| フィールド | 分類 | 行き先と備考 |
| --- | --- | --- |
| `root`, `gitTop` | 中身 | `core` のワークスペースのフォルダ。GUI ではワークスペースごとに 1 つの `core` を持つ（フォルダ未定のあいだは、ファイルを持たない `core`） |
| `cfg` | 中身 | サーバー全体の設定 + ワークスペースの設定を `core` が読む |
| `keymap`, `helix`, `mode`, `pending`, `count`, `lastSearch`, `searchBackward` | 中身 | キー操作の状態。`mode` は状態行の表示用に `Screen.Status` へ出す |
| `lastIns`, `recIns`, `replaying` | 中身 | `.` の繰り返し |
| `caret`, `cellSize` | TUI | 端末への出力と、セルのピクセル数。GUI にはいらない |
| `caretAt` | TUI | 今は描画中に書き戻している。`Pane.Cursors` から TUI が計算する形にする |
| `lsp` | 中身 | `lspManager`。サーバーの返事は `core` のイベントとして受ける |
| `w`, `h` | TUI | GUI は領域ごとの大きさを `view.resize` で送る。`core` は領域ごとの行数と桁数だけ知る |
| `focus` | 中身 | 「キーを受ける領域」は `core` が持つ（`Screen.Focus`）。GUI で押した領域は入力に付けて送る |
| `explorer`, `treeTicks` | 中身 | TUI のツリーの選択・開閉は中身（`core.Explorer`。TUI がそこから自分で描く）。GUI のツリーは `tree.*` で別に取り、開閉は GUI が持つ |
| `term`, `hd` | どちらでもない | ターミナルはサーバーのターミナル管理（PTY）が持つ。PTY の起動・読み書き・サイズ変更は `ui/internal/term`（`tea`・lipgloss・`vt` を使わない）に出し、TUI は `term.Session` の出力を `vt` に流して描くだけ（`tui.terminal`）。`kisui serve` のターミナル管理（`server.termManager`）も起動は `term.Start` を使い、リングバッファと `term.ack` の流量制御は `server` に残す。`hd`（herdr のペイン）と tmux・zellij・cmux のペイン（`mux*.go`）は TUI だけで使う（`core` は知らない） |
| `proxy` | どちらでもない | ポート転送の管理はサーバー側に 1 つ |
| `pal` | 中身 | コマンドパレットの状態（`Overlay` に出す） |
| `wsSyms`, `wsClient` | 中身 | プロジェクトのシンボル選択 |
| `search` | 中身 | 検索パネルの状態（`Overlay` に出す。`Overlay.Search`：4 つの入力欄、オプション、状態の行、一致した行の一覧と選んだ行、そのプレビュー。TUI の `drawSearch` と同じ割り付け） |
| `tabs`, `active` | 中身 | 開いているファイルとその順番。#262 でタブバーを無くすので、`Files.Panes` と「次のファイルへ」の操作に置き換わる |
| `jumps`, `jumpIdx` | 中身 | ジャンプリスト |
| `branch` | 中身 | `Screen.Status` に出す |
| `gd` | 中身 | 差分モードの状態（`Screen.Changes` と `Pane.Kind=="diff"`） |
| `confirm`, `confirmQuit`, `confirmClose` | 中身 | 確認の窓。`Overlay` の 1 種類にする |
| `card`, `composer` | 中身 | レビューのスレッドと入力。`Overlay` に出す |
| `showSide`, `showTerm`, `showAgent` | TUI | どの領域を出すかは描く側が決める。GUI は購読する領域で表す |
| `sideWPref`, `panelHPref`, `previewPct`, `diffLeftPct`, `explorerPct`, `agentWPref`, `resizeMode`, `resizing` | TUI | ペインの大きさの調整はマス目の話 |
| `cmdOpen`, `cmdKind`, `cmdInput`, `cmdFrom` | 中身 | `:` と `/` の行。`Screen.Cmdline` に出す。`textinput.Model`（bubbles）は外して、文字列とカーソルの自前の型にする |
| `findOpen`, `findInput`, `findOrigin` | 中身 | 検索バー。`textinput.Model` は同じく外す |
| `comp`, `sig`, `sigSeq`, `snip` | 中身 | 補完、シグネチャ、スニペット。`Overlay` に出す。`sigSeq` は古い返事を捨てるための番号 |
| `hoverText`, `hoverScroll`, `hoverWord`, `hoverSeq` | 中身 | ホバー |
| `hoverAt` | 中身 | ペインの中の行と桁（`buffer.Pos`）。P10b で直した |
| `hoverCell` | 中身 | 今は画面の座標（`screenPt`）。ポインタが止まったマスで、重複を省くだけ |
| `ctx` | 中身 | 文脈のプレビュー（`ctxPreview`） |
| `ide`, `props`, `lastSel`, `sentSel` | 中身 + どちらでもない | `ide.Server` はサーバー側に 1 つ（`core` の外。`cli` が作って渡す）。提案（`props` = `core.Proposals`）と選択範囲の通知（`lastSel`, `sentSel` = `core.SelectionTracker`）、ツール一覧（`core.IDETools`）は `core`。提案のスクロールは TUI（先頭の提案は `Overlay` に出す。スクロールは core が持つ） |
| `ag`, `sg` | 中身 | ACP のエージェントと提案パネル。`Screen.Agent` に出す |
| `clipboard` | 中身 | 内部のレジスタ。OS のクリップボードは GUI 側（`clipboard.write` 通知と `input.paste`） |
| `msg`, `msgErr` | 中身 | 状態行のメッセージ。`Screen.Status` に出す |
| `follow` | 中身 | カーソルが見えるようにスクロールする印。`Viewport` を決めるときに使う |
| `dragging` | 中身 | マウスのドラッグ（選択）の状態 |
| `lastClick` | 中身 | ダブルクリックの判定。GUI は `clicks` を付けて送る。TUI は今の判定を残す |
| `askReleases` | TUI | 端末にキーの離しの報告を頼んだか |
| `releases` | 中身 | 端末が「キーを離した」を報告するか。`core.ReleasesReported` の Input で受けて覚える。GUI は最初から押す / 離すを送れる |
| `quitting` | TUI | `tea.Quit` を返した印。`core` は「終了してよい」を Port の `Exit` で伝える |
| `hold`, `holdSeq` | 中身 | 押しっぱなしのスクロール。タイマーは `core` のイベントにする |
| `lineFlip` | 中身 | 行番号の反転表示 |
| `single` | 中身 | 単体編集モード（1 ファイルだけ開き、閉じたら終了） |
| `tabSpans`, `tabOffset` | TUI | 描画中に書き戻している値で、マウスの当たり判定に使う。#262 でタブバーごと無くなる。残る間は、TUI の描画が「描いた結果」として持ち、`core` は持たない |
| `commands` | 中身 | `:` コマンドの表 |
| `mermaid`, `mdImages`, `previewGen` | 中身 | プレビューの画像の生成。画像の実体は `Pane.Image` + `blob.get` |

`tab` 構造体のうち、`img`（`imageView`）は中身（画像を読む）と TUI（ハーフブロック / Kitty で描く）が混ざっているので分ける。`prevCache`・`prevW` は「プレビューを何桁で作ったか」のキャッシュで、桁数は領域の大きさから来る。

### 描画中の書き戻しをなくす

`render` / `renderTabs` / `renderStatus` は描きながら状態を書き戻している（`tabSpans`、`tabOffset`、`caretAt`）。`Screen` を作るのは状態を変えない関数（`core.Screen()`）にして、描く側が必要な計算（タブの位置、カーソルの端末上の座標）を自分で持つ。これを最初のほうの手順にする。

P13-07（#383）では、ファイルを「描く」「中身」に仕分けた。lipgloss を import するのは `split_test.go` の名簿のファイル（`*_draw.go` ほか）だけ、`layout`（ペインのマス目）を使うのは `layout.go` ほかの描く・画面のマス目を扱うファイルだけで、`core` に行くファイルは `editRows`・`textCols`（`layout.go`）のように領域の行数・桁数で尋ねる。どちらも `ui/tui/split_test.go` が見張る。

P13-08（#384）では、マウスの当たり判定（`handleMouse`・`termMouse`・ホバーと検索パネルの画面のマス目の判定。`ui/tui/mouse.go`）と枠の大きさの調整（`resize.go`）を `layout` を使う tui のファイルに寄せ、`core` に行くファイルは `layout` を一切使わない。`renderFrame` は `App` のフィールドを名前で読まず、`ui/tui/frameq.go` の問い合わせ（`focusIn`・`diffMode`・`completing` …。`App` を割ったあとの `core.Screen()` と `core` の問い合わせのメソッドになる）だけを読む。見張るのは `split_test.go`（`TestRenderFrameReadsQueries`）。

次に `App` を `Core`（中身。`ui/tui/app.go` の `type Core struct`）と `App`（`*Core` を埋め込み、端末だけのフィールドを持つ）に分けた。`App` に残すのは上の表で「TUI」の行のフィールド（画面の大きさ、出す領域、ペインの大きさ、端末、キーを離した報告）。`core` に行くファイルはそのフィールドを読まず、`ui/tui/frontend.go` の問い合わせ（`screenW`・`sideShown`・`setSide`・`termShown`・`termRun` …。`App` を割ったあとは `core` が前面に尋ねる呼び出しになる）を通す。`TestCoreFields` が `Core` にそのフィールドが入らないことと、`frontend.go` などの tui に残るファイル以外が読まないことを見張る。

中身のファイルのメソッドは `*Core` に付け替えた。`Core` は前面（`App`）を `frontEnd`（`frontend.go`）として持ち、端末に尋ねることはそれを通す。中身のファイルに `*App` のメソッドは残っていない（`Init`・`Update` は `model.go`、描くものは `*_draw.go`）。`TestCoreMethods` が増えないことを見張る。`Core` を `core` に移すのが残りで、`mdparse.go`（Markdown の字句）から移し始めた（#384 の (3)）。

色は `theme.go`（`Theme` の値だけ。`app.go` に依存しない）と `theme_apply.go`・`styles.go`（lipgloss のスタイルを作る）に割った。`Core` が選ぶのは `Theme` で、スタイルへの反映は前面の `setPalette` が行う（`TestThemeApplyIsFrontEnd` が見張る）。

`styles.go` は lipgloss のスタイル（`bgfg`・`st*`）だけにし、色の値（`c*`）は `colors.go`、セルに合わせる関数（`fit`・`overlay`・`clamp`）は `cells.go` に分けた。tui のファイルが `Core` のフィールドを読まず `coreq.go`・`ptrq.go`・`fitq.go` のメソッドで尋ねる形は `TestFrontEndAsksCore` が、core 行きのファイルが `styles.go` のスタイルで描くのは `TestStylesStayInTui`が見張る。core 行きの 13 ファイルに残っていた描画（`drawAgent`・`drawPalette`・`drawSearch`・`drawHover` ほか）は `*_draw.go` に出し、データ（`Overlay`・`Pane` ほか）だけを渡す形にした。

P13-09（#385）で `Core` を `core` に移し、分割を終えた。`ui/tui` の `App` は `*core.Core` を埋め込み、`tea.Model`（`Init`・`Update`・`View`。`model.go`）を持つ。`Core` は UI を `core.Port` として持ち、`App` がそれを満たす（`ui/tui/port.go`）。tui が `Core` の公開したフィールドとメソッドを使うので、上に挙げた tui の中の見張り（`TestCoreFields`・`TestCoreMethods`・`TestThemeApplyIsFrontEnd`・`TestFrontEndAsksCore`・`TestStylesStayInTui`・`TestRenderFrameReadsQueries`）はやめた。境界はパッケージで、`core/deps_test.go`（`TestNoTerminalDeps`）が、`core` が bubbletea・lipgloss・`ui/tui` に依存しないことを見張る。`github.com/charmbracelet/x/ansi` は、Markdown プレビューなどで端末のセルの幅を測る所が残るので、まだ例外にしている。tui の中には、lipgloss を import するファイルと `layout` を使うファイルを限る見張り（`ui/tui/split_test.go`）だけが残る。テストは、振る舞い（`Input` を渡して状態を見る）を `core` に、描画・レイアウト・マウスの座標・端末とマルチプレクサを `ui/tui` に置いた。

（この段落は #448 より前の形の説明で、`core.Workspaces`・`core.NewIn` は #557 で外した。ワークスペースの決まり方と消え方の新しい形は「ワークスペース」の節。）P14（#306）で、1 つのプロセスが `core` を複数持てるようにした。プロセス全体で 1 つのもの（ポート転送とシェル連携のファイル）は `core.Shared`（`core/shared.go`）にまとめ、`core.NewIn(shared, …)` で作った `core` はそれを共有する。TUI は今までどおり `core.New` で 1 つだけ作り、`Shared` もその `core` が持つ（`Close` で閉じる）。テーマと表示の言語はもともとプロセス全体の値（`ActivateTheme`・`i18n.SetLang`）。言語は、TUI では `core.New` がそのルートの設定で決め、`kisui serve` ではホームの設定で起動時に一度だけ決める（`NewIn` は `SetLang` しない）。`kisui serve` は `core.Workspaces`（`core/workspaces.go`）でルートごとに `core` を 1 つ持ち、前面は描く画面がまだ無いので Port は `kisui serve` のサーバー（`Workspaces.SetPort`）で、大きさは GUI が送るまで 80 x 24 とする（`newHeadlessCore`）。`core` を作るのは `workspace.focus` のときで、ファイルを開いている間はシェルがいなくてもワークスペースは残り、どちらも無くなったら `core` を止める。サーバーは `core` を import せず、`server.Cores`（`server/cores.go`）を通して `files`・`workspace.close_files` を `core` に尋ねる。`workspace.close_files` は未保存の変更があるファイルを閉じずに残す。止まる前（idle と `server.shutdown`）には `AddBeforeStop` で全部の `core` の未保存の変更を `server.WriteBackup`（`<名前>.bk`）に書く。`core` の `Event` を回す仕組みと、`core` が `server.Workspace`（`ctl`・`ide` の届け先）になるのは、画面の配信（B9）と一緒に入れる。それまでは `Workspace.Do` が 1 つずつ `core` に触らせる。

## 2. 分けていく順番

どの手順も 1 つが 1 つの PR になる大きさにする。手順の最後で `go test ./...` が通り、TUI の見た目と操作が変わらないこと。

#262（タブバーを消す）が先に入ると、`tabSpans`・`tabOffset` の扱いが変わる。P3 はそれを見てから始める。

| # | 手順 | 依存 |
| --- | --- | --- |
| P1 | TUI の描画を固定するテストを足す。代表的な状態（ファイルを開いた、補完、差分モード、確認の窓、ホバー、検索）で `render()` の出力を保存して比べる。テストだけ | なし |
| P2 | `core/screen` を作る。`Screen`・`Pane`・`Line`・`Span`・`Style`（意味の名前）・`Overlay` を定義し、テーマの名前 → 色の対応を決める。使うコードはまだ無い | なし |
| P3 | 描画中の書き戻し（`tabSpans`・`tabOffset`・`caretAt`）をやめる。描画関数が結果を返す形にする | P1、#262 |
| P4 | `textinput.Model`（bubbles）を自前の入力行の型に置き換える（`cmdInput`・`findInput`・パレット・検索パネル） | P1 |
| P5 | 入力の型を作る：`Input`（Key / Mouse / Paste / Composition）。`tea.KeyPressMsg` などを `Input` に変えるアダプタを作り、キー処理を `Input` で書く。マウスは「領域 + ペインの中の行と桁」で扱い、画面全体の座標での当たり判定は TUI のアダプタに寄せる | P1 |
| P6 | 非同期の仕組みを `tea.Cmd` から切り離す。`core` が `Event`（タイマー、LSP の返事、ファイルの変化 …）を受け取り、`Effect`（タイマーを予約、LSP に送る、終了する …）を返す形にする。まずタイマー（`hold`、`hoverSeq`、自動保存、`watch`）から | P5 |
| P7a | LSP を `Event` / `Effect` にする（`lspManager`、サーバーの返事、診断、`sigSeq` などの古い返事を捨てる番号） | P6 |
| P7b | 検索 / grep（`searchPanel`）を `Event` / `Effect` にする | P6 |
| P7c | エージェント（ACP、`agentState`、提案パネル）を `Event` / `Effect` にする | P6 |
| P7d | 制御用ソケット（`ControlHandler`、「送って返事を待つ」形）を `core` の `Event` と返事の受け渡しにする | P6 |
| P7e | IDE（`IDEHandler`、`openDiff` のように決定まで返事を待つ呼び出しを含む）を同じ形にする | P6、P7d |
| P8 | ファイルの欄（テキスト）を `Screen` で作る：バッファ → `Pane`（`Lines`・`Cursors`・`Selections`）。TUI の描画は `Pane` を読んで描くように変える。P1 のテストで見た目が同じことを確かめる | P2、P3 |
| P9 | タイトル行・状態行・コマンド行を `Screen` で作る | P8 |
| P10a | 補完のポップアップを `Overlay` にする | P8、P7a |
| P10b | ホバーを `Overlay` にする（`hoverAt` を「ペインの中の行と桁」に直すのもここ） | P8、P7a |
| P10c | シグネチャのポップアップを `Overlay` にする | P8、P7a |
| P10d | スニペットの状態の表示を `Screen` にする | P8 |
| P10e | 確認の窓（`confirm`・`confirmQuit`・`confirmClose`）を `Overlay` にする | P8 |
| P10f | コマンドパレットを `Overlay` にする | P8、P4 |
| P10g | メニュー（`spacemenu`）を `Overlay` にする | P8 |
| P10h | レビューカード（`card`・`composer`）を `Overlay` にする | P8、P4 |
| P11a | 差分モードを `Pane.Kind=="diff"` として `Screen` で作る | P8 |
| P11b | Markdown プレビューを `Pane.Kind=="preview"` として `Screen` で作る | P8 |
| P11c | 画像を `Pane.Kind=="image"` として `Screen` で作る（`imageView` を中身と TUI の描画に分ける） | P8 |
| P12 | エクスプローラ・変更一覧・エージェントのパネルを TUI が自分で描く（`Screen` に入れない。core は `core.Explorer`・`Core.ChangesOf`・`Core.AgentPanelOf` でデータだけを渡す） | P8 |
| P13 | `core` パッケージへ移す。`App` は `core` を持って、`Input` ↔ `tea` と `Screen` ↔ 描画をつなぐだけの薄い bubbletea の Model になる。`internal/ui` を `ui/tui` に改名する | P7a〜P7e、P9、P10a〜P10h、P11a〜P11c、P12 |
| P14 | `core` が複数のワークスペースを持てるようにする（ワークスペースごとに `core` を 1 つ。TUI は今までどおり 1 つだけ作る） | P13 |

- P8〜P12（P10a〜h、P11a〜c を含む）は、`Screen` を作る関数と TUI の描画関数を同じ PR で対にして変える。`Screen` を作るだけで使われない状態にしない。
- 途中は、`App` が `core` の「まだ分けていない部分」を直接持っていてよい。分けた領域の分だけ、`render` が `Screen` を通る。
- P6 とその後の P7a〜P7e が一番大きい。1 つの PR で全部をやらず、サブシステムごとに行う。

## 3. プロトコル

### 土台

- **JSON-RPC 2.0**。要求（`id` あり）・通知（`id` なし）・応答・エラーの形は標準どおり。
- **ssh の標準入出力の上**で送る。標準入力が GUI → shj、標準出力が shj → GUI。標準エラー出力はログ用で、プロトコルに混ぜない。
- **分け方（framing）**：最初は「1 行 1 メッセージ」の JSON（改行区切り。JSON の文字列の中の改行は `\n` にエスケープされるので衝突しない。ACP と制御用ソケットと同じ作り）。`session.hello` で `encoding` を決めるので、あとで MessagePack（長さ付き）に変えられる。メソッドとパラメータの形は変えない。
- **始まりの目印**：ssh で入ると、ログインシェルが標準出力に何か出すことがある（motd など）。`kisui attach` は最初に 1 行 `@@shj-rpc 1@@` を出す。GUI はこの行より前を捨てる。目印のすぐあと（`kisui serve` の出力より前）に、`kisui attach` は自分の `attach.info` を 1 行出す（下の表）。
- **名前**：`領域.動作`（`session.hello`、`term.input`）。**向き**は「→ shj」（GUI から）と「← GUI」（shj から）で書く。
- **エラー**：標準のコードに加えて次を使う。

| コード | 名前 | 意味 |
| --- | --- | --- |
| -32001 | `incompatible_protocol` | プロトコルの major が合わない |
| -32002 | `not_owner` | 引き継がれたあとの古い GUI が要求した |
| -32003 | `not_found` | ワークスペース・ターミナル・ファイルが無い |
| -32004 | `denied` | 権限が無い、またはワークスペースの外 |
| -32005 | `busy` | 上限を超えた、またはターミナルでプログラムが動いている |

### つなぐ・引き継ぐ・切れる

| メソッド | 向き | パラメータ → 結果 |
| --- | --- | --- |
| `attach.info` | ← GUI | 通知 `{executable, version, commit, channel, env?}`。`kisui serve` ではなく `kisui attach` が、目印のすぐあとに 1 回だけ出す。その `kisui attach` 自身の kisui の実行ファイル（絶対パス）と版（`version`・`commit`・`channel` は `session.hello` の `shj` と同じ形）と、新しい `kisui serve` に渡す環境変数（`server.handover` の `env`。今は `kisui attach` が受けた `KISUI_SHJ_DIR` だけ）。GUI は版が違うときの切り替えに使う（下の「版が違うとき」）。知らない GUI は無視する |
| `session.hello` | → shj | `{protocol: {major, minor}, client: {name, version, kind: "web"\|"native"}, encoding: ["json", "msgpack"], resume?: {serverId, rev}}` → `{protocol, encoding, shj: {version, commit, channel}, serverId, startedAt, supersedes?: {client, connectedAt}, capabilities: [...], workspaces: [...], rev}` |
| `session.bye` | → shj | `{}` → `{}`。GUI を閉じるとき。shj とシェルは止めない |
| `session.superseded` | ← GUI | 通知 `{by: {client, connectedAt}}`。後からつないだ GUI に引き継がれたとき、前の GUI に送ったあと接続を閉じる。GUI は「別の GUI に移りました」と出す |
| `session.ping` | → shj | `{}` → `{}`。生きているかの確認（GUI が 15 秒ごと。ssh が黙って切れたときに気づく） |
| `server.info` | → shj | `{}` → `{shj, serverId, pid, uptime, lastClientAt, idleStopAt, workspaces: n, terminals: n}` |
| `server.shutdown` | → shj | `{force?: bool}` → `{terminals: n}`。ターミナルが動いていると `force` が無い限り `busy` で断る。GUI は確認を出してから送る |
| `server.handover` | → shj | `{executable, env?}` → `{pid}`。`executable`（絶対パス）の `kisui serve` に、欄のシェルと画面を消さずに入れ替わる。`env`（`{名前: 値}`）は新しい `kisui serve` に渡す環境変数（下の「環境変数」）。`pid` は新しい `kisui serve` の pid。返事のあと、古い `kisui serve` は GUI の接続を閉じて終わる。失敗したら `internal_error`（古い `kisui serve` はそのまま動き続ける）、`executable` が実行ファイルの絶対パスでなければ `invalid_params`、止まる途中・別の引き継ぎの途中なら `busy`。`capabilities` に `server.handover` があるときだけ使える。手順は「`kisui serve` の引き継ぎ」の節 |

- **バージョンの確認**：`protocol.major` が合わないと `incompatible_protocol`。`protocol.minor` は上がっても互換（足されるだけ）。知らない通知は無視し、知らないメソッドは `-32601`。新しい機能は `capabilities` の文字列で見分ける。
- **`kisui serve` と GUI の版が違うとき**（#8）：GUI は、`session.hello` の `shj`（動いている `kisui serve` の版）と、`attach.info`（GUI と同じ版の kisui。ローカルは同梱のもの、リモートは「ssh 越しに kisui を起動する」の 1 の場所）の `version`・`commit` を比べる。どちらかが違い、`capabilities` に `server.handover` があれば、ユーザーに聞かずに `server.handover`（`executable` と `env` は `attach.info` のもの）を頼む。シェルも画面も消えないので聞かない。ローカルとリモートで同じ動き。
  - 比べるのは GUI の版の文字列ではなく kisui どうし（同じ作り方の `buildinfo`）。同じリリースの GUI と kisui は同じになり、nightly どうし（`version` は `X.Y.Z` だけ）は `commit` で見分けられる。
  - 頼んでから、新しい `kisui serve` につなぎ直し終わるまで、GUI は「新しい版に切り替えています」と出す。古い `kisui serve` には `connected` にならない（欄は古い serve に `term.attach` しない）。
  - 返事が来たら、古い serve が接続を閉じるのを待たずに、同じ `serverId` の `resume` でつなぎ直す（つなぎ直しの回数は数え直す）。新しい serve は同じ状態を持つので、欄は `term.attach` で引き継ぐ前の画面のまま続く。
  - 断られたら（`internal_error` など）、古い `kisui serve` のまま使い続け、「<マシン> の kisui を新しい版に切り替えられませんでした」と理由を右下に出す。返事の前に接続が切れた・120 秒たっても返事が無いときは、普通のつなぎ直しに任せる。
  - 頼むのは、マシンにつなぐ（`Session`）ごとに 1 回だけ。切り替えた先の版がまだ違っても、断られても、つなぎ直すたびに繰り返さない。
  - `capabilities` に `server.handover` が無い `kisui serve`（#7 より前）は、何もせずにそのまま使う（ユーザーが 1 回だけ手で終わらせる）。`attach.info` が無い（`SHIJIMI_REMOTE_KISUI` で古い kisui を指したなど）ときも頼まない。
- **引き継ぎ**：サーバーが受けつける GUI は常に 1 台。2 台目の `session.hello` が来たら、1 台目に `session.superseded` を送って閉じ、2 台目に引き継ぐ。1 台目が出した返事前の要求は捨てる。閉じ損ねた 1 台目からの要求は `not_owner`。
- **切れる**：標準入出力が閉じたら、GUI がいなくなったとみなす。状態（ワークスペース、ターミナル）は残り、`lastClientAt` を覚える。
- **つなぎ直す**：新しい `session.hello` で `resume: {serverId, rev}` を送る。同じ `serverId` なら状態（ワークスペース、ターミナル）が残っているので、ターミナルは `term.attach` で取り直して続けられる。`serverId` が違えば shj が作り直されたので、GUI はワークスペースの一覧から取り直す。
- **止まる**：`lastClientAt` から 7 日（`config.toml` の `[server] idle_stop_days`、0 で止まらない）つながらなければ、`kisui serve` は終わる。つながっている間は止まらない。ターミナルでシェルが動いていても止まる（そのシェルは SIGHUP で終わる）。ワークスペースの一覧は、止まる前に保存して次の起動で作り直す（「ワークスペース」の節の「`kisui serve` が止まったあと」）。`[server] idle_stop_days` は `~/.config/shijimi-editor/config.toml` だけで有効。

### 外したメソッド（#557）

次のメソッドは、GUI のファイルの欄と一緒に外した。`kisui serve` は知らないメソッドとして `-32601` を返す。以前の GUI がつなぐと `protocol.major` の食い違い（`incompatible_protocol`）になる。

- 画面：`view.subscribe`・`view.resize`・`screen.get`・`screen.update`・`screen.ack`・`theme.get`・`theme.changed`・`i18n.get`・`i18n.changed`・`blob.get`
- 入力：`input.key`・`input.composition`・`input.mouse`・`input.paste`・`input.focus`・`command.run`・`file.open`
- shj から GUI への通知：`clipboard.write`・`resize.start`・`resize.key`・`resize.reset`・`url.open`（どれも `core` が `Port` で頼んでいたもの）

画面の差分の送り方・入力の変換・ファイルの欄の描き方は、このリポジトリの履歴（#557 より前）に残っている。

### shj から GUI への通知（その他）

| メソッド | 向き | パラメータ |
| --- | --- | --- |
| `pane.show` | ← GUI | `{workspaceId, termId}`。プライマリの shj が端末のコマンドで欄を出した（「プライマリの shj の欄」）。隠していれば戻し、その欄（分割したターミナル）を active にしてキーを向ける。`workspace.changed` のあとに届く |
| `pane.hide` | ← GUI | `{workspaceId}`。プライマリの shj が欄を隠した。プライマリ以外の欄を隠してプライマリにキーを向ける（`Ctrl+Shift+M` と同じ） |
| `browser.open` | ← GUI | `{workspaceId, url}`。プライマリの shj の `:open-url`・`kisui open <URL>` が URL を開くよう頼んだ。GUI は手元の外部ブラウザ（OS 既定のブラウザ）で開く（欄は作らない。リモートのマシンの localhost 系の URL は、ポート転送越しの URL で開く。下の「ブラウザの URL を開く」）。#96 より前の GUI は知らない通知として無視する |
| `explorer.focus` | ← GUI | `{workspaceId}`。プライマリの shj が `Space e` でファイルエクスプローラへのフォーカスを頼んだ。そのワークスペースにフォーカスしているときだけ、サイドバーのツリーの行（shj が出しているファイル、無ければ最初の行）にキーを向ける。Esc で今使っているターミナルに戻る |
| `changes.focus` | ← GUI | `{workspaceId}`。プライマリの shj が `Space E`・`cmd.diffchanges` でサイドバーの CHANGES へのフォーカスを頼んだ（`PaneRequest` の `op: "changes"`。#45）。そのワークスペースにフォーカスしているときだけ、CHANGES の行（shj が差分を出しているファイル、無ければ最初の行）にキーを向ける。Esc・q で今使っているターミナルに戻る |
| `notify` | ← GUI | `{level, text}`。画面に出さない通知（接続のログなど） |

- サイドバーとの境界は GUI が持つ。`Cmd+R`（Mac）・`Ctrl+Shift+R`（Linux）のリサイズモードは GUI が受けて、`Tab`・`Shift+Tab` で動かす境界を替え（最初はサイドバー、次から欄どうしの境界を木の順に。選んだ境界は光る）、`←` `→`（`h` `l`）か `↑` `↓`（`k` `j`）で動かす（縦の境界は左右、横の境界は上下だけ効く。サイドバーは 20px ずつ、欄どうしの境界は 2% ずつ）。`=` で選んでいる境界を元の大きさ（欄どうしは半分ずつ）に戻し、`Esc`・`Enter`・`q`、入るキーをもう一度押すと終わる。欄どうしの境界はマウスでもドラッグできる（欄の間の 6px の隙間にだけつまみを置き、端末の字の上には重ねない。ダブルクリックで半分ずつ）。動かした割合は serve が木に持つ（下の `layout.resize`）。`Alt+R` は GUI が取らず、`shj` に渡す（`shj` 自身のリサイズモード）。

### ターミナル

`Screen` には変換しない。PTY の出力をそのまま流す。ターミナルは**サーバー全体で持ち**、**ワークスペースごとに、プライマリターミナル 1 つと分割したターミナル（個数に上限は無い）**を持つ。どのワークスペースに属するかは作るときに決まり、cwd からは決まらない（次の節）。

- **プライマリターミナル**：ワークスペースを作ると同時にできる。右の欄の 1 つ目の欄。編集する `shj` はここで動かす。そのシェルの cwd がワークスペースのフォルダを決める。プライマリターミナルは `term.close` で閉じられず、ワークスペースが消えるとき（`workspace.close`）にだけ終わる。
- **分割したターミナル**：足した 2 つ目以降（個数に上限は無い）。`term.create` で作り、`term.close` で閉じる。cwd が変わってもワークスペースには何も影響しない。
- 始めるフォルダ：プライマリターミナルは、フォルダ未定のワークスペースならそのマシンの `[server] start_dir`、決まっていればそのフォルダ。分割したターミナルは、ワークスペースのフォルダ（フォルダ未定なら `start_dir`）。

| メソッド | 向き | パラメータ → 結果 |
| --- | --- | --- |
| `term.create` | → shj | `{workspaceId, cols, rows, shell?, env?, split?: {target, dir}}` → `{termId, pid, cwd}`。分割したターミナルを足す。ワークスペースのフォルダ（フォルダ未定なら `start_dir`）で始める。`split` は足す場所で、欄 `target`（`Workspace.layout` の葉）を `dir`（`"right"` か `"down"`）に分ける。無ければ自動（下の「欄の配置」）。分けた後の欄が最小の大きさ（列 20・行 5）を下回る分割は `busy`（理由は `message`）。`target` が無ければ `not_found`、`dir` が正しくなければ `invalid_params`。欄の数に上限は無い。`shell` が無ければ今の設定どおり。プライマリターミナルは `workspace.create` が作るので、ここでは作らない |
| `term.list` | → shj | `{}` → `{terms: [{termId, pid, cwd, workspaceId, primary: bool, title, cols, rows, alive}]}` |
| `term.attach` | → shj | `{termId}` → `{seq, snapshot (base64), cols, rows}`。つなぎ直したとき・溢れて欠けたときに、画面の状態を取り直す。`snapshot` は、`kisui serve` が欄ごとに持つ coneko-term（`Terminal::serialize`）の書き出しで、`seq` までの出力を全部反映した画面・scrollback（5000 行）・モード（代替画面、カーソル、kitty キーボードのフラグ、マウス報告、bracketed paste ほか）。先頭の RIS で始まり、問い合わせは入っていない。`seq` は書き出した時点のバイト数の累計で、これより先の `term.output` が抜けも重なりもなくつながる。過去の出力のバイト列は返さない（そこに入っている端末への問い合わせに GUI の coneko-term がもう一度返事をして、シェルに文字が届くのを防ぐ）。`kisui serve` が画面の状態を作れないときは `internal_error` |
| `term.close` | → shj | `{termId}` → `{}`。シェルに SIGHUP を送る。分割したターミナルだけ（プライマリターミナルに送ると `denied`。ワークスペースごと閉じるときは `workspace.close`） |
| `term.restart` | → shj | `{termId}` → `{pid, cwd}`。終わったプライマリターミナルに新しいシェルを始める（`termId` はそのまま）。プライマリターミナルだけ（分割したターミナルに送ると `denied`）。ワークスペースのフォルダ（フォルダ未定なら `start_dir`）で始める。シェルがまだ動いていれば `busy` |
| `term.resize` | → shj | `{termId, cols, rows}` → `{}` |
| `term.input` | → shj | `{termId, data (base64)}` → `{}`。coneko-term が作ったバイト列をそのまま PTY に書く |
| `term.cd` | → shj | `{termId, path}` → `{}`。シェルに `cd -- '<path>'` を打つ。`path` が無ければ `invalid_params` で断る。ツリーの「ここへ移動」が使う。制御文字（C0・DEL・C1）を含むパスは何も打たず `invalid_params` で断る。入力の途中の行に続けて実行されないよう、先に Ctrl+E・Ctrl+U で行を消す。シェルのほかにプログラムが前面で動いていれば（`workspace.close` の `running` と同じ判定）何も打たず `busy`（`data.reason` は `running`）で断る |
| `term.output` | ← GUI | 通知 `{termId, seq, data (base64)}`。PTY の出力。`seq` はバイト数の累計 |
| `term.ack` | → shj | 通知 `{termId, seq}`。GUI が処理したバイト数。shj は `seq` から 256 KiB より先までは送らない。このとき PTY は読み続けてリングバッファに溜め、溢れた分は捨てる（GUI が止まってもシェルは止めない。捨てた分は `term.attach` の書き出しで取り直す。リングバッファは、この送り出しのためだけに持つ）（`yes` のような大量の出力で回線と WebView が詰まらないように） |
| `term.exit` | ← GUI | 通知 `{termId, code?, signal?}`。シェルが終わった。`code` は、`kisui serve` が引き継いだシェル（前の `kisui serve` が始めたもの。子ではないので終了コードが分からない）では無い。送り残した `term.output` より先に届くことがある（GUI は `term.exit` のあとも `term.attach` で画面を取り直して残りを受ける）。溢れて捨てられた分は `term.output` の `seq` が飛んで届くので、欠けは `seq` の連続性で分かる |
| `term.title` | ← GUI | 通知 `{termId, title}` |

- 終わったプライマリターミナルは `alive: false` のまま残り、ワークスペースを消さない（「ワークスペース」の節の 11）。
- JSON では base64 にするので出力が約 1.33 倍になる。MessagePack に変えれば生のバイト列で送れる。「速さが足りなければ MessagePack に」が一番効くのはここ。
- ターミナルの中身を読む `ui/tui/vt` は TUI だけで使う。GUI ではサーバーは PTY のバイト列をそのまま中継する（ふだんの `term.output`）。画面の状態は欄ごとの coneko-term（`internal/emulator`、wasm）が別に持ち、`term.attach` で取り直すときだけ使う。コマンドの終了を知らせる印（`command-end`、`shellint`）は、サーバーでは取り出さない（B6 で確かめた）。バイト列は coneko-term にそのまま届くので、印が要る機能は GUI の側（coneko-term の `registerOscHandler`）で拾う。サーバーが出力から読むのはタイトル（OSC 0 / 2）だけ。
- GUI の側（F1）で決めた細部（`app/src/terminal/link.ts`）：
  - `term.output` の `seq` は、そのかたまりの終わりのバイト数の累計。GUI は書いた分の `seq` を覚え、かたまりの始め（`seq` − 長さ）がそれより先なら欠けとみなして `term.attach` で取り直す。重なる分は捨てる。
  - `term.ack` は coneko-term が書き終えた（`write` のコールバックが来た）ときに返す。画面が遅れると shj が送るのを待つので、大量の出力でも WebView が詰まらない。
  - `term.attach` の返事を受け取ったら、画面を `reset` してから `snapshot` を書き、`seq` を覚える。取り直した分は ack の窓の外なので、coneko-term が書き終えるまでは次の `term.attach` を送らず、その間の欠けは書き終えてから 1 回だけ取り直す（coneko-term に積まれる量を「書き出し 1 回分 + ack の窓」までにする）。書き出しは画面を置き換えるので、終わったプライマリの「Enter で作り直す」の知らせは取り直したあとにもう一度出す。
  - `term.attach` の返事を待つ間に届いた `term.output` は取っておき、返事のあとに `seq` でつなぐ（`seq` までの分は書き出しに入っているので捨て、それより先の分を書く。欠けがあれば取り直す）。`kisui serve` は、`term.attach` を受けた時点で `seq` までを送った・ack したものとして続きを流すので、返事より先に `seq` より先の `term.output` が届くことがある。キー入力はその間も送る（`yes` を止める Ctrl+C を落とさない）。`term.create` の返事より先に `term.output` が届くことがあるので、作ったら `term.attach` で取り直す。
  - 右の欄に出すのは、フォーカスしているワークスペース（無ければ最初につながったマシンの最初のワークスペース）のターミナル。プライマリのシェルが終わったら知らせを出し、Enter で `term.restart` する。画面を外している間や切れている間に終わると `term.exit` が届かないので、付け直し・つなぎ直しのあとに `term.list` で生きているかを確かめ、`term.input`・`term.resize` の `not_found` も終わったものとして扱う。
- GUI の側（F2）：帯を押して `workspace.focus` が受け付けられたら、そのワークスペースのプライマリターミナル（返事の `termId`）に切り替え、画面の状態を取り直して描く（前のシェルは止めない）。どのワークスペースにも必ずプライマリターミナルがあるので、ターミナルを探して作る処理は要らない。切り替えたターミナルの大きさが画面と違えば `term.resize` で合わせる。
- GUI の側（F4。`app/src/terminal/group.ts`・`grid.ts`）：右の欄には、フォーカスしているワークスペースのターミナル（プライマリ 1 つと分割したもの）を、`Workspace.layout`（下の「欄の配置」）の通りに並べる。プライマリターミナルが 1 つ目の欄。Mac は `Cmd+D` で今の欄を右に、`Cmd+Shift+D` で下に分け（iTerm2 と同じ）、ほかは `Ctrl+Shift+D` で右、`Ctrl+Shift+E` で下に分ける。分けるときは `term.create` に `split` を付け、新しい欄にキーを向ける。以前の `Ctrl+Shift+T`・`Cmd+T` は無くした（分ける向きを選べないため）。分割したターミナルのシェルが終わったら（`exit`）`term.close` してその欄を閉じ、並び直して隣にキーを向ける。プライマリターミナルのシェルが終わったら、欄を閉じず「Enter で作り直す」を出し、Enter で `term.restart` する。`Ctrl+Shift+矢印` は、キーがターミナルに向いているとき（プライマリ以外の欄を隠していないとき）だけ GUI が受けて隣へ移る。移る先は、描かれる位置で辺が接している欄で、今の欄の上端（左右）か左端（上下）にかかるものを選ぶ。今使っている欄は、上端にマシンの色の線を引く（タブの見出しは作らない）。並べたとき（2 つ以上）は、プライマリターミナルの欄の 4 辺にマシンの色の細い枠（1px）も引く（プライマリを使っているときは上端の線と両方）。1 つだけのときは枠を引かない。F2 でワークスペースを移したときは、並べるターミナルがそのワークスペースのものに替わり、今使うのはそのプライマリターミナルになる。
- GUI の側（プライマリ以外の欄を隠す。`Ctrl+Shift+M`）：そのワークスペースのプライマリで shj が動いている（`primaryShj` が `null` でない）ときだけ、プライマリ以外の欄を隠してプライマリにキーを向け、もう一度押すと戻す。動いていなければ何もしない。隠した欄のターミナルは止めず（欄を作り直さず）、戻せば元の状態で出る。隠している間は右上に隠している数を出す（タブにしない）。状態は GUI だけが持ち（ワークスペースごと。`kisui serve` には持たせない）、プライマリの shj が終わった（`primaryShj` が `null` になった）ら隠した欄を出す。欄を分けるときも先に戻す。`muxBackend` の `hide`・`show`（#553）は `pane.hide`・`pane.show` の通知で同じ状態（App.tsx の `zoomedWs`）を動かす。
- **欄の配置（分割の木）**：配置は `kisui serve` が持ち、`Workspace.layout` で届く（GUI を開き直しても、別の GUI からつないでも同じ配置になる）。葉は欄の id（`primary`・`terms`・`extras` の id）で `{pane}`、節は分割で `{dir, ratio, a, b}`。`dir: "right"` は右に分ける（`a` が左、`b` が右。境界は縦）、`"down"` は下に分ける（`a` が上、`b` が下。境界は横）。`ratio` は `a` の割合（0〜1。分けた直後は 0.5。境界を動かすと変わる。`layout.resize`）。欄は何個でも開ける。ターミナルでない欄（`extras`）も同じ木に入る。
  - **決め方**：`term.create` の `split` は `target` を `dir` に分けて新しい欄を `b` に入れる。`split` が無いとき（古い GUI・プライマリの shj が開く欄）は、木の最後の欄を、深さが偶数なら右、奇数なら下に分ける。動画などの欄を同じ種類で開き直すときは、木の同じ場所で入れ替える。
  - **断る**：分けた後の欄が最小の大きさ（`minSplitCols` = 20 列、`minSplitRows` = 5 行。`server/layout.go`）を下回る分割は `busy` で断る。欄の大きさは serve が持つターミナルの `cols`・`rows` で見る（`term.resize` で GUI が知らせたもの）。ターミナルでない欄は大きさを持たないので、断らない。
  - **境界を動かす**：`layout.resize` `{workspaceId, pane, ratio}` → `{ratio}`（GUI → serve）。境界は割合を持つ節で、`pane` は節の B 側の左上の葉の欄 id（木のどの葉も、ちょうど 1 つの節の「B 側の左上」になるので一意で、ほかの欄を分けても変わらない）。serve は両側が最小の大きさ（`minSplitCols`・`minSplitRows`）を下回らない範囲に収め（欄の大きさはターミナルの `cols`・`rows` の和で見る。大きさの分からない欄がある境界は 0.05〜0.95）、0.1% の細かさに丸めて、使った割合を返す。木を替えたら `workspace.changed` で知らせる（返事より前に届く）。`ratio` が 0〜1 の外・数でないときは `invalid_params`、ワークスペースか境界が無ければ `not_found`、すでに両側を満たせないほど小さければ `busy`。GUI は同じ計算（`grid.ts` の `ratioLimits`）で先に収めて、ドラッグの間はすぐ画面に出しながら、送るのは 1 境界につき 1 つずつ（待つ間に動かした分は最新の 1 つだけ）。割合は serve が持つので、GUI を開き直しても、別の GUI からつないでも、serve の入れ替え（handover）のあとも残る。
  - **閉じる**：欄が無くなったら（`term.close`・`extra.close`・シェルの終了・shj の終了）、木からその葉を外し、きょうだいが親の場所を埋める。`serve` は `recompute` のたびに木を欄に合わせ、変われば `workspace.changed` で知らせる。GUI は、木が欄と食い違うとき（古い serve が `layout` を送らない・閉じたばかり）、同じ規則（`app/src/terminal/grid.ts` の `reconcileLayout`）で合わせて描く。
  - **引き継ぎ**：serve の入れ替え（handover）は木も渡す（`handoverWS.layout`。足した欄なので版は上げない。無ければ欄から作る）。ワークスペースの保存（`workspaces.json`）は、分割したターミナルを保存しないので、木も保存しない。

### ワークスペース

**ワークスペースは作業の単位で、フォルダとは 1 対 1 ではない。** 同じフォルダを指すワークスペースが 2 つ以上あってよい。ワークスペースは `workspace.create` で作り、`workspace.close`（GUI の [×]）でしか消えない。フォルダは、プライマリターミナルのシェルの cwd から決まる。

用語：

- **マシン**：サイドバーの見出し 1 つ。「ローカル」と、ユーザーが足した ssh の行き先（総称は「マシン」。「ホスト」とは呼ばない。ローカル以外は「リモート」）。
- **ワークスペース**：作業の単位。サイドバーでは帯 1 本で見せる（「帯」は見た目の呼び名で、仕様ではワークスペースと呼ぶ）。
- **プライマリターミナル**：ワークスペースごとに 1 つのターミナル（「ターミナル」の節）。
- **分割したターミナル**：足した 2 つ目以降のターミナル（個数に上限は無い）。

決めたこと（番号は #445 で決めた順）：

1. **フォルダと 1 対 1 ではない**。同じフォルダを指すワークスペースが 2 つ以上あってよい。`workspaceId` はフォルダのパスから作らず、shj が作るときに振る不透明な文字列（保存して次の起動でも同じ値を使う）。
2. **[+] で作る**：マシンの見出しの [+] を押すと、フォルダ未定のワークスペースがすぐできる（`workspace.create`）。プライマリターミナルは、そのマシンの `~/.config/shijimi-editor/config.toml` の `[server] start_dir` で始まる（書いていなければ `~`。書いたフォルダが無ければ設定ファイルの間違い。17 と同じ扱い）。キーはプライマリターミナルに向く。フォルダ未定のあいだ、サイドバーには「（フォルダ未定）」と出し、ファイルツリーは空。フォルダを選ぶ窓は作らない（`cd` や zoxide の `z` で移ればよい）。
3. **フォルダはプライマリターミナルの cwd だけから決める**。決め方は下の「フォルダの決め方」。同じフォルダの中での `cd`（`cd src` など）では何も起きない。
4. **`cd` はプロジェクトの切り替え**：プライマリターミナルが別のフォルダへ `cd` したら、そのワークスペースのフォルダがそこに切り替わる（新しいワークスペースは増えない。`workspace.changed` の `updated` で `folder` が変わる）。
   - 行き先のフォルダを指すワークスペースがすでにあっても、まとめない（同じフォルダのワークスペースが 2 つになる）。
   - 分割したターミナルはそのまま残す（元のフォルダにいたまま、そのワークスペースに属する。勝手に止めない、`cd` を打ち込まない）。
5. **`cd ~` と `cd /`（ホームと `/` そのもの）では切り替えない**。開いているファイルも閉じない。次にプロジェクトのフォルダへ移ったときに切り替わる。
6. **分割したターミナルの `cd` は、ワークスペースに何も影響しない**。
7. **[×] で閉じる**（`workspace.close`）：そのワークスペースのターミナル（プライマリと分割）を全部終わらせる。プログラムが動いているターミナルがあれば `busy` で断り、GUI は「動いているプログラムを終わらせますか」と確認を出してから `force: true` で送り直す。ワークスペースは [×] でしか消えない（シェルがいなくなっても消えない）。
8. （#557 で要らなくなった）同じファイルを複数のワークスペースで開いたときのバッファの共有は、`kisui serve` が `core` を持たなくなったので無い。別々の `shj` が同じファイルを開いたときは、ファイルの変更を検知して読み直す TUI の仕組みに任せる。
9. **`kisui serve` が止まったあと**（7 日の idle 停止・`server.shutdown`）：ワークスペースの一覧（`workspaceId` とそれぞれのフォルダ。フォルダ未定も）をそのマシンのファイルに保存しておき、次に起動したときに作り直す。プライマリターミナルはそのフォルダ（フォルダ未定なら `start_dir`）で自動で作り直す。保存していたフォルダがもう無ければ、フォルダ未定として作り直し、プライマリターミナルは `start_dir` で始める（ワークスペースは消さない）。分割したターミナルは戻さない。保存先は `$XDG_STATE_HOME/shijimi-editor/workspaces.json`（`serve.log` と同じ場所。nightly は別。実装は #450）。
10. **ターミナルの形**（「ターミナル」の節）：ワークスペースごとに、プライマリターミナル 1 つと分割したターミナル（上限なし）。右の欄に並べるのは、フォーカスしているワークスペースのターミナル。
11. **プライマリターミナルで `exit` しても、欄を閉じない**。「Enter で作り直す」を出し、Enter でワークスペースのフォルダ（フォルダ未定なら `start_dir`）で新しいシェルを始める（`term.restart`）。分割したターミナルの `exit` は、欄を閉じて並び直す。ただし、分割したターミナルがあるときは、プライマリのシェルが終わると serve が分割したターミナルの 1 つ（番号がいちばん小さい生きているもの）をプライマリにし、元のプライマリの欄を閉じる（`workspace.changed` で `primary` が変わる）。昇格した欄のシェルにも `SHIJIMI_GUI_PRIMARY` は渡してあるので（下の「伝え方」）、昇格のあとに起動した shj は名乗れる。
12. **リモートを足す**：サイドバーの一番下は「+ リモートを足す」（herdr の `machine add` のような形）。カードの窓で ssh の行き先（`~/.ssh/config` の候補）と名前（空なら ssh の行き先）を入れる。足すときに ssh でつなぎ（「ssh 越しに shj を起動する」）、`shj` が無ければ確認してから送り、`kisui serve` を起動できたらマシンを保存して見出しを出す。つなげなければ理由を出して保存しない（実装は #451）。マシンの一覧は GUI の側（手元）が持つ。shj のプロトコルには出ない。
13. **サイドバーに出るマシン**は「ローカル」と足したマシンだけ。`~/.ssh/config` のホストを全部並べない（候補に出すだけ）。
14. **マシンの見出しを右クリック**して「名前を変える」「外す」。外しても、そのマシンの `kisui serve` は止めない。
15. **既定のマシン**：手元（GUI を動かしているマシン）の `~/.config/shijimi-editor/config.toml` に書ける。設定ファイルに書いたマシンは、GUI の「外す」「名前を変える」では変えられない（設定ファイルを直す。実装は #453）。

    ```toml
    [[gui.machines]]
    ssh = "dev-vm"     # ssh の行き先
    name = "dev"       # サイドバーに出す名前。省くと ssh の行き先
    ```

16. **総称は「マシン」**（「ホスト」ではない）。「ローカル」もマシンの 1 つで、ほかは必ずリモート。足すボタンと窓は「リモートを足す」（#530）。
17. **設定ファイルに間違いがあれば起動しない**：TOML の書き方、知らない項目、型の違いが 1 つでもあれば、エディタも GUI も起動せず、ファイルの場所・行・理由を出す（実装は #446）。`start_dir` のフォルダが無い、`on-switch` が無い、も間違いに入る。
18. **名前の無いファイルは作れない**：TUI と GUI の `:new`（`:n`）は名前が必須（例：`:new foo.go`。実装は #447）。

フォルダの決め方（shj が行う。プライマリターミナルだけが対象）：

1. プライマリターミナルのシェルのプロセスの cwd を OS から読む（Linux は `/proc/<pid>/cwd`、macOS は `proc_pidinfo` の `PROC_PIDVNODEPATHINFO`）。フォアグラウンドのジョブの cwd ではなく、シェルの pid の cwd を使う。
2. cwd から親へたどり、最初に `.git`（フォルダでもファイルでもよい。git worktree は `.git` ファイル）か `.shijimi-editor/` があるフォルダをフォルダにする（`kind` は `git` / `shijimi`）。
3. 目印が無ければ cwd そのものをフォルダにする（`kind: "cwd"`）。
4. ただし cwd が `~` か `/` そのものなら、切り替えない（5）。たどる途中で `~` や `/` に着いても、そこはフォルダにしない。
5. 読むのは 1 秒に 1 回。フォルダが変わったときだけ通知する。（OSC 7 などシェルからの通知を足すのは、1 秒の遅れが気になってからにする）

`kisui serve` は `core` を持たない。フォルダが切り替わっても、`kisui serve` は一覧のフォルダを書き換えるだけで、編集中のファイルには触らない（編集はプライマリの欄の中の `shj` が行う）。

| メソッド | 向き | パラメータ → 結果 |
| --- | --- | --- |
| `workspace.list` | → shj | `{}` → `{workspaces: [Workspace], focus}`。`Workspace` は `{id, folder: path\|null, kind: "git"\|"shijimi"\|"cwd"\|null, name: string\|null, branch?, primary: termId, terms: [termId], primaryShj}`。`folder` が `null`（`kind` も `null`）なのはフォルダ未定のあいだ。`name` はフォルダ未定なら `null`（GUI は「（フォルダ未定）」と出す）。`primary` はプライマリターミナル、`terms` は分割したターミナル（並べる順）。`primaryShj` は下の「プライマリの shj」で、無ければ `null`。`layout` は下の「欄の配置」（分割の木。古い serve は送らない）。`extras` は下の「ターミナルでない欄」の `[{id, kind, path, mime, size}]`（無ければ `[]`。並びは開いた順で、GUI はターミナルの後ろに並べる）。以前あった `files`（開いているファイル）は #557 で外した |
| `workspace.create` | → shj | `{}` → `{id, termId}`。フォルダ未定のワークスペースを作り、プライマリターミナルを `start_dir` で始める。`termId` はそのプライマリターミナル。作ったワークスペースにはフォーカスしない（GUI が `workspace.focus` を送る） |
| `workspace.close` | → shj | `{id, force?: bool}` → `{}`。ターミナル（プライマリと分割）を全部終わらせてワークスペースを消す。プログラムが動いているターミナルがあれば、`force` が無い限り `busy` で断る（何も閉じない。GUI は確認を出してから `force: true` で送り直す）。`busy` の `data` は `{reason: "running"}` |
| `workspace.changed` | ← GUI | 通知 `{added?: [Workspace], removed?: [id], updated?: [Workspace]}`。ワークスペースが増えた / 減った / 中身（`folder`、ターミナルの増減、ブランチ、`primaryShj`）が変わった。`workspace.create`・`workspace.close` を送った GUI にも届く（返事より先に来ることがある） |
| `workspace.focus` | → shj | `{id}` → `{rev, termId}`。フォーカスを移す（GUI のフォーカスは 1 つで、`workspace.list` の `focus` で分かる）。`termId` はそのワークスペースのプライマリターミナル |

- `rev` はサーバー全体で 1 つの数にする（ワークスペースを移しても増え続ける）。
- **前の設計から消すもの**：`term.cwd`（フォルダが変わったことは `workspace.changed` の `folder` で分かる。分割したターミナルの cwd は GUI は要らない）と `workspace.close_files`（ワークスペースは [×] でしか消えず、ファイルだけ閉じる操作は作らない）。`workspaceId` を `null` にして「ワークスペースに属さない」を表すこともしない（どのターミナルもどれかのワークスペースに属する）。
- 空きの扱い：ワークスペースが 1 つも無いとき、GUI は何も出さずに [+] を待つ。ワークスペースを自動では作らない。

#### プライマリの shj

通信の版と、版を上げる決まりは [protocol.md](protocol.md)。名乗りの `{termId, socket, pid}` には `protocol`（版。無ければ 0）が付き、`kisui serve` が受けない版なら `{ok: false, code: "version", min, max}` で断る。

GUI はターミナルのマルチプレクサで、編集はプライマリターミナルの中で TUI の `shj` を動かして行う。`kisui serve` はワークスペースごとに「プライマリで動いている shj」を 1 つ覚え、`Workspace.primaryShj`（`{socket, pid, file?}`。無ければ `null`）で GUI に知らせる。変わると `workspace.changed` の `updated` で届く。`socket` はその shj の制御用ソケット（`core/ctl`、`<pid>.sock`）の場所。

- **伝え方**：`kisui serve` は、どのターミナルのシェルにも環境変数 `SHIJIMI_GUI_PRIMARY`（値はそのターミナルの `termId`）を渡す。`workspace.create` のときも `term.restart` のときも、分割したターミナル（`term.create`）にも。分割したターミナルがプライマリに昇格したあとでも、中の shj が名乗れるように。そのターミナルが今プライマリかは、名乗りを受けるときに serve が確かめる（次の項）。
- **知らせ方**：TUI の `shj` は起動して制御用ソケットを開いたあと、`SHIJIMI_GUI_PRIMARY` があれば `serve-primary.rpc`（`serve.rpc` と同じディレクトリ・ソケットは 0600、ディレクトリは 0700 で同じユーザーだけ。名前が `.sock` で終わらないのは `serve.rpc` と同じ理由）につなぎ、1 行の JSON `{termId, socket, pid}` を送る。返事は 1 行 `{ok: true}` か `{ok: false, error}`。`ok` のあいだ、つなぎっぱなしにする。
- **終わったことの見分け方**：その接続が切れたら（`shj` が終わった、落ちた、`kill` された）、`kisui serve` は `primaryShj` を `null` にする。プロセスの生存は調べない（接続が切れるのは OS がプロセスの終わりに閉じるから）。
- **最初の 1 つだけ**：`termId` が今プライマリのターミナルで（昇格の前の分割したターミナルは、環境変数があっても断る）、そのワークスペースにまだ `primaryShj` が無いときだけ `ok`。すでにあれば（入れ子の `shj` など）、プライマリでないターミナルなら、`ok: false`。さらに `shj` は名乗ったあと（名乗れなかったときも）自分の環境から `SHIJIMI_GUI_PRIMARY` を消すので、その `shj` が起動するものは名乗りに行かない。最初の `shj` が終わったあとは、次に起動した `shj` が名乗れる。
- **プライマリでない欄の `shj`**：変数はあるので名乗りに行くが、serve が `ok: false` で断る。断られた `shj` は名乗れなかったものとして、普通のターミナルで起動したときと同じに動く（ツリーを出す）。単一ファイルのモード（`shj <file>`）の `shj` も制御用ソケットを持たないので名乗らない。
- **ツリーの出し分け（#550）**：名乗りが `ok` だった `shj` は、自分のエクスプローラー（左の欄のファイルツリー）を出さない。エディタが幅を全部使い、`ツリーへ行くはずのフォーカス（`Ctrl+E`・`:tree`）はエディタに行き、ツリーは出ない（`Space e` は GUI のファイルエクスプローラに行く。#14）。差分モードの CHANGES も shj の左には出さず、GUI のサイドバーに出す（下の「差分モードの CHANGES」）。名乗れなかった `shj`（プライマリでない欄・名乗りを断られた・`kisui serve` が無い）は今まで通りツリーを出す。GUI のサイドバーは `primaryShj` が `null` でない間だけ、フォーカスしているワークスペースの帯の下にツリーを出す。`null` なら（`shj` を終えた、まだ起動していない）帯だけを出す。ツリーでファイルを押したときの動きはここでは変えない。
- **開いているファイルの知らせ方（#551）**：`ok` のあと、`shj` は同じ接続に 1 行ずつ JSON `{file}` を送る（名乗った直後に 1 回と、そのあと出しているファイルが変わるたびに。`file` はフォーカスしているタブのファイル（テキストか画像）の絶対パスで、差分やプレビューで出しているときもそのファイル。タブが無ければ `""`）。`kisui serve` は `primaryShj.file` に入れ（`""` なら省く）、変わると `workspace.changed` の `updated` で届く。読めない行や絶対パスでない `file` は捨てる。
- **ツリーで押したファイルを開く（#551）**：`shj.open` `{workspaceId, path}` → `{}`（→ shj）。`path` はワークスペースのルートからの相対パスで、`file.open` と同じ検査（`denied`・`not_found`・フォルダは `invalid_params`）をしてから、`primaryShj.socket` の制御用ソケットに `{cmd: "open", path: <絶対パス>}` を送る。`open` は `shj diff <path>` と違って差分モードに入らず、`:open` と同じにジャンプ位置を覚えてファイルを開き、キーをエディタに向ける（`path` は絶対パス。相対パスは断る）。ワークスペースに `primaryShj` が無ければ `not_found`。GUI はツリーのファイルの行を押すと `shj.open` を送り、返事が来たらプライマリターミナルを active にしてキーを向ける（断られたら、帯を押して移れなかったときと同じ所に理由を出す）。`primaryShj` が無いときはツリーを出さないので、何もしない（以前は `file.open` で GUI のファイルの欄に開いていた。#557 で外した）。ツリーの強調する行は `primaryShj.file`。動画のファイルを押したときの動きは「ターミナルでない欄（動画。#555）」。
- **差分モードの CHANGES（#19）**：名乗りが `ok` だった `shj` が差分モード（`Ctrl+G`）に入ると、変更したファイルの一覧（CHANGES）を GUI のサイドバーの、ファイルエクスプローラの下に出す。`shj` は自分の左に CHANGES の欄を出さない。差分モードでなければ一覧は出ない。対象は HEAD との差分モードと、PR との差分モード（`Space g`。#46）。PR モードの一覧は `PrimaryDiff.base: "pr"` で知らせ（無いか知らない値は HEAD）、名乗りの返事に `changesPR: true` を返した `kisui serve` にだけ送る。古い `kisui serve` の `{cmd: "diff"}` は HEAD との比較に切り替えてしまうため、`changesPR` の無い返事なら `shj` は PR モードで今まで通り自分の左に一覧を出す。新しい `kisui serve` が出す `{cmd: "diff"}` は、`shj` が PR モードのままにする（shijimi-editor#615）。サイドバーの見出しは比べている相手を「HEAD」「PR」と出す。
  - **知らせ方**：開いているファイルの知らせ（`ctl.PrimaryFile`）の `diff`（`ctl.PrimaryDiff`）に入れる。`diff` があるあいだが差分モードで、`diff` が無い行が差分モードの終わり。行はそのときの全体を送る（差分ではない）：`{file, diff?: {files: [{path, status?, added?, deleted?, viewed?}], selected?, base?}}`。`files` は `shj` が見せる順、`path` は絶対パス（削除されたファイルも）、`status` は `modified`・`added`・`deleted`・`renamed`・`binary`（知らない値は変更として出す）、`viewed` はそのファイルが PR で viewed になっている（#78。`base` が `"pr"` のときだけ入り、無ければ viewed でない。`kisui serve` は HEAD モードの `viewed` を捨てる。`space v` などで変わると、`shj` が一覧を送り直す）、`selected` は `shj` が今差分を出しているファイル。変更が無くても差分モードなら `diff` を付け、`files` は空にする。`shj` は一覧を 5000 件までにして送る（1 行の上限は 4 MiB で、超えた行は `kisui serve` がその行だけ捨てる。接続は切らない）。`kisui serve` は絶対パスでないファイルと、5000 件より先を捨てる。
  - **届け方**：`primaryShj.diff`（`{files, selected?, base?}`。差分モードでなければ省く）で GUI に届く。変わると `workspace.changed` の `updated`。引き継ぎ（`handover`）でも残す。
  - **一覧で選んだファイルの差分を出す**：`shj.diff` `{workspaceId, path}` → `{}`（→ shj）。`path` は `primaryShj.diff.files` の `path`（絶対パス）で、`kisui serve` はその `shj` が今の一覧に載せているものだけを通し（なければ `not_found`。差分モードでなくても同じ）、`primaryShj.socket` の制御用ソケットに既にある `{cmd: "diff", path}` を送る。削除されたファイルもあるのでファイルの有無は調べない。`diff` は差分モードに入っていれば一覧を読み直して `path` を選ぶ。GUI は返事が来たらプライマリターミナルにキーを向ける。
  - **CHANGES のキー（#45）**：一覧の行にフォーカスがあるときは、TUI の CHANGES（shj の `handleChangesKey`）と同じキーで動かす。`k`・`j`・`g`・`G`・`h`・`l`・Enter・`o` とその矢印・Home・End は GUI が行い（フォルダの木で、フォルダを開け閉めする）、開く操作は `shj.diff`。Tab は GUI のファイルエクスプローラへ、Esc・q は端末へ戻る。`s`・`r`・`R`・Space・`:` は shj の状態で動きが決まる（shj のフォーカスがエディタだと、端末に打った Space や `:` はファイルに入ってしまう）ので、`shj.changesKey` `{workspaceId, key}` → `{}`（→ shj）で頼む。`key` は `s`・`r`・`R`・`space`・`:` だけで、差分モードでなければ `not_found`。`space` と `:` が通ったら、GUI はプライマリの端末にキーを向け、続きのキー（`space w` の `w`・`space f` のあとの入力・Esc）は端末から shj に届く。shj は `changes-key` の `space` のあと、端末から来る次のキーを CHANGES のフォーカスの待ちとして扱う（TUI と同じ）。`kisui serve` は `primaryShj.socket` の制御用ソケットに `{cmd: "changes-key", line: <key>}` を送る。shj はそれを、CHANGES にフォーカスがあるときに押したものとして扱う（項目ではなく新しい命令なので、古い shj は `unknown command` で断り、GUI はその文を出す）。
  - **PR モードのキー（#46）**：PR モードでも、#45 のキーはすべて同じ。`r`・`R`（PR を読み直す）は `shj.changesKey`、`space v`（レビュー）・`space g`（PR との差分を開く・閉じる）は、`space` を `shj.changesKey` で渡したあと端末から届く続きのキー（`space w` の `w` と同じ）。`space g` で PR モードを抜けると `diff` が無くなり、一覧が消える。
  - **古い kisui・古い shj**：項目を足しただけなので版は上げない。新しい `shj` が古い `kisui serve` に当たると一覧が出なくなるので、`kisui serve` は名乗りの返事（`ctl.PrimaryReply`）の `changes: true` で「CHANGES を出せる」と知らせる。`shj` はこれが無い返事（古い `kisui serve`）なら、今まで通り自分の左に CHANGES を出す。古い `shj` は `diff` を送らず、自分の左に CHANGES を出すので、一覧は二重にならない。
- **一覧の見た目（#19）**：`app/src/changes/`。ファイルエクスプローラのすぐ下に細い線で区切り、「CHANGES 件数」の見出しのあとに フォルダの行と 1 ファイル 1 行（ファイル名・PR モードだけ viewed のチェックボックス `[x]` / `[ ]`（表示だけで、押しても変わらない。変えるのは `space v`。#78）・`+n`・`-n`・印 M/A/D/R/B）を並べる。サイドバーごとスクロールし、高さの上限は付けない。`shj` が今差分を出しているファイルの行は、ツリーと同じ色で強調する。行を押す（Enter でも）と `shj.diff`。TUI と同じフォルダの木で出し（フォルダの行を押すと開け閉めする。閉じたフォルダは GUI が覚える）、ワークスペースのルートの外のファイルは絶対パスのフォルダに入れる。
- **同じワークスペースのほかのターミナルから届く（#554）**：`kisui serve` は、そのワークスペースのどのターミナルにも環境変数 `SHIJIMI_GUI_WORKSPACE`（値は `workspaceId`）を渡す。名乗りが `ok` だった `shj` のソケットへのシンボリックリンクを `<ソケットのディレクトリ>/gui-<workspaceId>/primary.sock`（`ctl.GUILinkPath`。ディレクトリは 0700）に置き、`shj` が終わったら（接続が切れたら）消す。`shj diff`・`shj exec` などは、`SHIJIMI_GUI_WORKSPACE` があってそのリンクが生きていれば、`SHIJIMI_SOCKET` より先にそこへ送る。リンクが無い・切れているとき（プライマリで `shj` が動いていない）は、ふつうの探し方（`SHIJIMI_SOCKET`、herdr のリンク、生きたソケットが 1 つだけならそれ）に任せる。`kisui serve` は制御用ソケットも Claude Code 連携も持たず、`SHIJIMI_SOCKET` も IDE の環境変数も渡さないので、見つからなければエラーになる（#557。以前は `kisui serve` が受けて、フォーカスしているワークスペースの `core` に回した）。ターミナルの環境変数は起動のあとに変えられないので、ワークスペースの名前だけを環境に入れ、届く先はリンクで引く（herdr の `herdr-<ws>/` と同じ考え方）。Claude Code の IDE 連携は、プライマリの `shj` が書くロックファイルを `/ide` で選ぶ。
- **この仕組みの範囲**：ショートカットの出し分けなどは `primaryShj` を見る後続の Issue で行う。
- **プライマリの shj の欄（#553）**：プライマリの shj は、ターミナルのコマンド（``Ctrl+` ``・`:sh`・`:run`・`:!`・`Space t`・`Space a`）を、herdr の中で動くときと同じように「欄」に出す。`muxBackend` の GUI 版（`ui/tui/gui.go`）で、欄は同じワークスペースの分割したターミナル（個数に上限は無く、分けた後の欄が最小の大きさを下回れば断る。フォルダは頼んだ cwd、無いかフォルダでなければワークスペースのフォルダ）。置き場所は自動（下の「欄の配置」の `autoTarget`：木の最後の欄を右・下と交互に分ける）。
  - **頼み方**：名乗りとは別の接続で `serve-primary.rpc` につなぎ、1 行の JSON `ctl.PaneRequest`（`{op, termId, pid, ...}`）を送り、返事 1 行 `ctl.PaneReply`（`{ok, error?, id?, alive?, lines?}`）を受けて切る（herdr が毎回 CLI を呼ぶのと同じ形）。`termId` と `pid` は名乗ったときのもので、そのワークスペースの今の `primaryShj` と合わなければ断る。`op` は `split`（`cwd`・`env` で欄を足し、`id` を返す）・`alive`・`show`（`id`）・`hide`・`send`（`id`・`text`・`enter`。`enter` なら Enter を打つ）・`tail`（`id`・`n`。出力から制御列を取った最後の `n` 行。画面は持たないので近似）・`close`（`id`）・`explorer`（GUI のファイルエクスプローラにキーを向けさせる。`id` は使わない。`explorer.focus` `{workspaceId}` を GUI に通知するだけで、GUI はそのワークスペースにフォーカスしているときだけ、shj が出しているファイルの行（無ければ最初の行）にキーを向ける。ファイルエクスプローラで Esc を押すと今使っているターミナル（Space e から来たときはプライマリ）に戻る。項目を足しただけなので版は上げない：古い `kisui serve` は `unknown op` で断る。shj はツリーを隠しているので、断られたときキーは Space e がツリー無しで行く先に残る）。`changes`（`explorer` と同じで、行き先がサイドバーの CHANGES。`changes.focus` を通知する。古い `kisui serve` は `unknown op` で断る。#45）。`id` を取る op（`alive` 以外）は、その shj が `split` で作った欄にだけ効く（ほかの欄・プライマリには `ok: false`）。
  - **見せる・隠す**：GUI の状態なので `kisui serve` は持たず、`pane.show`・`pane.hide` を GUI に通知するだけ。`split` も `workspace.changed` のあとに `pane.show` を送る（作ったらその欄に移る）。
  - **終わるとき**：名乗りの接続が切れたら（shj が終わった・落ちた）、その shj が作った欄を全部閉じる（`term.close` と同じ）。欄の中のシェルが終わったら、GUI が分割したターミナルとして閉じる（`alive` が偽になり、次の ``Ctrl+` `` で作り直す）。
  - **選び方**：`[terminal] multiplexer` に `"gui"` を足した。`"auto"` は、`kisui serve` がプライマリとして認めた shj なら GUI を使う（親プロセスの tmux などより先。`kisui serve` を tmux の中で動かしていても、その shj は GUI の中にいるため）。`"gui"` を明に選んでも、プライマリでなければ内蔵のターミナルを使う（メッセージを出す）。プライマリでない欄の shj は名乗れないので、GUI の欄を使わず内蔵のターミナルのまま。`"none"`・`[experimental] multiplexer` の決まりは変えない。

- **ターミナルでない欄（動画 #555・画像と PDF #15）**：ターミナルでは動画を見られないので、プライマリの shj は動画のファイルを開くとき、読まずに GUI に欄を頼む。画像と PDF も同じ道で頼めるようにした（`kind: "image"`・`"pdf"`。shj が頼むようにする対応は shijimi-editor#607。それまで shj は画像を今まで通り TUI の中に出す）。欄の種類を足せる作りにしてある。内蔵ブラウザの欄（#556）は #96 で外した（下の「ブラウザの URL を開く」）。
  - **`split`・`title`（`kisui pane split` / `kisui pane title`。#21）**：`split` は `pane`（打った欄）を `dir`（`right` か `down`）に分け、新しいターミナルを足して `pane.show` で GUI にフォーカスさせる。足す場所と最小の大きさ（20 列・5 行を下回るなら断る）は GUI の分割（`term.create`）と同じ `planSplit`。`argv` があればシェルの代わりにそれを動かす（先頭は絶対パス。`kisui` が PATH で引いて渡し、PATH も `env` で渡す）。コマンドが終わると欄は閉じる。`cwd` は打った欄の cwd。`title` は打った欄に名前を付ける（空なら外す。100 文字まで、制御文字は不可）。名前は serve が持ち（`terminal.name`。引き継ぎでも残る）、`Workspace.titles`（欄の id -> 名前）で GUI に届き、欄の上の細い帯に出る（OSC のタイトルとは別）。GUI を開き直しても残り、欄が閉じれば消える。
  - **欄の持ち方**：欄はプライマリの shj の持ち物で、`Workspace.extras`（`{id, kind, path, mime, size}`）で届く。`id` は `x1`・`x2` … で、ターミナルの `t…` と混ざらない。`kind` は `"video"`・`"image"`・`"pdf"`（画像と PDF は動画と同じ道で、下の「画像と PDF の欄」）。`path` は `kisui serve` があるマシンの絶対パス、`mime` は種類ごとの拡張子（`server/filekind.go` の `fileKinds`。動画は `.mp4`・`.m4v`・`.mov`・`.webm`・`.ogv`・`.mkv`）から決めた型、`size` は開いたときの大きさ。変わると `workspace.changed` の `updated` で届く。名乗りの接続が切れたら（shj が終わった）、その shj の欄は全部消える（ターミナルの欄と同じ）。
  - **画像と PDF の欄**（`terminal/FileView.tsx`）：`path`・`mime`・`size` は動画と同じで、`media.read` で取る。拡張子と大きさの上限は `server/filekind.go` の `fileKinds`（画像 64 MiB：`.png`・`.jpg`・`.jpeg`・`.gif`・`.webp`・`.avif`・`.bmp`・`.svg`。PDF 128 MiB：`.pdf`）で、GUI の上限は `terminal/media.ts` の `MAX_BYTES`（同じ値）。種類を足すには `fileKinds`・`MAX_BYTES`・`FILE_LABEL`・`FileView.tsx` の本文に 1 つずつ足す。画像は `<img>`、PDF は WebView の PDF 表示（`<iframe>`）で出す。WebView が PDF を表示できない環境（WebKitGTK＝Linux）は、`navigator.pdfViewerEnabled` が偽なので、欄に「この環境では PDF を表示できない」と理由を出す（pdf.js は入れない。必要になったら `FileView.tsx` の本文だけ替える）。
  - **開く**：shj の `core` の `OpenFile` が、動画の拡張子で、かつ GUI のプライマリの shj（`core.VideoOpener`。TUI の `App.OpenVideo`）なら、ファイルを読まずに `ctl.PaneRequest` の `{op: "open", kind: "video", path}` を送る（`:open`・ツリー・パレットなど、ファイルを開く道は全部ここを通る）。返事は `id`。`kisui serve` は `path` が絶対パスで、動画の拡張子の通常ファイルのときだけ受ける。欄は種類ごとにワークスペースに 1 つで、同じ種類が開いてあれば新しい欄（新しい `id`）と入れ替える（開くたびに欄が増えないように。同じ動画なら欄を作り直して頭から再生する）。欄の数に上限は無く、自動で置く場所の欄が小さすぎて分けられなければ `ok: false`（shj は状態行に出す）。`workspace.changed` のあとに `pane.show` `{workspaceId, extraId}` を送る。`op: "show"`・`"close"` は欄の `id` にも効く（`send`・`tail` はターミナルだけ）。
  - **中身**：`media.read` `{workspaceId, id, offset?, length?}` → `{mime, size, data (base64), eof}`（→ shj）。`blob.get` と同じ形で、1 回に返すのは 4 MiB まで、大きさは読むたびに調べる。`kisui serve` が読めるのは今 `extras` にある欄のファイルだけで、ほかの `id` は `not_found`。ssh の向こうの動画も、shj との同じ接続の上で GUI に届く（別のポートは要らない）。
  - **URL のクリック（#47）**：ターミナルに出た URL のクリック（`cmd + click`・`cmd + shift + click`。macOS 以外は ctrl）は GUI の中で済み、`serve` を通らない。どちらも手元の外部ブラウザ（OS 既定のブラウザ）で開く。リモートのマシンの localhost 系の URL は、下の「ブラウザの URL を開く」と同じにポート転送越しの URL で開く。
  - **閉じる**：GUI の欄の × と `Cmd+W` は `extra.close` `{workspaceId, id}` → `{}`（→ shj）。shj からも `op: "close"` で閉じられる。GUI は送ったあと、`shj` の一覧から消えるまでその欄を並べ直さない。
  - **GUI の側**：欄はターミナルと同じ木に入る（`terminal/group.ts`・`TerminalGrid.tsx`。タブにはしない）。`pane.show` の `extraId` が来たら、隠していれば戻し、その欄にキーを向ける。ツリーで押したファイルの `shj.open` の返事は、その間に動画の欄が出ていたら、プライマリにキーを奪い返さない。`Ctrl+Shift+M`（隠す）と `Ctrl+Shift+矢印`（隣へ）はターミナルの欄と同じに動画の欄にも効く。
  - **再生**（`terminal/media.ts`・`VideoView.tsx`）：WebView の `<video>` に範囲を指して渡す道（独自のスキームや Service Worker）が使えないので、`media.read` を `eof` まで繰り返して 1 つの `Blob` にして渡す。取る前に `size` を見て、512 MiB を超える動画は取らず、欄にその理由を出す。キーは欄にキーが向いているときだけ受け（空白・`k` は再生と停止、`←`・`→` は 5 秒、`j`・`l` は 10 秒、`m` は消音）、Ctrl・Alt・Meta を押したキー（GUI のショートカット）は止めない。WebView が対応していない形式（WebKit の `.mkv` など）は「再生できません」と出す。
  - **プライマリでない欄の shj**：`VideoOpener` を持たないので、今まで通り（動画の欄は使わない）。
  - **ブラウザの URL を開く（#96。内蔵ブラウザの欄 #556 は外した）**：GUI のプライマリの shj の `App.OpenURL`（`:open-url`・`Space o`・`Space v o` が通る）と `kisui open <URL>` は、`ctl.PaneRequest` の `{op: "open", kind: "browser", url}`（`kisui open` は `panecmd.Request` の `open`）を送る。`kisui serve` は `url` が http か https で、host があり、ユーザー名・パスワードを含まず、制御文字を含まず、4096 バイト以下のときだけ受ける（ほかは断る）。欄は作らず（`extras` に入らない。返事の `id` は空）、GUI に通知 `browser.open` `{workspaceId, url}` を送る。通知を送る GUI（持ち主）がつながっていなければ、`ok: false`（`no GUI is connected to open the URL`）で断る。GUI は通知を受けて、手元の外部ブラウザ（OS 既定のブラウザ。殻の命令 `open_url_external`）でその URL を開く。URL が localhost 系（`localhost`・`127.0.0.1`・`::1`・`0.0.0.0`・`*.localhost`）で、通知が来たのがリモートのマシンのときは、GUI が手元で `ssh -N -L 127.0.0.1:<手元のポート>:localhost:<URL のポート> <マシン>` のポート転送を張り、転送先（`http://127.0.0.1:<手元のポート>/…`）の URL を開く。転送はマシンと URL のポートごとに 1 本で、生きていれば使い回し、アプリを終えるまで残す。設計は browser-and-proxy.md の「GUI の外部ブラウザ」。

- **欄の中のコマンド（`kisui open`。#20）**：欄の中のシェルからも、ターミナルでない欄を開ける（`kisui open <ファイル|URL>`）。shj は要らない。kisui-terminal 自身のもので、shj との取り決め（[protocol.md](../protocol.md)）には入らない（`internal/panecmd`）。
  - **見つけ方と名乗り方**：`kisui serve` は、始めるどのターミナル（プライマリも分割も）にも、`KISUI_SOCKET`（`serve-primary.rpc` の絶対パス）・`KISUI_PANE`（そのターミナルの `termId`）・`KISUI_PANE_TOKEN`（そのターミナルだけの 128 ビットの乱数）を渡す。コマンドは `serve-primary.rpc` につなぎ、1 行の JSON `{cmd, pane, token, target?}` を送り、返事 1 行 `{ok, error?, code?, id?}` を受けて切る。`kisui serve` は `cmd` があるかで shj の行（名乗り・`ctl.PaneRequest`）と分ける。`pane` が生きているこの serve のターミナルで、`token` がそのターミナルのものと合うときだけ受け、合わなければ `{ok: false, code: "not-in-pane"}`。秘密は `server.handover` で次の serve に渡す（古い serve から引き継いだターミナルには無いので、その欄では使えない）。
  - **断れる相手**：ソケットは 0700 のディレクトリの中の 0600 なので、ほかのユーザーはつなげない。同じユーザーの、欄の外で始まったプロセスは秘密を知らない（`KISUI_*` が無ければ `kisui open` はつなぐ前に断る）。同じユーザーはプロセスの環境を読めるので、これは鍵ではなく「欄の中から使う」ための区切り。ssh の先の欄では、そのマシンの `kisui serve` に同じ形で話す（GUI と同じ接続で欄が出る）。
  - **`open`**：`target` は http か https の URL（欄は作らず、GUI の手元の外部ブラウザで開かせる。受ける URL は上の「ブラウザの URL を開く」と同じ）か、絶対パスのファイル（`kisui open` が相対パスを今の cwd から絶対パスにする）。`<scheme>://` の形でほかのスキームなら断る。ファイルの種類は拡張子（`fileKinds`）で決め、合わなければ頭の 512 バイト（`http.DetectContentType`）がどれかの種類の `mime` のときその種類にする。大きさの上限・欄が種類ごとに 1 つで同じ場所で入れ替わること・足す場所（分割の木の `autoTarget`）・`pane.show` は shj の `open` と同じ（同じ種類なら、shj が開かせた欄とも入れ替わる）。
  - **欄の持ち方**：欄の中から開いた欄はワークスペースの持ち物で、shj が終わっても消えない。GUI の `extra.close` かワークスペースを閉じるまで残る（shj は自分が開かせていない欄を `close` できない）。`Workspace.extras` には、shj の欄と合わせて開いた順（`id` の番号の順）に並ぶ。
  - **コマンドの形**：欄の中で使うコマンドは `kisui <コマンド>` か、種類ごとに `kisui <種類> <コマンド>`（`kisui pane split` など）の 2 段に置く。`cmd/kisui/main.go` の `commands` に足すと `kisui --help` の一覧にも出る。serve との話し方は `panecmd.Request` の `cmd` を足す。
  - **通知とクリップボード（`kisui notify`・`kisui clipboard copy`・`kisui clipboard paste`。#22）**：serve を通さず、欄の端末（`/dev/tty`）に kitty の取り決めを書く（`internal/kittyterm`）。通知は OSC 99（`e=1` で文を base64 にした題名）、クリップボードは OSC 5522（`text/plain` だけ。書き込みは `type=write`・`wdata`、読み取りは `type=read`）。serve は欄のバイト列をそのまま GUI に流し、GUI の coneko-term がすでにこれを OS の通知とクリップボードにつなぐ（読み取りは `ClipboardDialog` で毎回聞く）ので、GUI と serve に足すものは無く、ssh 先の欄でも同じに動く。答え（書き込みの `status=DONE`、読み取りの `OK`・`DATA`・`DONE`、断りの `EPERM` など）は、端末の行の編集とエコーを止めて読む（シェルにも画面にも出さない）。Ctrl+C は効くまま。答えを待つのは、書き込みで 10 秒、読み取りで 5 分（ユーザーが答えるのを待つ）。serve の欄の coneko-term（`term.attach` の書き出しのため）は端末への返事を捨てるので、答えは GUI からの 1 回だけ。書き出しには問い合わせが入らないので、つなぎ直しても通知や読み取りの頼みはもう一度出ない。kitty の取り決めには頼みの取り消しが無いので、`paste` を Ctrl+C で止めた（か待ち切った）あとも GUI の「クリップボードを読ませますか」の窓は残る。そこで「読ませる」を押すと、答え（クリップボードの中身の base64 を含む OSC 5522）は端末の設定を戻したあとに届き、シェルに入力として入って画面に出る（改行は無いので実行はされない）。直すなら GUI の側（その欄のキー入力で窓を閉じる、など）。
  - **PATH**：`kisui serve` は自分の実行ファイルのフォルダを欄の PATH の先頭に足す（Nix のパッケージは `kisui` を PATH に出さないため。AppImage・.app・ssh 先のキャッシュは同梱の shj と同じフォルダ）。


### ファイルのツリー

GUI は複数のワークスペースのツリーを（開閉の状態を持って）並べるので、`core` の `Explorer`（TUI の 1 つの木）とは別に、状態を持たない取得の API にする。開閉とスクロールの位置は GUI が持つ。

| メソッド | 向き | パラメータ → 結果 |
| --- | --- | --- |
| `tree.list` | → shj | `{workspaceId, path ("" = ルート)}` → `{entries: [{name, kind: "file"\|"dir"\|"symlink", target?, size?, git?: "M"\|"A"\|"D"\|"R"\|"?"\|"!"\|"U", gitChildren?: bool}], truncated?, rev}`（`rev` はツリー専用の版で、`tree.changed` のあとの取り直しで古い返事を捨てるのに使う）。1 階層だけ（フォルダを開いたときに取る）。`.gitignore` で無視されているものは `git: "!"`。順番は TUI のツリーと同じ（フォルダが先）。5000 件で切る |
| `tree.watch` | → shj | `{workspaceId, paths: [...]}` → `{}`。GUI が開いているフォルダを教える。サーバーはそこだけ監視する（`watch.go` と同じ仕組み） |
| `tree.changed` | ← GUI | 通知 `{workspaceId, paths: [...], rev}`（`rev` は `tree.list` と同じ版。これより古い `tree.list` の返事は捨てる）。そのフォルダの中身が変わった。GUI は `tree.list` を取り直す |
| `git.status` | → shj | `{workspaceId}` → `{branch, ahead?, behind?, marks: {"path": "M"}, rev}`（`rev` は git 専用の版で、`git.changed` との前後の判定に使う）。全体の印。フォルダの印は `gitChildren` を使って GUI が求める |
| `git.changed` | ← GUI | 通知 `{workspaceId, branch?, marks?: {"path": "M"\|null}, rev}`（`rev` は `git.status` と同じ版）。変わった分だけ（`null` は印が消えた） |
| `tree.create` | → shj | `{workspaceId, path, kind: "file"\|"dir"}` → `{}` |
| `tree.rename` | → shj | `{workspaceId, from, to}` → `{}`。ディスクの上で移すだけ（開いているファイルの付け替えは、そのファイルを開いている `shj` が自分で追う） |
| `tree.delete` | → shj | `{workspaceId, path}` → `{}`。GUI が確認してから送る（TUI の `yesNo` と同じ流れ） |

- パスはワークスペースのルートからの相対パス（`/` 区切り）。ルートの外へ出る（`..`、ルートの外を指すシンボリックリンクの先）パスは `denied`。
- ファイル名が UTF-8 でないときは、`name` の不正な部分を `�` に置き換え、元のバイト列を `nameRaw`（base64）で足す。
- 印の文字：`M` 変更、`A` 追加、`D` 削除、`R` 名前変更、`?` 追跡していない、`U` 衝突（マージ中）、`!` `.gitignore` で無視。`.git` は一覧に出さず、`tree.create` / `tree.rename` / `tree.delete` でも触れない（`denied`）。
- GUI でファイルの行を押す（Enter・Space でも）と、プライマリの shj があれば `shj.open`（「プライマリの shj」の節）を送る。ツリーはプライマリで shj が動いているときだけ出すので、`shj.open` が通ったら、プライマリのターミナルを active にしてキーをそこに向ける。断られたら（`denied`・`not_found` など）、帯を押して移れなかったときと同じ所に「<path> を開けませんでした（理由）」を `role="alert"` で出す。ワークスペースを移している途中（`workspace.focus` の返事待ち）は送らない（移った先のプライマリで開くため）。プライマリの shj が出しているファイル（`primaryShj.file`）がルートの中なら、その行を強調する（`app/src/tree/model.ts` の `rowAction`・`relativeIn`）。
- GUI でツリーの行を右クリックすると、メニューを出す（`app/src/tree/menu.ts`・`TreeMenu.tsx`）。ファイルは「名前をコピー」「相対パスをコピー」「絶対パスをコピー」「名前の変更」「削除」、フォルダはそれに「新しいファイル」「新しいフォルダ」「ここへ移動」を足す。新規・名前の変更は、ワークスペースのフォルダからのパスを入れる窓（`tree.create`・`tree.rename`。新しいファイルは作ったら `shj.open` で開く＝TUI の `a` `A` `r` と同じ）、削除は確認の窓（`tree.delete`。TUI の `d` と同じ）。断られたら窓を開いたまま理由を出す。
- 「ここへ移動」は、そのワークスペースのプライマリターミナルに `term.cd` で `cd -- '<絶対パス>'` を送る（フォルダはプライマリターミナルの cwd で決まるので、シェルが `cd` すればツリーも切り替わる）。パスの引用と、入力の途中の行を消す処理は shj がする。シェルのほかにプログラムが動いているときは `busy` で断られ、GUI は理由を出して何もしない。

### ssh 越しに kisui を起動する

GUI はシステムの `ssh` を子プロセスとして起動する（`~/.ssh/config` と ssh-agent をそのまま使うため）。ssh がパスワードや 2 段階認証を求めるときは `SSH_ASKPASS` で GUI の窓に出す。

1. **kisui の場所**：`~/.cache/kisui-terminal/<GUI の版>/kisui` だけ。リモートの PATH の `kisui` は使わない（GUI と同じ版しか使わないため。`SHIJIMI_REMOTE_KISUI` で場所を手で指定したときを除く）。無ければ、ユーザーに聞いてから GUI が転送する。PATH の `kisui` には触らない。リモートの OS とアーキテクチャは `uname -sm` で調べ、合う実行ファイルを GitHub Releases から GUI が取って送る。取ったら送る前に、GitHub Releases の checksums（GUI の Release に上げる `SHA256SUMS`。`sha256sum` の形式）にある SHA-256 と、取得した実行ファイルを比べる（取得の段階の確認。合わなければ ssh を起動する前に捨てる）。リモートに置いたファイルも同じ値かを確かめる（転送の壊れの確認。リモートで一時ファイルの SHA-256 を計り、合ったときだけ `kisui` の名前にする）。kisui が無いことは、2 のコマンドの終了コード 97 で知る（`ssh` 自身の失敗は 255）。取り先は shj のリリースではなく GUI の Release（#581）で、普通の版はタグ `kisui-terminal-v<GUI の版>` の `kisui-<os>-<cpu>`、nightly 版の GUI は動くタグ `kisui-terminal-nightly` の `kisui-nightly-<os>-<cpu>` を取る。
2. **つなぐ**：`ssh -T host -- sh -c '<1 の場所に kisui があれば exec <kisui> attach、無ければ exit 97>'`（ログインシェルが fish などでも動くよう `sh -c` で包む。環境変数 `SHIJIMI_REMOTE_KISUI` で場所を指定したときは、その場所だけを見て `command -v <kisui> >/dev/null 2>&1 || exit 97; <kisui> attach`）（`-T` は端末を割り当てない）。ユーザーの `ssh_config`（`ControlMaster` など）はそのまま効く。
3. **`kisui attach` がすること**（リモートで動く橋渡し）：
   1. 標準出力に `@@shj-rpc 1@@` を出し、すぐあとに `attach.info`（自分の実行ファイル `os.Executable`・版・`KISUI_SHJ_DIR`）を 1 行出す。
   2. ソケットのフォルダを見て、`kisui serve` が動いていれば、その Unix ソケットにつなぐ。**すでに動いている shj につなぎ直す方法はこれ。** ssh のたびに新しい shj は起動しない。
   3. 動いていなければ、`kisui serve` を切り離して起動する（`setsid`。標準入出力は閉じ、ログはファイルへ）。ソケットができるまで（最大 5 秒）待ってつなぐ。2 台の GUI が同時に起動しても 1 つになるよう、ソケットのフォルダの中のロックファイル（`flock`）を使う。
   4. 標準入出力とソケットの間を、バイトのままコピーする（プロトコルは解釈しない）。どちらかが閉じたら終わる。
4. **「ローカル」**：`ssh` を挟まず、GUI が、自分と一緒に配った `kisui`（AppImage の `usr/bin/kisui`、.app の `Contents/MacOS/kisui`、Nix のパッケージの `../libexec/kisui`。環境変数 `SHIJIMI_KISUI` があればそれを使う）の `kisui attach` を直接起動する。PATH の `kisui` や `shj` は探さない（GUI と同じ版しか使わない）。Finder や Dock から起動した macOS のアプリはログインシェルの PATH を引き継がないので、起動のときにログインシェル（`$SHELL -l -i -c`、5 秒で諦める）に PATH を聞き、GUI の PATH とよく使う場所（`~/.nix-profile/bin`・`/opt/homebrew/bin`・`/usr/local/bin`・`~/.local/bin` など）を足して、`kisui attach` に渡す（`kisui serve` の中のターミナルが `shj` などを見つけるため）。待つのはメインスレッドの外（`connect` は async のコマンド）。`kisui attach` にもこの PATH を渡す（`kisui serve` の中のターミナルが引き継ぐ）。
4b. **欄の中の `shj`**：kisui は、欄のターミナル（`term.create`・プライマリの再起動を含む）を始めるとき、同梱の shj のあるフォルダを `PATH` の先頭に足す。フォルダは、環境変数 `KISUI_SHJ_DIR`（Nix のパッケージで GUI が渡す。`../libexec/shj-bin`）、無ければ kisui の実行ファイルと同じフォルダ（AppImage の `usr/bin`、.app の `Contents/MacOS`、リモートのキャッシュ `~/.cache/kisui-terminal/<GUI の版>/`）の `shj`。リモートでは、1 の転送で kisui の前に同じ Release の `shj-<os>-<cpu>`（nightly は `shj-nightly-<os>-<cpu>`）も同じ確かめ方で入れる。Nix の GUI は shj を `bin/` に出さない。
5. **版が違う `kisui serve` が動いていたら**：`attach` は版が違っても動いているサーバーにつなぐ（`attach` は入れ替えない）。GUI が `session.hello` の結果と `attach.info` を比べて気づき、ユーザーに聞かずに、`server.handover` に `kisui attach` 自身の実行ファイル（ローカルならアプリに同梱した kisui、リモートなら 1 の場所。`attach.info` の `executable`）を渡して入れ替えさせる（前の節の「版が違うとき」、「`kisui serve` の引き継ぎ」の節）。リモートに GUI の版の kisui が無ければ、今までどおり 1 で入れるかを聞いてから入れ、入れた kisui の `attach` が名乗ったところで入れ替える。

セキュリティ：Unix ソケットは 0700 のフォルダの中（自分のユーザーだけ）。`kisui serve` はネットワークに待ち受けない。リモートの認証は ssh に任せる。`kisui attach` の段階で追加の認証はしない（同じユーザーなら元々シェルを開ける）。

### サーバーモード（`kisui serve`）の中身

- `kisui serve` は `core` を持たない（P14 の `core.Workspaces` は #557 で外した）。持つのは、ワークスペース・ターミナル・ファイルツリー（`tree.*`・`git.*`）・プライマリの `shj` との連携（`serve-primary.rpc`）だけ。
- 制御用ソケット（`ctl`）と Claude Code 連携（`ide`）は持たない。`shj diff`・`shj exec` は、プライマリの `shj` のソケットへ届く（「プライマリの shj」の節）。言語サーバーと整形も `kisui serve` では起動しない（direnv の環境を読む処理は、編集が `kisui serve` の外に出たので要らなくなり、外した）。
- `core.Port` は `kisui serve` が満たさない。クリップボードへの書き込み（OSC 52）と URL を開く操作は、プライマリの `shj` の端末が GUI の coneko-term に送る。
- ログは `$XDG_STATE_HOME/shijimi-editor/serve.log`（無ければ `~/.local/state/…`）。サイズが 10 MiB を超えたら先頭を捨てる。

### `kisui serve` の引き継ぎ（`server.handover`）

`kisui serve` は GUI から切り離して動くので、GUI を更新しても前の版の serve が動き続ける。`server.handover` で、動いている serve（古い serve）が、欄のシェルと画面を消さずに別の実行ファイルの serve（新しい serve）に入れ替わる。protocol 4.1 で足した（`capabilities` に `server.handover`）。これより前の serve は引き継げないので、ユーザーが 1 回だけ手で終わらせる。実装は `server/handover.go`（古い serve）と `server/adopt.go`（新しい serve）。

1. **起動**：古い serve は、頼まれた実行ファイルを `kisui serve --handover` で起動する（自分で実行ファイルを探さない）。環境変数は「環境変数」の項のとおり。`setsid` で GUI から切り離し、標準入出力は `/dev/null`。socketpair の片方を fd 3 で渡し、その上で話す（1 通は 4 バイトの長さ + JSON。fd は SCM_RIGHTS で 64 個ずつ）。
2. **hello**（新 → 古）：新しい serve が話せる引き継ぎの版の一覧。古い serve は両方にある一番新しい版を使う（今は 1）。設定の間違いなどで起動できなければ、新しい serve は理由を `error` で返す。版は、手順とデータの形を変えるときに足し、前の版もしばらく話せるようにする（前後の版どうしで引き継げるように）。
3. **止める**（古い serve）：状態を変える仕事（GUI の要求・shj の名乗りと欄の頼み・cwd とツリーの見回り・idle の停止）を止め、進んでいるものが終わるのを待つ。待ち受け（`serve.rpc`・`serve-primary.rpc`）の `accept`、名乗った shj の接続の読み、PTY の読みを、読みの期限で止める（閉じない）。止めている間に届いた PTY の出力は PTY に、新しい接続は待ち受けのキューに残る。
4. **state**（古 → 新）と fd：渡すのは次のもの。
   - fd：`serve.rpc` と `serve-primary.rpc` の待ち受け、名乗った shj の接続、生きているシェルの PTY の master。
   - ワークスペース：id・並び・フォルダ・プライマリターミナル・プライマリの shj（ソケット・pid・出しているファイル・その shj の欄とターミナルでない欄）・フォーカス・id の連番。
   - ターミナル：id・pid・cwd・ワークスペース・プライマリか・大きさ・タイトル・生きているか・リングバッファの中身と `seq`・送ったところと ack・画面の状態の書き出し（`term.attach` と同じ coneko-term の `Terminal::serialize`）。新しい serve は、書き出しを新しいエミュレーターに書いて画面の状態を作り直すので、`term.attach` は引き継ぐ前と同じ画面と `seq` を返す。
   - 名乗った shj の接続で、読んだがまだ行として扱っていない分（行の途中で止めても落とさない）。
   - `serverId`・`startedAt`・`rev`・最後に GUI がつながっていた時刻・ツリーの監視。状態が続くので `serverId` は変えない（GUI は `resume` でつなぎ直して `term.attach` で続けられる）。
5. **ready**（新 → 古）：新しい serve は受け取ったもので状態を作り、自分の pid を返す。作れなければ（ソケットの場所が違うなど）`error` を返す。
6. **go**（古 → 新）：古い serve はここで引き継いだことにする。`server.handover` に返事をしてから GUI の接続を閉じて終わる。シェルに合図は送らず、ソケットも消さない。新しい serve は `go` を受けるか、古い serve との接続が閉じたら、PTY と shj の接続を読み、待ち受けを始める。

- **失敗したとき**：5 より前に失敗したら（新しい serve が `error` を返した・終わった・時間切れ）、古い serve は新しい serve を SIGKILL で止めてから、止めていたものを戻して動き続ける。シェルも画面も GUI の接続も失わない。新しい serve は `go` か接続が閉じるのを待つまで何も読まないので、止められれば何も取らない。
- **GUI の接続と要求**：GUI の接続は渡さない（古い serve が閉じ、GUI は `kisui attach` でつなぎ直す。新しい serve は同じソケットにいる）。引き継ぐ間に届いた要求は待たされ、引き継いだあとは何もせずに `busy`（`data.reason` は `handover`）で断るので、GUI はつなぎ直してから送り直せる。引き継いだあとに届いた通知（`term.ack`）は捨てる（つなぎ直したら `term.attach` で取り直すので要らない）。
- **渡さないもの**：名乗る前の shj の接続と、`serve-primary.rpc` で処理を待っていた欄の頼みは、引き継いだあとに断る（その一瞬に名乗った shj は、プライマリの shj にならない）。git の状態のキャッシュは新しい serve が取り直す。出力の途中で切れたタイトル（OSC 0 / 2）は捨てる。ターミナルでない欄（動画・画像・PDF）は、プライマリの shj の状態としてそのまま渡す（中身は GUI が `media.read` で取るので、serve は持っていない）。
- **シェルの終わりを知る**：引き継いだシェルは新しい serve の子ではないので `wait` できない。PTY の master の読みが終わった（シェルとその子が端末を手放した）あと、プロセスが無くなるまで待ってから `term.exit` を送る（Linux では pidfd を使うので、pid が使い回されても取り違えない）。終了コードは分からないので `code` は無い。終わったシェルにはもう合図を送らない（閉じるときの SIGHUP を、使い回された pid に送らないため）。pidfd の無い macOS では `kill(pid, 0)` で確かめるので、シェルが終わってから確かめるまでの間に pid が使い回されると、終わりに気づかず `term.exit` が届かないことがある（まれ）。古い serve は、引き継いだあと終わるまでの間、自分の子のシェルを刈り取る。
- **環境変数**：新しい serve の環境変数は、古い serve のもの（古い GUI が `kisui attach` に渡したもの）から `KISUI_SHJ_DIR` を外し、`server.handover` の `env` を上書きしたもの。`KISUI_SHJ_DIR` は古い版の shj を指しているので外す（無ければ新しい serve は自分の実行ファイルの隣の shj を使う。Nix のパッケージのように隣に無い配り方では、GUI が `env` で新しい版のフォルダを渡す）。`PATH` なども、変えたければ GUI が `env` で渡す。
- **Linux と macOS**：PTY の読みを止めるのに、読みの期限（`SetReadDeadline`）を使う。creack/pty は ioctl のたびに master を blocking にする（macOS では初めから blocking）ので、`kisui serve` は master を dup して O_NONBLOCK にしたものを使い、大きさの変更も自分で ioctl する。期限が効かない master があると、引き継ぎは止める前に断る（古い serve は動き続ける）。

### GUI の配り方と自動更新（C8）

- リリースの workflow（`.github/workflows/build.yml`。`release.yml` と `nightly.yml` から呼ぶ）が、macOS（Apple シリコン）の署名なしの `.dmg` を作り、Tauri の updater の `latest.json` と一緒に Release に上げる。Linux の AppImage（x86_64・aarch64）は `linux-appimage.yml` が 2 週間に 1 回、最新の安定版に足す。macOS の Intel は作らない。
- 自動更新は AppImage と `.dmg` だけ（cargo の feature `updater`。workflow だけが付ける）。Nix で作る版（`nix build .#kisui-terminal`・home-manager の `programs.shijimi-editor.kisui-terminal`）は付けないので、更新は `nix flake update` と `home-manager switch` で行う。
- 更新は、起動のときに 1 度だけ調べ、新しい版があれば右下に出し、ユーザーが「更新して再起動」を押したときだけ入れ替える（編集中に勝手に起動し直さない）。調べられなかったときは何も出さない。
- 普通の版は `releases/download/kisui-terminal-latest/latest.json`（GUI のリリースのたびに置き換える pre-release `kisui-terminal-latest` のもの。shj のリリースは指さない）、nightly 版は pre-release `kisui-terminal-nightly` の `latest.json` を見る。nightly 版は `tauri.nightly.conf.json` を重ね、名前 `kisui-terminal-nightly` と identifier を変えて普通の版と並べて入れられるようにする。nightly は版の前後を問わず、`latest.json` の版が今と違えば更新とする（`allowDowngrades`）。
- GUI の版は shj の版とは別で、`app/src-tauri/Cargo.toml` の `version`（workflow は `tauri build --config`、Nix は `TAURI_CONFIG` で入れる）。リモートに入れる shj の版（上の「ssh 越しに shj を起動する」の 1）もこれを使う。
- 署名鍵は minisign で、パスワードは付けない（秘密鍵は 1Password にしか置かないので、足しても守りは強くならない）。workflow は 1Password のサービスアカウントで、ビルドの直前に読む。公開鍵は `tauri.conf.json` の `plugins.updater.pubkey`。

## 4. あとから足せる余地

- **新しいメソッド**は `capabilities` で見分ける。メソッドの意味を変えるときは `protocol.major` を上げる。ワークスペースをフォルダから切り離す変更（「ワークスペース」の節）は `workspace.*`・`term.*` の意味と形を変えるので、`protocol.major` を 1 つ上げる（実装は #448）。文言を `Msg` で送る変更（`screen.update` の文言が文字列から `{key, args}` になる）も形が変わるので、`protocol.major` を 3 に上げた（実装は #466）。画面と入力のメソッドを外した変更（#557）で 4 に上げた。

## 5. 決めたことと理由

- **ターミナルは `Screen` に入れない**：`ui/tui/vt` を GUI に持ち込まず、coneko-term の機能をそのまま使える。
- **GUI の編集画面を外し、編集はプライマリの欄の中の `shj` に任せる（#557）**：TUI と GUI で同じ画面を 2 回作り続けないため。GUI がファイルの欄で `Screen` を描き、キー・IME・マウス・貼り付けを作り直す方式は、TUI に機能が増えるたびに GUI も直す必要があり、揃え続けられなかった。GUI はマシン・ワークスペース・ターミナルの欄・ファイルツリー（マルチプレクサ）に絞り、GUI にしかできないもの（動画・ブラウザ）だけを欄として足す。外すと、`kisui serve` が持っていた編集の部品（ワークスペースごとの `core`、画面と入力のメソッド、制御用ソケット、Claude Code 連携、言語サーバーと整形の起動、未保存の編集の `.bk`）も要らなくなる。
- **`protocol.major` を 4 に上げる（#557）**：`view.*`・`screen.*`・`input.*` などを外し、`Workspace.files` を消すため。古い GUI は `incompatible_protocol` になり、GUI が新しい `shj` を入れる流れに乗る（動かない画面を出さない）。
- **`Cmd+J`・``Ctrl+Shift+` `` を外す（#557）**：IDE モードとターミナルモードの切り替えが無くなったので、押すものが無い。右の欄は全部ターミナル（自動で並べる）で、隠す・出すは `Ctrl+Shift+M`（Mac は `Cmd+Shift+Enter`）。
- **リサイズモードは GUI が受けてサイドバーの境界だけを動かす（#557）**：以前は `core` がリサイズモードに入り、GUI に `resize.start` を送っていた。`core` が無いので GUI が直接入る。動かせる境界は、サイドバーとその右のターミナルの間だけになった（ファイルの欄とターミナルの境界、差分とプレビューの分割は無くなった）。
- **`[editor.auto-save] on-switch` を必須にしない（#557）**：`kisui serve` が開いているファイルをどうするかを決めるためだけの設定だった。自動保存を切っても書かなくてよくなり、書いてある設定ファイルが読めなくなるのは避けたいので、値の検査はそのまま残して使わない。
- **ツリーは GUI が持つ状態なので、`Screen` と別の API**：GUI は複数のワークスペースのツリーを同時に持ち、開閉は GUI の状態だから。
- **`kisui attach` と `kisui serve` を分ける**：ssh が切れても状態を残し、つなぎ直しを同じ流れ（`attach` を再実行）にするため。
- **framing は改行区切りの JSON**：ssh の標準入出力に載せやすく、ACP・制御用ソケットと同じ。MessagePack にするときは長さ付きにする。
- **版が違う `kisui serve` は、聞かずに新しい版に引き継がせる（#8）**：`server.handover`（#7）でシェルも画面も消えないので、聞く理由が無い。比べる相手を GUI の版の文字列でなく `kisui attach` が名乗る版にしたのは、`kisui serve` の版と同じ作り方（`buildinfo`）で比べられ、nightly の `version` が `X.Y.Z` だけでも `commit` で見分けられるため。`kisui attach` 自身の実行ファイルの絶対パスは、リモートでは GUI から分からない（`~` の先）ので、`attach` に名乗らせる。
- **ワークスペースの消え方**：[×]（`workspace.close`）でしか消えない。シェルがいなくなっても、ファイルが無くなっても消えない。理由：`cd` はプロジェクトの切り替えで、フォルダが変わるのはワークスペースが替わるのではなく同じ作業の場所が移るだけ。前の設計（シェルもファイルも無くなったら消える）は、`cd ~` や `exit` で、並べたワークスペースが勝手に消えてサイドバーの並びが動いた。ユーザーが作ったものは、ユーザーが閉じるまで残す。
- **ワークスペースをフォルダから切り離す**（`workspaceId` をパスから作らない）：同じプロジェクトにワークスペースを 2 つ並べたい（別のブランチの作業、別のターミナルの使い方）。フォルダが ID だと 1 つにしかできず、`cd` のたびに ID が変わって帯が消えて増える。
- **フォルダはプライマリターミナルの cwd だけから決める**：どのターミナルの cwd からでも決めると、分割したターミナルで `cd` するたびにワークスペースが動き、`git log` を見に別のフォルダへ寄っただけで開いているファイルが閉じる。プライマリの欄のシェルを指すので、ユーザーに分かりやすい。
- **`cd ~`・`cd /` で切り替えない**：プロジェクトの外へ出ただけでファイルを閉じない。次にプロジェクトに入ったときに切り替わる。
- **`cd` でまとめない**：行き先のフォルダにワークスペースがあっても、勝手に 1 つにしない（ワークスペースは [×] でしか消えず、1 対 1 でもないため。2 つに見えるのは、ユーザーが作ったとおり）。
- **プライマリターミナルと分割したターミナル**：どのワークスペースにも、フォルダを決める 1 つのシェルが必ずある（フォルダ未定でも）。プライマリターミナルの `exit` で欄を閉じないのは、閉じるとフォルダを決めるシェルがいなくなり、右の欄の 1 つ目が空になるため。
- **`protocol.major` を上げる**：`workspaceId` の作り方、`term.create` の形、`workspace.list` の形が変わり、古い GUI は正しく動かないため。
- **`workspace.close_files`・`term.cwd` は消す**：前者は「帯だけ残してファイルを閉じる」ためのもので、ワークスペースが勝手に消えなくなったので要らない。後者は、どのターミナルの cwd でもワークスペースが決まった前の設計のためのもの。
- **マシンの一覧は GUI が持つ**：`kisui serve` はマシンの一覧を知らない（自分のマシンのことしか知らない）。「ローカル」の shj も、足した ssh の先の shj も、同じプロトコルで同じように話す。
- **設定ファイルの間違いで起動しない**：知らない項目を黙って捨てると、`start_dir` のつづりを間違えたときに `~` で始まり、原因が分からない。
- **名前の無いファイルを作らない**：ワークスペースがフォルダ未定にもなるので、名前の無いファイルの保存先が決まらない。
- **core と UI の境目は UI の違いを知らない形にする**：core が TUI 専用の機能（ターミナルのパネル、マルチプレクサ、境目のドラッグ、OSC 52、レイアウトの状態）を持つと、別の UI がそれを空の実装で埋めることになり、core が UI の違いを知ってしまう。UI が増えたり変わったりするたびに core を直すことにもなる。そのため core は Port（「1. 中身と TUI の描画の境目」の「core が知る相手は Port だけ」）だけを知り、TUI 専用のものは tui に出す。Port のメソッドは、どの UI でも同じ意味で、戻り値を待たない形に限る。

## 6. GUI の残りの作業（起票する Issue の一覧）

この文書がマージされたあと、この一覧を Issue にした。1 つが 1 PR の大きさ。親は #271。

#557 で GUI のファイルの欄を外したので、B9・B10・B11 の一部と E の系列（ファイルの欄）、F3（IDE モードとターミナルモード）は、外した印を付けた。GUI はマルチプレクサに絞る方針の Issue は #549〜#557。

**ワークスペースをフォルダから切り離す変更**（「ワークスペース」の節の 1〜18）は、次の Issue で進める（下の表の B7・C5・D1・F1〜F4 は、これらが済んだあとの形で作る）。

| Issue | 中身 | 設計書の番号 |
| --- | --- | --- |
| #446 | 設定ファイルに間違いがあれば起動せず、場所・行・理由を出す | 17 |
| #447 | 名前の無いファイルを作れなくする（`:new` に名前を必須にする） | 18 |
| #448 | shj：ワークスペースをフォルダから切り離し、プライマリターミナルの `cd` でフォルダを切り替える（`workspace.create`・`workspace.close`・`term.restart`、`protocol.major` を上げる） | 1〜7、10、11 |
| #449 | 同じファイルを複数のワークスペースで開いたら、メモリの写しを 1 つにして共有する（#557 で不要になった） | 8 |
| #450 | kisui serve：ワークスペースの一覧を保存し、次に起動したときに戻す | 9 |
| #451 | GUI：「ホストを開く」を「+ マシンを足す」にし、足したマシンだけをサイドバーに出す | 12〜14、16 |
| #452 | GUI：マシンの見出しの [+] でワークスペースを作り、[×] で閉じ、ターミナルをワークスペースごとに出す | 2、7、10、11 |
| #453 | GUI：手元の `config.toml` の `[[gui.machines]]` で既定のマシンを出す | 15 |

### A. `internal/ui` の切り離し

手順 P1〜P14（「2. 分けていく順番」）をそのまま Issue にする（表の 1 行が 1 つの Issue）。

### B. shj のサーバーモード

| ID | タイトル | 依存 | 中身 |
| --- | --- | --- | --- |
| B1 | `rpc`：JSON-RPC の型とメッセージの読み書き | なし | 改行区切りの JSON、要求・通知・応答・エラー、`encoding` の差し替え口、テスト用のパイプ |
| B2 | `kisui serve`：`session.hello` / `bye` / `ping` / `server.info` | B1 | 画面を持たないプロセス、Unix ソケット、版の確認、`serverId` |
| B3 | `kisui attach`：切り離して起動する・つなぎ直す・橋渡し | B2 | `@@shj-rpc 1@@`、`setsid`、`flock`、ソケットへのコピー |
| B4 | 7 日で止まる + `config.toml` の `[server]` | B2 | `lastClientAt`、`idle_stop_days`、`server.shutdown`、未保存の扱い |
| B5 | 引き継ぎ（後からつないだ GUI が勝つ） | B2 | `session.superseded`、`not_owner` |
| B6 | ターミナル管理と `term.*` | B2 | PTY、リングバッファ、`term.ack` の流量制御、`term.attach` |
| B7 | ワークスペースの決定と `workspace.*` | B6 | cwd の取得（Linux / macOS）、フォルダ探し、`workspace.changed`（フォルダの切り離しは #448 で作り直す） |
| B8 | ツリーと git の印：`tree.*`・`git.*` | B7 | 1 階層の一覧、監視、`git.changed`、作成 / 名前変更 / 削除 |
| B9 | （#557 で外した）画面の配信：`view.*`・`screen.*`・`theme.get`・`i18n.get`・`blob.get` | P9、P14、B7 | 購読、差分、`ack`、まとめて送る |
| B10 | （#557 で外した）入力：`input.*`・`command.run`・`file.open` | P5、B9 | `seq`、IME、マウス（ペイン内の座標） |
| B11 | （#557 で外した。`shj diff` などはプライマリの `shj` に届く。#554）制御用ソケットと Claude Code 連携をサーバーモードに載せる | P7d、P7e、B2 | `shj diff` などが動く。`clipboard.write` と `url.open` の通知 |

### C. Tauri アプリの土台

| ID | タイトル | 依存 | 中身 |
| --- | --- | --- | --- |
| C1 | Tauri の雛形、Web 画面のビルド、CI | なし | Linux / macOS でビルド、`nix build` |
| C2 | プロトコルのクライアント（TypeScript） | B1 | 型、要求と応答の対応、通知 |
| C3 | ssh で shj につなぐ | B3、C2 | `ssh` の起動、`~/.ssh/config` のホスト一覧、askpass を GUI で受ける |
| C4 | 自動で再接続、状態の表示 | C3 | 切れたときの再接続、`screen.get`、一覧の状態 |
| C5 | 前回ワークスペースがあったマシンへの自動接続 | C3 | 前回の記録の保存、起動時の接続（足したマシンの一覧は #451。ワークスペースの一覧の保存は shj の側で #450） |
| C6 | リモートに shj を入れる | C3 | 聞く、`uname`、転送、SHA-256、`~/.cache/kisui-terminal/` |
| C7 | 引き継がれたときの表示 | B5、C3 | 「別の GUI に移りました」と、つなぎ直しのボタン |
| C8 | Tauri の updater と配布 | C1 | AppImage、`.dmg`（署名なし）、Nix、nightly の別名、README |

### D. 左の一覧

| ID | タイトル | 依存 | 中身 |
| --- | --- | --- | --- |
| D1 | マシンの見出しとワークスペースの帯 | B7、C3 | 一覧、フォーカス、`workspace.focus` |
| D2 | ツリー（アイコン、縦線、git の印） | B8、D1 | `tree.list`、開閉、フォーカスを外しても覚える |
| D3 | 上下に固定する見出しと帯 | D2 | スクロール中の固定、フォーカス外の帯は下に |
| D4 | マシンごとの色 | D1 | 色の決め方と保存、見出しと帯の左端の線 |

### E. ファイルの欄（#557 で外した）

E1〜E7（画面の状態を描く、キー・IME・マウス・貼り付けを送る、タイトル行・状態行・コマンド行、ポップアップ、診断・行番号の印・インデントガイド、画像・Markdown のプレビュー・差分、ファイルを左右に 2 つ並べる）は、GUI のファイルの欄と一緒に外した。編集はプライマリの欄の中の `shj` が行う。

### F. ターミナル

| ID | タイトル | 依存 | 中身 |
| --- | --- | --- | --- |
| F1 | coneko-term で 1 つ出す | B6、C2 | `term.*`、流量制御、大きさ |
| F2 | ワークスペースの切り替えでターミナルも切り替える | B7、D1、F1 | プライマリターミナルに切り替える（#452 で作り直す） |
| F3 | （#557 で外した）ターミナルモード：カードの入れ替え | F1 | ``Ctrl+Shift+` ``、約 0.3 秒の動き |
| F4 | 欄の分割の木と操作 | F1 | 右・下に分けて入れ子にできる（上限なし）。`Cmd+D`・`Cmd+Shift+D`（Linux は `Ctrl+Shift+D`・`Ctrl+Shift+E`）・矢印、分割したターミナルの `exit` で閉じる（プライマリは閉じない。#452） |

### 進める順番

B1・B2・C1・P1・P2 が最初に始められる。P の系列と B の系列はほぼ独立なので並行できる。F は B6 が済んでから。
