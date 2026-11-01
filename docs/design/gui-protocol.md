# GUI 版の設計：GUI と shj のプロトコル、`internal/ui` の切り離し方

Issue #270 の設計書（親は #271）。決めるのは次の 2 つ。

1. GUI と shj の間のプロトコル（JSON-RPC）。
2. `internal/ui` を「中身」と「TUI の描画」に分ける方法と順番。

この文書は設計だけで、コードは変えない。実装は末尾の一覧を Issue にして進める。画面のデザインは扱わない（ユーザーと決めたモックを使う）。

## 方針（決まっていること）

- GUI の殻は Tauri。画面は Web（WebView）。対応 OS は Linux と macOS。
- 中身の shj は Go のまま。将来 GPU で描くネイティブの画面にするときは、画面を描く部分だけを Rust で作り、shj とはこのプロトコルでつなぐ。だからプロトコルは Web にもネイティブにも使える形にする（ブラウザの API や DOM を前提にしない）。
- 編集の処理は shj がする。GUI は押されたキーやマウスの操作を shj に送り、shj が返す「画面に何を出すか」を描くだけ。Helix 風のキー操作を GUI で作り直さない。
- 「打った文字だけ先に手元で出す」仕組みは今は作らない。ただし後から足せるように、入力と画面更新に番号を振っておく（「4. あとから足せる余地」）。
- 「このマシン」の shj も、リモートと同じプロトコルで話す。
- TUI は今までどおり動き続ける。TUI は中身と同じプロセスで動き、プロトコルを通さず関数を直接呼ぶ。
- ターミナルは「画面に何を出すか」に変換しない。PTY の出力をそのまま GUI（xterm.js）に流し、入力もそのまま PTY に流す。
- GUI を閉じても、リモートの shj とシェルは動き続ける。7 日間（`config.toml` で変更可）どの GUI からもつながらなければ、shj は自分で止まる。
- 2 台の GUI が同じ shj につないだら、あとからつないだほうに引き継ぐ。同時編集は作らない。

## 全体像

```
手元                                      各マシン（「このマシン」も同じ）
┌────────────────────┐                   ┌───────────────────────────────────────┐
│ GUI (Tauri + Web)  │  ssh の標準入出力    │ shj attach ──┐ （ssh が切れたら終わる） │
│  ・画面を描く        │ ◀─── JSON-RPC ───▶ │              ▼ Unix ソケット          │
│  ・キー/マウスを送る  │                   │ shj serve （ssh から切り離して動く）   │
│  ・xterm.js        │                   │  ├ core ×ワークスペース（編集・LSP …） │
└────────────────────┘                   │  ├ ターミナル管理（PTY・cwd の監視）    │
                                          │  └ ツリー・git・ctl・IDE 連携          │
                                          └───────────────────────────────────────┘
TUI:  shj  =  core + TUI の描画  （同じプロセス、関数を直接呼ぶ）
```

- `shj serve`：画面を持たない（headless）常駐プロセス。ユーザーごと・チャンネルごと（nightly は別）に 1 つ。
- `shj attach`：ssh の先で動く小さな橋渡し。標準入出力と `shj serve` の Unix ソケットをつなぐ。ssh が切れると終わるが、`shj serve` は残る。
- ソケットの置き場所は今の制御用ソケットと同じ作り（`$XDG_RUNTIME_DIR/shijimi-<uid>/`、0700。nightly は `shijimi-nightly-<uid>`）。

## 1. 中身と TUI の描画の境目

### 3 つに分ける

| 部品 | 持つもの | 依存してよいもの |
| --- | --- | --- |
| 中身（`core`） | 編集・補完・LSP・差分・検索・エージェントなどの状態。入力を受け取り、「画面に何を出すか」（`Screen`）を作る | `buffer`・`lsp`・`config` など。bubbletea・lipgloss・端末のマス目の幅は使わない |
| TUI の描画 | `Screen` を文字のマス目にして描く。端末の大きさ、ペインの幅、端末の機能（キーを離した通知、カーソルの位置）を持つ | `core`、bubbletea |
| GUI の描画 | プロトコルで受け取った `Screen` を描く | プロトコルだけ（このリポジトリの外：Tauri の Web 画面） |

`internal/screen`（`Screen` のデータ型だけ。外に依存しない）を作る。`core` が作り、TUI の描画とプロトコルが読む。

### 「画面に何を出すか」（`Screen`）のデータの形

要点は次の 5 つ。

1. **意味で伝える。** 色は RGB ではなく「テーマ上の名前」（`syntax.keyword`、`diag.error`、`selection` など）で伝える。名前と色の対応表（テーマ）は別に送る（`theme.get`）。TUI の描画は同じ名前を lipgloss のスタイルにする。
2. **マス目に変換しない。** 行は「文字列 + スタイルの区間」で表す。文字の幅の計算と、字下げの線の引き方は描く側の仕事（ただしマウスの位置のマス目 → rune の位置の変換だけは `core` が行う。「入力」の節）。ただし見える行数と桁数は GUI が送り（`view.resize`）、スクロールや折り返しは shj が決める。等幅フォントで描く前提。
3. **領域（region）ごとに分ける。** TUI は全部を並べて描き、GUI は必要な領域だけ受け取る（左の一覧と右下のターミナルは GUI が自前で作るので、`Screen` の購読に入れない）。
4. **位置は「ペインの中の行と桁」。** 画面全体の座標を持たない。マウスの位置も同じ形で送る。
5. **ローカライズ済みの文字列。** 表示言語は shj の設定で決まるので、文言は shj が組み立てて送る。

```go
// internal/screen（イメージ。名前と細部は実装の PR で決める）
type Screen struct {
    Rev     uint64      // 作るたびに増える。GUI はこれで抜けを見つける
    AckSeq  uint64      // どの入力（Input.Seq）までがこの画面に入っているか
    Focus   Region      // 今キーを受ける領域
    Files   *Files      // ファイルの欄
    Status  Status      // 状態行（モード、メッセージ、ブランチ、診断の数 …）
    Cmdline *Cmdline    // ":" と "/" の入力行。無ければ nil
    Overlay []Overlay   // 補完・ホバー・シグネチャ・確認・パレット・メニュー・レビューカード
    // TUI だけが使う領域。GUI は購読しない
    Explorer *Explorer
    Changes  *Changes
    Agent    *Agent
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
| `root`, `gitTop` | 中身 | `core` のワークスペースのルート。GUI ではワークスペースごとに 1 つの `core` を持つ |
| `cfg` | 中身 | サーバー全体の設定 + ワークスペースの設定を `core` が読む |
| `keymap`, `helix`, `mode`, `pending`, `count`, `lastSearch`, `searchBackward` | 中身 | キー操作の状態。`mode` は状態行の表示用に `Screen.Status` へ出す |
| `lastIns`, `recIns`, `replaying` | 中身 | `.` の繰り返し |
| `caret`, `cellSize` | TUI | 端末への出力と、セルのピクセル数。GUI にはいらない |
| `caretAt` | TUI | 今は描画中に書き戻している。`Pane.Cursors` から TUI が計算する形にする |
| `lsp` | 中身 | `lspManager`。サーバーの返事は `core` のイベントとして受ける |
| `w`, `h` | TUI | GUI は領域ごとの大きさを `view.resize` で送る。`core` は領域ごとの行数と桁数だけ知る |
| `focus` | 中身 | 「キーを受ける領域」は `core` が持つ（`Screen.Focus`）。GUI で押した領域は入力に付けて送る |
| `explorer`, `treeTicks` | 中身 | TUI のツリーの選択・開閉は中身（`Screen.Explorer`）。GUI のツリーは `tree.*` で別に取り、開閉は GUI が持つ |
| `term`, `hd` | どちらでもない | ターミナルはサーバーのターミナル管理（PTY）が持つ。PTY の起動・読み書き・サイズ変更は `internal/term`（`tea`・lipgloss・`vt` を使わない）に出し、TUI は `term.Session` の出力を `vt` に流して描くだけ（`tui.terminal`）。`shj serve` のターミナル管理（`server.termManager`）も起動は `term.Start` を使い、リングバッファと `term.ack` の流量制御は `server` に残す。`hd`（herdr のペイン）と tmux・zellij・cmux のペイン（`mux*.go`）は TUI だけで使う（`core` は知らない） |
| `proxy` | どちらでもない | ポート転送の管理はサーバー側に 1 つ |
| `pal` | 中身 | コマンドパレットの状態（`Overlay` に出す） |
| `wsSyms`, `wsClient` | 中身 | プロジェクトのシンボル選択 |
| `search` | 中身 | 検索パネルの状態 |
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
| `ide`, `props`, `lastSel`, `sentSel` | 中身 + どちらでもない | `ide.Server` はサーバー側に 1 つ（`core` の外。`cli` が作って渡す）。提案（`props` = `core.Proposals`）と選択範囲の通知（`lastSel`, `sentSel` = `core.SelectionTracker`）、ツール一覧（`core.IDETools`）は `core`。提案のスクロールは TUI |
| `ag`, `sg` | 中身 | ACP のエージェントと提案パネル。`Screen.Agent` に出す |
| `clipboard` | 中身 | 内部のレジスタ。OS のクリップボードは GUI 側（`clipboard.write` 通知と `input.paste`） |
| `msg`, `msgErr` | 中身 | 状態行のメッセージ。`Screen.Status` に出す |
| `follow` | 中身 | カーソルが見えるようにスクロールする印。`Viewport` を決めるときに使う |
| `dragging` | 中身 | マウスのドラッグ（選択）の状態 |
| `lastClick` | 中身 | ダブルクリックの判定。GUI は `clicks` を付けて送る。TUI は今の判定を残す |
| `keyReleases`, `askReleases` | TUI | 端末が「キーを離した」を報告するか。GUI は最初から押す / 離すを送れる |
| `quitting` | TUI | `tea.Quit` を返した印。`core` は「終了してよい」という効果（`Quit`）を返す |
| `hold`, `holdSeq` | 中身 | 押しっぱなしのスクロール。タイマーは `core` のイベントにする |
| `lineFlip` | 中身 | 行番号の反転表示 |
| `single` | 中身 | 単体編集モード（1 ファイルだけ開き、閉じたら終了） |
| `tabSpans`, `tabOffset` | TUI | 描画中に書き戻している値で、マウスの当たり判定に使う。#262 でタブバーごと無くなる。残る間は、TUI の描画が「描いた結果」として持ち、`core` は持たない |
| `commands` | 中身 | `:` コマンドの表 |
| `mermaid`, `mdImages`, `previewGen` | 中身 | プレビューの画像の生成。画像の実体は `Pane.Image` + `blob.get` |

`tab` 構造体のうち、`img`（`imageView`）は中身（画像を読む）と TUI（ハーフブロック / Kitty で描く）が混ざっているので分ける。`prevCache`・`prevW` は「プレビューを何桁で作ったか」のキャッシュで、桁数は領域の大きさから来る。

### 描画中の書き戻しをなくす

`render` / `renderTabs` / `renderStatus` は描きながら状態を書き戻している（`tabSpans`、`tabOffset`、`caretAt`）。`Screen` を作るのは状態を変えない関数（`core.Screen()`）にして、描く側が必要な計算（タブの位置、カーソルの端末上の座標）を自分で持つ。これを最初のほうの手順にする。

P13-07（#383）では、ファイルを「描く」「中身」に仕分けた。lipgloss を import するのは `split_test.go` の名簿のファイル（`*_draw.go` ほか）だけ、`layout`（ペインのマス目）を使うのは `layout.go` ほかの描く・画面のマス目を扱うファイルだけで、`core` に行くファイルは `editRows`・`textCols`（`layout.go`）のように領域の行数・桁数で尋ねる。どちらも `internal/tui/split_test.go` が見張る。

P13-08（#384）では、マウスの当たり判定（`handleMouse`・`termMouse`・ホバーと検索パネルの画面のマス目の判定。`internal/tui/mouse.go`）と枠の大きさの調整（`resize.go`）を `layout` を使う tui のファイルに寄せ、`core` に行くファイルは `layout` を一切使わない。`renderFrame` は `App` のフィールドを名前で読まず、`internal/tui/frameq.go` の問い合わせ（`focusIn`・`diffMode`・`completing` …。`App` を割ったあとの `core.Screen()` と `core` の問い合わせのメソッドになる）だけを読む。見張るのは `split_test.go`（`TestRenderFrameReadsQueries`）。

次に `App` を `Core`（中身。`internal/tui/app.go` の `type Core struct`）と `App`（`*Core` を埋め込み、端末だけのフィールドを持つ）に分けた。`App` に残すのは上の表で「TUI」の行のフィールド（画面の大きさ、出す領域、ペインの大きさ、端末、キーを離した報告）。`core` に行くファイルはそのフィールドを読まず、`internal/tui/frontend.go` の問い合わせ（`screenW`・`sideShown`・`setSide`・`termShown`・`termRun` …。`App` を割ったあとは `core` が前面に尋ねる呼び出しになる）を通す。`TestCoreFields` が `Core` にそのフィールドが入らないことと、`frontend.go` などの tui に残るファイル以外が読まないことを見張る。

中身のファイルのメソッドは `*Core` に付け替えた。`Core` は前面（`App`）を `frontEnd`（`frontend.go`）として持ち、端末に尋ねることはそれを通す。中身のファイルに `*App` のメソッドは残っていない（`Init`・`Update` は `model.go`、描くものは `*_draw.go`）。`TestCoreMethods` が増えないことを見張る。`Core` を `internal/core` に移すのが残りで、`mdparse.go`（Markdown の字句）から移し始めた（#384 の (3)）。

色は `theme.go`（`Theme` の値だけ。`app.go` に依存しない）と `theme_apply.go`・`styles.go`（lipgloss のスタイルを作る）に割った。`Core` が選ぶのは `Theme` で、スタイルへの反映は前面の `setPalette` が行う（`TestThemeApplyIsFrontEnd` が見張る）。

`styles.go` は lipgloss のスタイル（`bgfg`・`st*`）だけにし、色の値（`c*`）は `colors.go`、セルに合わせる関数（`fit`・`overlay`・`clamp`）は `cells.go` に分けた。tui のファイルが `Core` のフィールドを読まず `coreq.go`・`ptrq.go`・`fitq.go` のメソッドで尋ねる形は `TestFrontEndAsksCore` が、core 行きのファイルが `styles.go` のスタイルで描くのは `TestStylesStayInTui`（`styleCoreTodo` に残りを並べた）が見張る。

## 2. 分けていく順番

どの手順も 1 つが 1 つの PR になる大きさにする。手順の最後で `go test ./...` が通り、TUI の見た目と操作が変わらないこと。

#262（タブバーを消す）が先に入ると、`tabSpans`・`tabOffset` の扱いが変わる。P3 はそれを見てから始める。

| # | 手順 | 依存 |
| --- | --- | --- |
| P1 | TUI の描画を固定するテストを足す。代表的な状態（ファイルを開いた、補完、差分モード、確認の窓、ホバー、検索）で `render()` の出力を保存して比べる。テストだけ | なし |
| P2 | `internal/screen` を作る。`Screen`・`Pane`・`Line`・`Span`・`Style`（意味の名前）・`Overlay` を定義し、テーマの名前 → 色の対応を決める。使うコードはまだ無い | なし |
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
| P12 | エクスプローラ・変更一覧・エージェントのパネルを `Screen` で作る（TUI だけが使う） | P8 |
| P13 | `core` パッケージへ移す。`App` は `core` を持って、`Input` ↔ `tea` と `Screen` ↔ 描画をつなぐだけの薄い bubbletea の Model になる。`internal/ui` を `internal/tui` に改名する | P7a〜P7e、P9、P10a〜P10h、P11a〜P11c、P12 |
| P14 | `core` が複数のワークスペースを持てるようにする（ワークスペースごとに `core` を 1 つ。TUI は今までどおり 1 つだけ作る） | P13 |

- P8〜P12（P10a〜h、P11a〜c を含む）は、`Screen` を作る関数と TUI の描画関数を同じ PR で対にして変える。`Screen` を作るだけで使われない状態にしない。
- 途中は、`App` が `core` の「まだ分けていない部分」を直接持っていてよい。分けた領域の分だけ、`render` が `Screen` を通る。
- P6 とその後の P7a〜P7e が一番大きい。1 つの PR で全部をやらず、サブシステムごとに行う。

## 3. プロトコル

### 土台

- **JSON-RPC 2.0**。要求（`id` あり）・通知（`id` なし）・応答・エラーの形は標準どおり。
- **ssh の標準入出力の上**で送る。標準入力が GUI → shj、標準出力が shj → GUI。標準エラー出力はログ用で、プロトコルに混ぜない。
- **分け方（framing）**：最初は「1 行 1 メッセージ」の JSON（改行区切り。JSON の文字列の中の改行は `\n` にエスケープされるので衝突しない。ACP と制御用ソケットと同じ作り）。`session.hello` で `encoding` を決めるので、あとで MessagePack（長さ付き）に変えられる。メソッドとパラメータの形は変えない。
- **始まりの目印**：ssh で入ると、ログインシェルが標準出力に何か出すことがある（motd など）。`shj attach` は最初に 1 行 `@@shj-rpc 1@@` を出す。GUI はこの行より前を捨てる。
- **名前**：`領域.動作`（`session.hello`、`input.key`）。**向き**は「→ shj」（GUI から）と「← GUI」（shj から）で書く。
- **番号**：GUI は入力ごとに `seq`（増える整数）を付ける。`Screen.AckSeq` で「ここまで反映した」と返る。
- **エラー**：標準のコードに加えて次を使う。

| コード | 名前 | 意味 |
| --- | --- | --- |
| -32001 | `incompatible_protocol` | プロトコルの major が合わない |
| -32002 | `not_owner` | 引き継がれたあとの古い GUI が要求した |
| -32003 | `not_found` | ワークスペース・ターミナル・ファイルが無い |
| -32004 | `denied` | 権限が無い、またはワークスペースの外 |
| -32005 | `busy` | 上限を超えた、またはターミナルが動いている |

### つなぐ・引き継ぐ・切れる

| メソッド | 向き | パラメータ → 結果 |
| --- | --- | --- |
| `session.hello` | → shj | `{protocol: {major, minor}, client: {name, version, kind: "web"\|"native"}, encoding: ["json", "msgpack"], resume?: {serverId, rev}}` → `{protocol, encoding, shj: {version, commit, channel}, serverId, startedAt, supersedes?: {client, connectedAt}, capabilities: [...], workspaces: [...], rev}` |
| `session.bye` | → shj | `{}` → `{}`。GUI を閉じるとき。shj とシェルは止めない |
| `session.superseded` | ← GUI | 通知 `{by: {client, connectedAt}}`。後からつないだ GUI に引き継がれたとき、前の GUI に送ったあと接続を閉じる。GUI は「別の GUI に移りました」と出す |
| `session.ping` | → shj | `{}` → `{}`。生きているかの確認（GUI が 15 秒ごと。ssh が黙って切れたときに気づく） |
| `server.info` | → shj | `{}` → `{shj, serverId, pid, uptime, lastClientAt, idleStopAt, workspaces: n, terminals: n}` |
| `server.shutdown` | → shj | `{force?: bool}` → `{terminals: n}`。ターミナルが動いていると `force` が無い限り `busy` で断る。GUI は確認を出してから送る |

- **バージョンの確認**：`protocol.major` が合わないと `incompatible_protocol`。`protocol.minor` は上がっても互換（足されるだけ）。知らない通知は無視し、知らないメソッドは `-32601`。新しい機能は `capabilities` の文字列で見分ける。
- **shj と GUI の版が違うとき**：GUI は `shj.version` を自分の版と比べる。違えば「古い shj が動いています」と出し、ユーザーが決めたときだけ `server.shutdown` で入れ替える（動いているシェルが消えるため、自動ではやらない）。
- **引き継ぎ**：サーバーが受けつける GUI は常に 1 台。2 台目の `session.hello` が来たら、1 台目に `session.superseded` を送って閉じ、2 台目に引き継ぐ。1 台目が出した返事前の要求は捨てる。閉じ損ねた 1 台目からの要求は `not_owner`。
- **切れる**：標準入出力が閉じたら、GUI がいなくなったとみなす。状態（ファイル、`core`、ターミナル）は残り、`lastClientAt` を覚える。
- **つなぎ直す**：新しい `session.hello` で `resume: {serverId, rev}` を送る。同じ `serverId` なら状態が残っているので、`screen.get` で全部取り直して続けられる。`serverId` が違えば shj が作り直されたので、GUI はワークスペースの一覧から取り直す。
- **止まる**：`lastClientAt` から 7 日（`config.toml` の `[server] idle_stop_days`、0 で止まらない）つながらなければ、`shj serve` は終わる。つながっている間は止まらない。ターミナルでシェルが動いていても止まる（そのシェルは SIGHUP で終わる）。止まる前（7 日で止まるとき・`server.shutdown` のとき）の未保存の変更は、元のファイルの隣の `<ファイル名>.bk` に書いてから止まる（同じ名前があれば上書きせず `.bk.1` のように番号を付ける。元のファイルは書き換えない）。実装（B4）は `server.WriteBackup` と、止まる直前に一度だけ走る `Server.AddBeforeStop`。次に開いたときに `.bk` を知らせる仕組みは作らない。`[server] idle_stop_days` は `~/.config/shijimi-editor/config.toml` だけで有効。

### 画面（`Screen`）の送り方

**決め方：変わった分だけ送る。** 領域ごとに版（`rev`）を持ち、ファイルの欄の行は「変わった行だけ」を送る。理由：1 文字打つと変わるのは 1 行と状態行ぐらいで、毎回全部を送ると回線の遅いときに目に見えて遅くなる。スクロールでは全行が変わるが、1 画面分（高々 100 行ほど）なので許せる。

| メソッド | 向き | パラメータ → 結果 |
| --- | --- | --- |
| `view.subscribe` | → shj | `{regions: ["files", "status", "cmdline", "overlay"]}` → `{}`。受け取る領域を選ぶ（GUI は `explorer` などを選ばない） |
| `view.resize` | → shj | `{regions: {"files": {cols, rows}, "status": {cols}, "cmdline": {cols}, "overlay": {cols, rows}}}` → `{}`。領域ごとの桁数と行数（等幅のマス目で数える）。ペインの大きさ（2 つ並べるときの割り方）は shj が `files` の中で決める。ペインができる前でも送れる。変えると画面が送り直される |
| `screen.get` | → shj | `{}` → `Screen`（全部）。つなぎ直し、抜けの回復用 |
| `screen.update` | ← GUI | 通知 `{rev, baseRev, ackSeq, focus?, files?: {panes: [{id, kind?, title?, viewport?, lines?: {rows: {"0": Line, "5": Line}, count}, cursors?, selections?}], active?}, status?, cmdline?, overlay?}`。付いている項目だけが変わった。`lines.rows` のキーは「ビューポートの中で上から何行目か」（0 始まり。バッファの行番号は `Line.No`）で、`count` は見えている行数。スクロールするとキーの意味する行が全部変わるので、全行を送る。`baseRev` が GUI の持つ版と合わなければ GUI は `screen.get` する |
| `screen.ack` | → shj | 通知 `{rev}`。GUI が描き終えた版。shj は返事の来ていない更新を 1 つまでしか溜めず、間の変化は 1 つにまとめて送る（遅い回線で更新が積み上がらないように） |
| `theme.get` | → shj | `{}` → `{name, tokens: {"syntax.keyword": {fg, bg?, bold?, italic?, underline?}}}`。テーマが変わると `theme.changed` 通知（同じ形） |
| `blob.get` | → shj | `{id, offset?, length?}` → `{mime, size, data (base64), eof}`。画像・プレビュー用の画像は `Screen` に埋め込まず `ImageRef{id, mime, w, h}` で持たせ、これで取る。大きい画像は分けて取る |

- 画面の更新は、入力やその他のイベント（LSP の返事、タイマー）を処理したあとに作る。作るのはフォーカスしているワークスペースの分だけ。

### キー・マウス・貼り付けの入力

入力は要求にする（応答は「受け付けたこと」と、反映後の版を返す）。サーバーは受け取った順に処理する。

| メソッド | 向き | パラメータ → 結果 |
| --- | --- | --- |
| `input.key` | → shj | `{seq, region, key, mods: ["ctrl","shift","alt","super"], text?, phase: "press"\|"repeat"\|"release"}` → `{rev}`。`key` は W3C の `KeyboardEvent.key` の名前（`"a"`、`"Enter"`、`"ArrowLeft"` …）。`text` は入力される文字（IME 確定後も） |
| `input.composition` | → shj | `{seq, region, text, cursor: [start, end]\|null}` → `{rev}`。IME の変換中。`null` で終わり。変換中の文字は `Pane` の中に「下線付きで」出る |
| `input.mouse` | → shj | `{seq, region, pane?, kind: "down"\|"up"\|"move"\|"wheel", button?, clicks?, row, col, dx?, dy?, mods}` → `{rev}`。`row`・`col` はペインの中のマス目。マス目 → rune の位置の変換（全角・結合文字）は `core` がその行の文字から行う（GUI は幅の計算を持たない）。この変換は P8 で確かめる事項に含める。`clicks` は GUI がダブルクリック等を数えて送る。`wheel` は `dy` が行数 |
| `input.paste` | → shj | `{seq, region, text}` → `{rev}`。貼り付け（ブラケットペーストと同じ扱い） |
| `input.focus` | → shj | `{seq, region}` → `{rev}`。GUI で別の領域を押してフォーカスを移した |
| `command.run` | → shj | `{seq, line}` → `{ok, message}`。`:` コマンドを実行（制御用ソケットの `exec` と同じ） |
| `file.open` | → shj | `{seq, workspaceId, path, line?, col?, pane?}` → `{rev}`。ツリーで押したファイルを開く |

- Helix のキーは GUI で解釈しない。`key` は押されたキーと修飾キーをそのまま送る。`Ctrl+Shift+T` のような GUI 自身が受けるキー（ターミナルを新しく作る、IDE モードとターミナルモードの切り替え）は GUI が処理して送らない。
- `region` は `"files"`、`"cmdline"` など。GUI は押された場所の領域名を付ける。
- 受け取ったあとの動作は TUI と同じ（`core` の `Input` を処理する）。

### shj から GUI への通知（その他）

| メソッド | 向き | パラメータ |
| --- | --- | --- |
| `clipboard.write` | ← GUI | `{text}`。コピーしたとき、GUI 側の OS のクリップボードに入れる（TUI では OSC 52） |
| `url.open` | ← GUI | `{url}`。`:open-url` など。GUI 側のブラウザで開く |
| `notify` | ← GUI | `{level, text}`。画面に出さない通知（接続のログなど） |

### ターミナル

`Screen` には変換しない。PTY の出力をそのまま流す。ターミナルは**サーバー全体で持ち**（ワークスペースの `core` には属さない）、どのワークスペースに属するかは cwd から決まる（次の節）。

| メソッド | 向き | パラメータ → 結果 |
| --- | --- | --- |
| `term.create` | → shj | `{cwd?, cols, rows, shell?, env?}` → `{termId, pid, cwd}`。`cwd` が無ければフォーカスしているワークスペースのルート、それも無ければ `~`。`shell` が無ければ今の設定どおり |
| `term.list` | → shj | `{}` → `{terms: [{termId, pid, cwd, workspaceId, title, cols, rows, alive}]}` |
| `term.attach` | → shj | `{termId, fromSeq?}` → `{seq, replay (base64), cols, rows}`。つなぎ直したとき、溜めておいた出力（1 ターミナルにつき最大 1 MiB のリングバッファ）を取り直す。`fromSeq` より前が捨てられていれば、残っている分だけ返す |
| `term.close` | → shj | `{termId}` → `{}`。シェルに SIGHUP を送る |
| `term.resize` | → shj | `{termId, cols, rows}` → `{}` |
| `term.input` | → shj | `{termId, data (base64)}` → `{}`。xterm.js が作ったバイト列をそのまま PTY に書く |
| `term.output` | ← GUI | 通知 `{termId, seq, data (base64)}`。PTY の出力。`seq` はバイト数の累計 |
| `term.ack` | → shj | 通知 `{termId, seq}`。GUI が処理したバイト数。shj は `seq` から 256 KiB より先までは送らない。このとき PTY は読み続けてリングバッファに溜め、溢れた分は捨てる（GUI が止まってもシェルは止めない。捨てた分は `term.attach` で取り直す）（`yes` のような大量の出力で回線と WebView が詰まらないように） |
| `term.exit` | ← GUI | 通知 `{termId, code, signal?}`。シェルが終わった。送り残した `term.output` より先に届くことがある（GUI は `term.exit` のあとも `term.attach` で残りを取る）。溢れて捨てられた分は `term.output` の `seq` が飛んで届くので、欠けは `seq` の連続性で分かる |
| `term.title` | ← GUI | 通知 `{termId, title}` |

- JSON では base64 にするので出力が約 1.33 倍になる。MessagePack に変えれば生のバイト列で送れる。「速さが足りなければ MessagePack に」が一番効くのはここ。
- ターミナルの中身を読む `internal/vt` は TUI だけで使う。GUI ではサーバーは PTY のバイト列を中継するだけで、エミュレートしない。コマンドの終了を知らせる印（`command-end`、`shellint`）は、サーバーでは取り出さない（B6 で確かめた）。バイト列は xterm.js にそのまま届くので、印が要る機能は GUI の側（xterm.js の OSC ハンドラ）で拾う。サーバーが出力から読むのはタイトル（OSC 0 / 2）だけ。

### ワークスペース

**ワークスペースはターミナルのシェルの今いるフォルダから決める。** 「開く」操作は無い。

決め方（shj が行う）：

1. ターミナルのシェルのプロセスの cwd を OS から読む（Linux は `/proc/<pid>/cwd`、macOS は `proc_pidinfo` の `PROC_PIDVNODEPATHINFO`）。フォアグラウンドのジョブの cwd ではなく、シェルの pid の cwd を使う。
2. cwd から親へたどり、最初に `.git`（フォルダでもファイルでもよい。git worktree は `.git` ファイル）か `.shijimi-editor/` があるフォルダをルートにする。
3. 目印が無ければ cwd そのものをルートにする。
4. ただし cwd が `~` か `/` そのものなら、ワークスペースにしない（`workspaceId` は `null`）。たどる途中で `~` や `/` に着いても、そこはルートにしない。
5. 読むのは 1 秒に 1 回。変化があったターミナルだけ通知する。（OSC 7 などシェルからの通知を足すのは、1 秒の遅れが気になってからにする）

ワークスペースは、シェルがそこにいる間、またはそこでファイルを開いている間は残る。どちらも無くなったら無くなる。同じルートに複数のターミナルがいれば 1 つにまとめる。`workspaceId` はルートのパスを正規化した文字列から作る。

| メソッド | 向き | パラメータ → 結果 |
| --- | --- | --- |
| `workspace.list` | → shj | `{}` → `{workspaces: [{id, root, kind: "git"\|"shijimi"\|"cwd", name, branch?, terms: [termId], files: [path]}], focus}` |
| `workspace.changed` | ← GUI | 通知 `{added?: [Workspace], removed?: [id], updated?: [Workspace]}`。ワークスペースが増えた / 減った / 中身（ターミナルの所属、ブランチ、開いているファイル）が変わった |
| `term.cwd` | ← GUI | 通知 `{termId, cwd, workspaceId\|null}`。ターミナルの今いるフォルダが変わった |
| `workspace.focus` | → shj | `{id}` → `{rev, termId?}`。フォーカスを移す。画面（`Screen`）はそのワークスペースの `core` のものに切り替わる。`termId` はそのワークスペースで最後に使ったターミナル |
| `workspace.close_files` | → shj | `{id}` → `{}`。そのワークスペースの開いているファイルを全部閉じる（帯だけ残す） |

- `workspace.focus` を境に、`input.*` と `screen.update` の宛先が変わる。`rev` はサーバー全体で 1 つの数にする（ワークスペースを移しても増え続ける）。
- ファイルは、ワークスペースごとに `core` が覚える。フォーカスを外しても `core` は残る（外したワークスペースの LSP を止めるかは、P14 のあとで測って決める）。

### ファイルのツリー

GUI は複数のワークスペースのツリーを（開閉の状態を持って）並べるので、`core` の `Explorer`（TUI の 1 つの木）とは別に、状態を持たない取得の API にする。開閉とスクロールの位置は GUI が持つ。

| メソッド | 向き | パラメータ → 結果 |
| --- | --- | --- |
| `tree.list` | → shj | `{workspaceId, path ("" = ルート)}` → `{entries: [{name, kind: "file"\|"dir"\|"symlink", target?, size?, git?: "M"\|"A"\|"D"\|"R"\|"?"\|"!"\|"U", gitChildren?: bool}], truncated?, rev}`（`rev` はツリー専用の版。`Screen.Rev` とは別で、`tree.changed` のあとの取り直しで古い返事を捨てるのに使う）。1 階層だけ（フォルダを開いたときに取る）。`.gitignore` で無視されているものは `git: "!"`。順番は TUI のツリーと同じ（フォルダが先）。5000 件で切る |
| `tree.watch` | → shj | `{workspaceId, paths: [...]}` → `{}`。GUI が開いているフォルダを教える。サーバーはそこだけ監視する（`watch.go` と同じ仕組み） |
| `tree.changed` | ← GUI | 通知 `{workspaceId, paths: [...], rev}`（`rev` は `tree.list` と同じ版。これより古い `tree.list` の返事は捨てる）。そのフォルダの中身が変わった。GUI は `tree.list` を取り直す |
| `git.status` | → shj | `{workspaceId}` → `{branch, ahead?, behind?, marks: {"path": "M"}, rev}`（`rev` は git 専用の版。`Screen.Rev` とは別で、`git.changed` との前後の判定に使う）。全体の印。フォルダの印は `gitChildren` を使って GUI が求める |
| `git.changed` | ← GUI | 通知 `{workspaceId, branch?, marks?: {"path": "M"\|null}, rev}`（`rev` は `git.status` と同じ版）。変わった分だけ（`null` は印が消えた） |
| `tree.create` | → shj | `{workspaceId, path, kind: "file"\|"dir"}` → `{}` |
| `tree.rename` | → shj | `{workspaceId, from, to}` → `{}` |
| `tree.delete` | → shj | `{workspaceId, path}` → `{}`。GUI が確認してから送る（TUI の `yesNo` と同じ流れ） |

- パスはワークスペースのルートからの相対パス（`/` 区切り）。ルートの外へ出る（`..`、ルートの外を指すシンボリックリンクの先）パスは `denied`。
- ファイル名が UTF-8 でないときは、`name` の不正な部分を `�` に置き換え、元のバイト列を `nameRaw`（base64）で足す。
- 印の文字：`M` 変更、`A` 追加、`D` 削除、`R` 名前変更、`?` 追跡していない、`U` 衝突（マージ中）、`!` `.gitignore` で無視。`.git` は一覧に出さず、`tree.create` / `tree.rename` / `tree.delete` でも触れない（`denied`）。

### ssh 越しに shj を起動する

GUI はシステムの `ssh` を子プロセスとして起動する（`~/.ssh/config` と ssh-agent をそのまま使うため）。ssh がパスワードや 2 段階認証を求めるときは `SSH_ASKPASS` で GUI の窓に出す。

1. **shj の場所**：`~/.cache/shijimi-editor/<GUI の版>/shj`。無ければ、ユーザーに聞いてから GUI が転送する。PATH の `shj` には触らない。リモートの OS とアーキテクチャは `uname -sm` で調べ、合う実行ファイルを GitHub Releases から GUI が取って送る。送ったあと、GitHub Releases の checksums にある SHA-256 と、取得した実行ファイルを比べる（取得の段階の確認）。リモートに置いたファイルも同じ値かを確かめる（転送の壊れの確認）。
2. **つなぐ**：`ssh -T host -- ~/.cache/shijimi-editor/<版>/shj attach`（`-T` は端末を割り当てない）。ユーザーの `ssh_config`（`ControlMaster` など）はそのまま効く。
3. **`shj attach` がすること**（リモートで動く橋渡し）：
   1. 標準出力に `@@shj-rpc 1@@` を出す。
   2. ソケットのフォルダを見て、`shj serve` が動いていれば、その Unix ソケットにつなぐ。**すでに動いている shj につなぎ直す方法はこれ。** ssh のたびに新しい shj は起動しない。
   3. 動いていなければ、`shj serve` を切り離して起動する（`setsid`。標準入出力は閉じ、ログはファイルへ）。ソケットができるまで（最大 5 秒）待ってつなぐ。2 台の GUI が同時に起動しても 1 つになるよう、ソケットのフォルダの中のロックファイル（`flock`）を使う。
   4. 標準入出力とソケットの間を、バイトのままコピーする（プロトコルは解釈しない）。どちらかが閉じたら終わる。
4. **「このマシン」**：`ssh` を挟まず、GUI が同じ `shj attach` を直接起動する。
5. **版が違う shj が動いていたら**：`session.hello` の結果で GUI が気づく（前の節）。`attach` は版が違っても動いているサーバーにつなぐ（勝手に入れ替えない）。

セキュリティ：Unix ソケットは 0700 のフォルダの中（自分のユーザーだけ）。`shj serve` はネットワークに待ち受けない。リモートの認証は ssh に任せる。`shj attach` の段階で追加の認証はしない（同じユーザーなら元々シェルを開ける）。

### サーバーモード（`shj serve`）の中身

- `core` をワークスペースごとに持つ（P14 以降）。制御用ソケット（`ctl`）と Claude Code 連携（`ide`）は今と同じようにサーバーに 1 つ持つ。`shj diff` などの CLI は、フォーカスしているワークスペースの `core` に届ける。
- 実装（B11）：`server.Workspace`（`Control` と `IDE`）を実装した `core` を `SetFocus` するとそこへ届く。フォーカスが無いうちは `ctl` も `ide` もエラーを返す。制御用ソケットは TUI と同じ `<pid>.sock` で、`shj serve` が開くターミナルには `SHIJIMI_SOCKET` などの環境変数を渡す。Claude Code のロックファイルのワークスペースはホームディレクトリ。`clipboard.write` と `url.open` は `Server.WriteClipboard` / `OpenURL`（`ui.Host`）が今の GUI に通知する。
- ログは `$XDG_STATE_HOME/shijimi-editor/serve.log`（無ければ `~/.local/state/…`）。サイズが 10 MiB を超えたら先頭を捨てる。

## 4. あとから足せる余地

- **打った文字だけ先に手元で出す**：`input.*` の `seq` と `Screen.AckSeq` があるので、GUI が「文字を入れた行」を手元で先に描き、`AckSeq` が追いついたら shj の画面に置き換える形にできる。必要になったら `Line` に版を足す。今は作らない。
- **速さが足りないとき**：`encoding` を `msgpack` にする。効くのは `term.output`（base64 が無くなる）、次に `screen.update`。
- **ネイティブの画面**：プロトコルは領域と等幅のマス目の単位で話すので、Rust の画面も同じ `Screen` を描ける。`Style` は意味の名前なので、色はテーマで決まる。
- **新しいメソッド**は `capabilities` で見分ける。メソッドの意味を変えるときは `protocol.major` を上げる。

## 5. 決めたことと理由

- **変わった分だけ送る**（領域ごとの版 + 行単位の差分 + `screen.get`）：回線が遅くても使えるため。全部送る形にも、`lines.rows` に全部の行を入れれば同じ形のまま退化できる。逆（全部送る形から差分への移行）は形が変わる。
- **`Screen` は意味の名前でスタイルを伝える**：テーマの変更に GUI が追従でき、TUI と GUI の見た目の差を描く側に閉じ込められる。
- **ターミナルは `Screen` に入れない**：`internal/vt` を GUI に持ち込まず、xterm.js の機能をそのまま使える。
- **ワークスペースごとに `core` を持つ**：「開いたファイルはワークスペースごとに覚える」を、状態の切り替えではなくインスタンスを分けることで満たす。メモリは増えるが、ワークスペース数は少ない。
- **ツリーは `Screen` と別の API**：GUI は複数のワークスペースのツリーを同時に持ち、開閉は GUI の状態だから。
- **`shj attach` と `shj serve` を分ける**：ssh が切れても状態を残し、つなぎ直しを同じ流れ（`attach` を再実行）にするため。
- **framing は改行区切りの JSON**：ssh の標準入出力に載せやすく、ACP・制御用ソケットと同じ。MessagePack にするときは長さ付きにする。
- **版が違う shj を勝手に入れ替えない**：動いているシェルが消えるため。
- **ワークスペースの消え方**：シェルがいなくなり、開いているファイルも無いとき。ファイルを開いたままワークスペースが消えるのを避けた。

## 6. GUI の残りの作業（起票する Issue の一覧）

この文書がマージされたあと、この一覧を Issue にする。1 つが 1 PR の大きさ。親は #271。

### A. `internal/ui` の切り離し

手順 P1〜P14（「2. 分けていく順番」）をそのまま Issue にする（表の 1 行が 1 つの Issue）。

### B. shj のサーバーモード

| ID | タイトル | 依存 | 中身 |
| --- | --- | --- | --- |
| B1 | `internal/rpc`：JSON-RPC の型とメッセージの読み書き | なし | 改行区切りの JSON、要求・通知・応答・エラー、`encoding` の差し替え口、テスト用のパイプ |
| B2 | `shj serve`：`session.hello` / `bye` / `ping` / `server.info` | B1 | 画面を持たないプロセス、Unix ソケット、版の確認、`serverId` |
| B3 | `shj attach`：切り離して起動する・つなぎ直す・橋渡し | B2 | `@@shj-rpc 1@@`、`setsid`、`flock`、ソケットへのコピー |
| B4 | 7 日で止まる + `config.toml` の `[server]` | B2 | `lastClientAt`、`idle_stop_days`、`server.shutdown`、未保存の扱い |
| B5 | 引き継ぎ（後からつないだ GUI が勝つ） | B2 | `session.superseded`、`not_owner` |
| B6 | ターミナル管理と `term.*` | B2 | PTY、リングバッファ、`term.ack` の流量制御、`term.attach` |
| B7 | ワークスペースの決定と `workspace.*` | B6 | cwd の取得（Linux / macOS）、ルート探し、`workspace.changed` |
| B8 | ツリーと git の印：`tree.*`・`git.*` | B7 | 1 階層の一覧、監視、`git.changed`、作成 / 名前変更 / 削除 |
| B9 | 画面の配信：`view.*`・`screen.*`・`theme.get`・`blob.get` | P9、P14、B7 | 購読、差分、`ack`、まとめて送る |
| B10 | 入力：`input.*`・`command.run`・`file.open` | P5、B9 | `seq`、IME、マウス（ペイン内の座標） |
| B11 | 制御用ソケットと Claude Code 連携をサーバーモードに載せる | P7d、P7e、B2 | `shj diff` などが動く。`clipboard.write` と `url.open` の通知 |

### C. Tauri アプリの土台

| ID | タイトル | 依存 | 中身 |
| --- | --- | --- | --- |
| C1 | Tauri の雛形、Web 画面のビルド、CI | なし | Linux / macOS でビルド、`nix build` |
| C2 | プロトコルのクライアント（TypeScript） | B1 | 型、要求と応答の対応、通知 |
| C3 | ssh で shj につなぐ | B3、C2 | `ssh` の起動、`~/.ssh/config` のホスト一覧、askpass を GUI で受ける |
| C4 | 自動で再接続、状態の表示 | C3 | 切れたときの再接続、`screen.get`、一覧の状態 |
| C5 | 前回ワークスペースがあったマシンへの自動接続 | C3 | 前回の記録の保存、起動時の接続 |
| C6 | リモートに shj を入れる | C3 | 聞く、`uname`、転送、SHA-256、`~/.cache/shijimi-editor/` |
| C7 | 引き継がれたときの表示 | B5、C3 | 「別の GUI に移りました」と、つなぎ直しのボタン |
| C8 | Tauri の updater と配布 | C1 | AppImage、`.dmg`（署名なし）、Nix、nightly の別名、README |

### D. 左の一覧

| ID | タイトル | 依存 | 中身 |
| --- | --- | --- | --- |
| D1 | マシンの見出しとワークスペースの帯 | B7、C3 | 一覧、フォーカス、`workspace.focus` |
| D2 | ツリー（アイコン、縦線、git の印） | B8、D1 | `tree.list`、開閉、フォーカスを外しても覚える |
| D3 | 上下に固定する見出しと帯 | D2 | スクロール中の固定、フォーカス外の帯は下に |
| D4 | マシンごとの色 | D1 | 色の決め方と保存、見出しと帯の左端の線 |

### E. ファイルの欄

| ID | タイトル | 依存 | 中身 |
| --- | --- | --- | --- |
| E1 | 画面の状態を描く：テキスト、カーソル、選択 | B9、C2 | 行とスタイル、テーマ、差分の反映 |
| E2 | キー・IME・マウス・貼り付けを送る | B10、E1 | `KeyboardEvent` の変換、IME の変換中の表示 |
| E3 | タイトル行・状態行・コマンド行 | E1 | |
| E4 | ポップアップ（補完・ホバー・確認・パレット …） | E1 | `Overlay` |
| E5 | 診断、行番号の印、インデントガイド | E1 | |
| E6 | 画像・Markdown のプレビュー・差分 | E1 | `blob.get`、`Pane.Kind` |
| E7 | ファイルを左右に 2 つ並べる | E1、#264 | `Files.Panes` が 2 つのとき |

### F. ターミナル

| ID | タイトル | 依存 | 中身 |
| --- | --- | --- | --- |
| F1 | xterm.js で 1 つ出す（IDE モードの右下） | B6、C2 | `term.*`、流量制御、大きさ |
| F2 | ワークスペースの切り替えでターミナルも切り替える | B7、D1、F1 | |
| F3 | ターミナルモード：カードの入れ替え | F1 | ``Ctrl+Shift+` ``、約 0.3 秒の動き |
| F4 | ターミナルの自動分割と操作 | F3 | 2 個は左右、3〜4 個は 2×2、5〜6 個は 3×2。`Ctrl+Shift+T`・矢印、`exit` で閉じる |

### 進める順番

B1・B2・C1・P1・P2 が最初に始められる。P の系列と B の系列はほぼ独立なので並行できる。E と F は B9 / B6 が済んでから。
