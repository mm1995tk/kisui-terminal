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
- 「ローカル」の shj も、リモートと同じプロトコルで話す。
- TUI は中身と同じプロセスで動く。境目（入力、`Screen`、core から UI への呼び出し）は GUI と同じ形で、違うのは運び方だけ。TUI は core の関数を直接呼び、core からの呼び出しも直接受ける。GUI へは `shj serve` の中のアダプターが、同じ境目を JSON-RPC に直して運ぶ。core は相手が TUI か GUI かを知らない。
- ターミナルは「画面に何を出すか」に変換しない。PTY の出力をそのまま GUI（coneko-term）に流し、入力もそのまま PTY に流す。
- GUI を閉じても、リモートの shj とシェルは動き続ける。7 日間（`config.toml` で変更可）どの GUI からもつながらなければ、shj は自分で止まる。
- 2 台の GUI が同じ shj につないだら、あとからつないだほうに引き継ぐ。同時編集は作らない。

## 全体像

```
手元                                      各マシン（「ローカル」も同じ）
┌────────────────────┐                   ┌───────────────────────────────────────┐
│ GUI (Tauri + Web)  │  ssh の標準入出力    │ shj attach ──┐ （ssh が切れたら終わる） │
│  ・画面を描く        │ ◀─── JSON-RPC ───▶ │              ▼ Unix ソケット          │
│  ・キー/マウスを送る  │                   │ shj serve （ssh から切り離して動く）   │
│  ・coneko-term    │                   │  ├ core ×ワークスペース（編集・LSP …） │
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

`core/screen`（`Screen` のデータ型だけ。外に依存しない）を作る。`core` が作り、TUI の描画とプロトコルが読む。

### core が知る相手は Port だけ

境目は TUI と GUI で同じ形にする。core は 1 つのインターフェース（以下 Port）だけを知り、TUI と、GUI 用のアダプター（`shj serve` の中）がそれを満たす。UI から core へは `Input` と `core.Screen()`、core から UI へは Port の呼び出しで、どちらも相手が TUI か GUI かで形が変わらない。

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

Port は `core/port.go` の `core.Port` で、`WriteClipboard`・`OpenURL`・`Exit` と、レイアウトの `ShowSide`・`ShowTerm`・`ShowAgent`・`DragBorder`・`StartResize`・`ResizeKey`・`ResetPanes`、ターミナルのパネルの `TermFocus`・`TermToggle`・`TermKey`・`TermRun`・`TermPaste`・`TermClose`、マルチプレクサのペインで終わったコマンドの `CommandEnded`、画像を見せなくなったことの `ImageClosed`、テーマの色の反映の `SetPalette`、文言を訳してもらう `Text` と、設定を読んだことを伝えて UI 自身の設定（表示言語など）を取らせる `ConfigRead` を持つ。ターミナルのパネル（`ui/tui/vt`）とマルチプレクサ（herdr・tmux・zellij・cmux）のペインは tui だけが持ち、core は意味（走らせたい行、貼り付けたい文字）だけを Port で伝える（ペインのときは `core.Layout` の `TermInPane` が立ち、core はパネルの表示とフォーカスを持たずに `TermToggle`・`ShowTerm`・`TermRun`・`TermPaste` だけを呼ぶ）。tui はシェルが見せた失敗を `core.AddFailureTab`・`ClearFailure`・`KeepFailuresOf` で core へ返す。表示中かどうかは UI が `core.Layout` の入力で返す。TUI（`tui.App`）と `shj serve` の `server.Server` が満たし、`core.Host` は無い。`OpenURL` の結果は `core.OpenURLResult` の Event で返る。マウスは `Input`（`core.Mouse`）として core が受ける（`Core.HandleMouse`。GUI のアダプターが運ぶペインの中の行と桁）。TUI は画面のマス目の当たり判定（ポップアップ・境目・ターミナル）を先に済ませて、残りを core に渡す（`tui.App.HandleMouse`）。ホバーの下の単語は core が決め（`Core.HoverCellWord`）、ホバーのスクロール（`Core.ScrollHover`）の上限だけは、ポップアップの大きさを知る UI が合わせる。レビューのコメントの入力欄は core の `core.TextArea` で、編集と折り返しは core が行い、UI は `Rows`・`CursorCell` を描く。キーの離しの通知は `core.ReleasesReported` の Input で core が受けて覚え、テーマの色の反映は Port の `SetPalette` で UI に頼む（GUI のアダプターは何もしない。GUI は `theme.get` で自分の色を決める）。`core.New`・`NewIn`・`NewSingle` は Port を受け取る。core が UI を知るのは Port だけで、`core.FrontEnd` と `headless` は無い。

### 「画面に何を出すか」（`Screen`）のデータの形

要点は次の 5 つ。

1. **意味で伝える。** 色は RGB ではなく「テーマ上の名前」（`syntax.keyword`、`diag.error`、`selection` など）で伝える。名前と色の対応表（テーマ）は別に送る（`theme.get`）。TUI の描画は同じ名前を lipgloss のスタイルにする。
2. **マス目に変換しない。** 行は「文字列 + スタイルの区間」で表す。文字の幅の計算と、字下げの線の引き方は描く側の仕事（ただしマウスの位置のマス目 → rune の位置の変換だけは `core` が行う。「入力」の節）。ただし見える行数と桁数は GUI が送り（`view.resize`）、スクロールや折り返しは shj が決める。等幅フォントで描く前提。
3. **領域（region）ごとに分ける。** TUI は全部を並べて描き、GUI は必要な領域だけ受け取る（左の一覧と右下のターミナルは GUI が自前で作るので、`Screen` の購読に入れない）。
4. **位置は「ペインの中の行と桁」。** 画面全体の座標を持たない。マウスの位置も同じ形で送る。
5. **文言はキーと値（`msg.Msg`）。** `core` と `screen.Screen` は文言を訳さず、i18n のキーと埋める値（`core/msg`）で持つ。訳すのは UI で、TUI は描くとき、GUI は受け取ったあとに訳す。`shj serve` は `Msg` を訳さずに送り、翻訳の表は `i18n.get` で渡す（「画面の送り方」の表）。`Msg` の JSON は、キーの無い文字だけのもの（ファイル名、他のプログラムの文言）は文字列のまま、それ以外は `{key?, args}`（`args` の要素は文字列・数・真偽、または入れ子の `Msg`。エラーは `Msg` か文字列）。表の `%s`・`%d`・`%q`・`%v`・`%c` は GUI が埋める。`core` が言葉そのものを要るのは、検索の一致・折り返し・エージェントや git に渡す文だけで、そこは Port の `Text` で UI に訳を借りる。

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
| `term`, `hd` | どちらでもない | ターミナルはサーバーのターミナル管理（PTY）が持つ。PTY の起動・読み書き・サイズ変更は `ui/internal/term`（`tea`・lipgloss・`vt` を使わない）に出し、TUI は `term.Session` の出力を `vt` に流して描くだけ（`tui.terminal`）。`shj serve` のターミナル管理（`server.termManager`）も起動は `term.Start` を使い、リングバッファと `term.ack` の流量制御は `server` に残す。`hd`（herdr のペイン）と tmux・zellij・cmux のペイン（`mux*.go`）は TUI だけで使う（`core` は知らない） |
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

（この段落は #448 より前の形の説明。ワークスペースの決まり方と消え方の新しい形は「ワークスペース」の節。）P14（#306）で、1 つのプロセスが `core` を複数持てるようにした。プロセス全体で 1 つのもの（ポート転送とシェル連携のファイル）は `core.Shared`（`core/shared.go`）にまとめ、`core.NewIn(shared, …)` で作った `core` はそれを共有する。TUI は今までどおり `core.New` で 1 つだけ作り、`Shared` もその `core` が持つ（`Close` で閉じる）。テーマと表示の言語はもともとプロセス全体の値（`ActivateTheme`・`i18n.SetLang`）。言語は、TUI では `core.New` がそのルートの設定で決め、`shj serve` ではホームの設定で起動時に一度だけ決める（`NewIn` は `SetLang` しない）。`shj serve` は `core.Workspaces`（`core/workspaces.go`）でルートごとに `core` を 1 つ持ち、前面は描く画面がまだ無いので Port は `shj serve` のサーバー（`Workspaces.SetPort`）で、大きさは GUI が送るまで 80 x 24 とする（`newHeadlessCore`）。`core` を作るのは `workspace.focus` のときで、ファイルを開いている間はシェルがいなくてもワークスペースは残り、どちらも無くなったら `core` を止める。サーバーは `core` を import せず、`server.Cores`（`ui/gui/server/cores.go`）を通して `files`・`workspace.close_files` を `core` に尋ねる。`workspace.close_files` は未保存の変更があるファイルを閉じずに残す。止まる前（idle と `server.shutdown`）には `AddBeforeStop` で全部の `core` の未保存の変更を `server.WriteBackup`（`<名前>.bk`）に書く。`core` の `Event` を回す仕組みと、`core` が `server.Workspace`（`ctl`・`ide` の届け先）になるのは、画面の配信（B9）と一緒に入れる。それまでは `Workspace.Do` が 1 つずつ `core` に触らせる。

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
| -32005 | `busy` | 上限を超えた、またはターミナルでプログラムが動いている |

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
- **切れる**：標準入出力が閉じたら、GUI がいなくなったとみなす。状態（ワークスペース、ファイル、`core`、ターミナル）は残り、`lastClientAt` を覚える。
- **つなぎ直す**：新しい `session.hello` で `resume: {serverId, rev}` を送る。同じ `serverId` なら状態が残っているので、`screen.get` で全部取り直して続けられる。`serverId` が違えば shj が作り直されたので、GUI はワークスペースの一覧から取り直す。
- **止まる**：`lastClientAt` から 7 日（`config.toml` の `[server] idle_stop_days`、0 で止まらない）つながらなければ、`shj serve` は終わる。つながっている間は止まらない。ターミナルでシェルが動いていても止まる（そのシェルは SIGHUP で終わる）。止まる前（7 日で止まるとき・`server.shutdown` のとき）の未保存の変更は、元のファイルの隣の `<ファイル名>.bk` に書いてから止まる（同じ名前があれば上書きせず `.bk.1` のように番号を付ける。元のファイルは書き換えない）。実装（B4）は `server.WriteBackup` と、止まる直前に一度だけ走る `Server.AddBeforeStop`。次に開いたときに `.bk` を知らせる仕組みは作らない。ワークスペースの一覧は、止まる前に保存して次の起動で作り直す（「ワークスペース」の節の「`shj serve` が止まったあと」）。`[server] idle_stop_days` は `~/.config/shijimi-editor/config.toml` だけで有効。

### 画面（`Screen`）の送り方

**決め方：変わった分だけ送る。** 領域ごとに版（`rev`）を持ち、ファイルの欄の行は「変わった行だけ」を送る。理由：1 文字打つと変わるのは 1 行と状態行ぐらいで、毎回全部を送ると回線の遅いときに目に見えて遅くなる。スクロールでは全行が変わるが、1 画面分（高々 100 行ほど）なので許せる。

| メソッド | 向き | パラメータ → 結果 |
| --- | --- | --- |
| `view.subscribe` | → shj | `{regions: ["files", "status", "cmdline", "overlay"]}` → `{}`。受け取る領域を選ぶ（GUI は `explorer` などを選ばない） |
| `view.resize` | → shj | `{regions: {"files": {cols, rows}, "status": {cols}, "cmdline": {cols}, "overlay": {cols, rows}}}` → `{}`。領域ごとの桁数と行数（等幅のマス目で数える）。ペインの大きさ（2 つ並べるときの割り方）は shj が `files` の中で決める。ペインができる前でも送れる。変えると画面が送り直される。`{splits: {diff, preview}}` も送れる（0〜100。ファイルの欄を左右に分けた境界で、差分の分割とプレビューの分割の、左側の幅の %。0 は半分。GUI がドラッグで決めた値を覚えて送る） |
| `screen.get` | → shj | `{}` → `Screen`（全部）。つなぎ直し、抜けの回復用 |
| `screen.update` | ← GUI | 通知 `{rev, baseRev, ackSeq, focus?, files?: {panes: [{id, kind?, title?, viewport?, lines?: {rows: {"0": Line, "5": Line}, count}, cursors?, selections?}], active?}, status?, cmdline?, overlay?}`。付いている項目だけが変わった。`lines.rows` のキーは「ビューポートの中で上から何行目か」（0 始まり。バッファの行番号は `Line.No`）で、`count` は見えている行数。スクロールするとキーの意味する行が全部変わるので、全行を送る。`baseRev` が GUI の持つ版と合わなければ GUI は `screen.get` する |
| `screen.ack` | → shj | 通知 `{rev}`。GUI が描き終えた版。shj は返事の来ていない更新を 1 つまでしか溜めず、間の変化は 1 つにまとめて送る（遅い回線で更新が積み上がらないように） |
| `theme.get` | → shj | `{}` → `{name, tokens: {"syntax.keyword": {fg, bg?, bold?, italic?, underline?}}}`。テーマが変わると `theme.changed` 通知（同じ形） |
| `i18n.get` | → shj | `{}` → `{lang, messages: {"key": "text with %s"}}`。`shj serve` の表示言語（`config.toml` の `ui-language`）の文言の表で、その言語に無い文言は英語で埋めてある。表は en と ja の 1 組（`ui/internal/i18n`）のままで、GUI 用の別の表は無い。GUI は `Msg`（`{key, args}`）を表の `key` の文に `args` を埋めて訳す。言語が変わると `i18n.changed` 通知（同じ形）を `screen.update` の前に送り、GUI は画面を `screen.get` で取り直す |
| `blob.get` | → shj | `{id, offset?, length?}` → `{mime, size, data (base64), eof}`。画像・プレビュー用の画像は `Screen` に埋め込まず `ImageRef{id, mime, w, h}` で持たせ、これで取る。大きい画像は分けて取る |

- 画面の更新は、入力やその他のイベント（LSP の返事、タイマー）を処理したあとに作る。作るのはフォーカスしているワークスペースの分だけ。
- 実装（B9）で決めた細部：
  - `view.resize` の `files.rows` はペインの本文の行数で、タイトル行を含めない。`view.resize` の前は 80 桁 × 22 行とみなす。
  - `screen.update` の `files.panes` には今のペインを全部並べる（並びで消えたペインが分かる）。前からあるペインは `id` と変わった項目だけ、新しいペインは全部の項目を持つ。表に無い `Pane` の項目（`curLine`・`image`・`caption`・`diff`・`preview`）も、変わったときに付ける。
  - 購読して最初の更新（`baseRev` は 0）と、ワークスペースを移したあとの更新は、購読している領域を全部持つ。
  - `theme.get` の `tokens` は色を `fg` だけに入れる。`Screen` は同じ名前を文字にも背景（`Span.Bg`）にも使うため。
  - `blob.get` の `id` は `ImageRef.Blob` そのもの（`file:<絶対パス>` か `mermaid:<図の鍵>`）。今の画面に出ている画像だけを返し、ほかは `not_found`。1 回で返すのは 4 MiB まで。
  - 画面を作り直すきっかけは `server.Server.ScreenChanged`。入力（B10）やイベントを処理した側が呼ぶ。
- GUI の実装（E4）で決めた細部（`ui/gui/app/src/files/overlay.ts`・`OverlayView.tsx`）：
  - `overlay` を購読し、`view.resize` の `overlay` には欄（`files`）と同じ桁数と行数を送る（ポップアップは本文の上に重ねるため）。
  - 置き方は TUI に合わせる。補完・ホバー・カードは `at` の下（入らなければ上）、シグネチャは上（1 行目なら下）、パレットは上の真ん中、メニューは右下、コメントの入力欄は下の真ん中。`at` のマス目は、ペインの見えている行（`Line.No` が `at.line` のもの）の文字の幅で数え、行番号の欄と左のペインの幅を足す。
  - 確認（`confirm`）は箱にせず、TUI と同じく状態行のメッセージの代わりに出す（y/n のときは右の項目を出さない）。
  - 検索の窓（`search`）は欄いっぱい（周りに 1 マス）の箱にする。入力欄・オプション・状態の行・一覧・プレビューの割り付けは TUI の `drawSearch` と同じで、一覧は見えている分（`scroll` から `bodyRows` 行）、プレビューは行を中心に shj が選んだ範囲だけが来る。窓のマウス操作はしない（キーだけ）。
  - エージェントの変更の承認の窓（`proposal`）は、幅が画面の 8 割（30〜140 桁）で、上から 1 行空けて真ん中に置く。`title` は見出し（キーの案内と待っている数を含む）、`lines` は見えている差分の行（追加・削除は `band` で行いっぱいに背景を付ける）、`view` が位置と幅。差分に行が無いときは `lines` の代わりに `empty`。キーは今まで通り `Enter`（承認）と `Esc`（却下）で、core が全部のキーを受ける。
  - ポップアップを押しても shj には送らない（キーを受ける `textarea` からフォーカスを外さないだけ）。レビューカードの画像（`images`）は E6 で描く。
- GUI の実装（E6）で決めた細部（`ui/gui/app/src/files/blob.ts`・`diff.ts`・`MediaView.tsx`・`layout.ts`）：
  - `blob.get` は `eof` まで `offset` をずらして分けて取り、つないで `Blob` の URL にする。つなぎ先ごとに覚え（鍵は `ImageRef` の `blob`・`width`・`height`・`size`）、新しく使った順に 64 個まで残す。取れなかったもの（`not_found`）は覚えず、次に出たときに取り直す。
  - 画像は縦横比を保って枠に縮めて入れ、元より大きくしない（TUI の `core.FitImage` と同じ）。画像のペインは説明の行の下の全部の真ん中に、プレビューとレビューカードの画像は shj が空けた表示行（`row`・`rows`・`col`）の左上に置く。
  - 差分のペインはテキストと同じく行番号の欄を持つ（幅は `viewport.total` から）。色分けは TUI（`ui/tui/gitdiff_draw.go`）に合わせる：消した行は `diff.del.bg` で印の桁に「-」、足した・書き換えた行は `diff.add.bg`、`words` は消した側が `diff.del.word.bg`・足した側が `diff.add.word.bg`、`blank` は `side.bg`。カーソル・選択・行の強調は、変更の後の側の消した行でも空きでもない行にだけ描く（1 列の差分で消した行の `no` は変更前の行番号で、バッファの行番号と重なるため）。
  - 変更のバーは変更の後の側（`diff.side` が `new` か `unified`）のペインの右端に 6px で重ねる（shj は桁を空けない）。マス目の決め方は `core.BarRange`・`core.BarKinds` と同じ。

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
- 実装（B10）で決めた細部：
  - 入力のメソッド（`input.*`・`command.run`・`file.open`）は、受け取った順に 1 件ずつ処理する（`rpc.Options.Ordered`）。ほかの要求とは並んで動く。
  - 反映したら、その `seq` を `ackSeq` として覚えて画面を作り直す。応答の `rev` は、そのあとの最新の版。返事を待っている更新があると、入力が入った画面は `screen.ack` のあとに届くので、GUI は `ackSeq` で確かめる。見た目の変わらない入力（`release` など）でも、`ackSeq` を進めた `screen.update`（ほかの項目は無い）を送る。
  - `input.key`：`key` と `text` は `core` が TUI と同じ `Key` にする（Shift 付きの文字は小文字の `Code`、Ctrl / Alt / Super / Meta を押しているときは文字を打たない）。修飾キーだけ・dead key は捨てる。`key` が 1 文字でも知っている名前でもない（`"Process"` など）ときは `text` を打つ（IME の確定）。`phase: "release"` は `core` に渡さない。`mods` は `"meta"` も受ける。
  - `input.composition`：変換中の文字は、キーを受けるペインのカーソルの位置に `underline: true` の `Span` として入れる（バッファは変えない）。コマンド行で変換している間は出さない。`cursor: null` で消える。確定した文字は `input.key` の `text` で来る。
  - `input.mouse`：`pane` は `Pane.id`。`row` は `lines.rows` のキーと同じ数え方（本文の上から何行目か）、`col` は行番号の右からの桁（横スクロールの前の、見えている桁）。`button` は W3C の `MouseEvent.button`（0 が左、1 が中、2 が右）。左を押すとカーソルが動き、押したまま動かすと選択になる。`wheel` は `dy` 行・`dx` 桁（Shift を押していると縦が横になる）。2 つ並べた相手のペインを押すと、先にそちらへフォーカスを移す。差分・画像・プレビューのペインでは、押してもフォーカスが移るだけ。
  - `input.focus`：`core` に効くのは `files` だけ（キーをエディタに移す）。ほかの領域は GUI が自分で持つ。知らない `region` は `invalid_params`。
  - `command.run`：制御用ソケットの `exec` と同じく、`:q` のように終わらせるものや、人が選ぶ必要があるものは `ok: false` で断る。
  - `file.open`：`path` はワークスペースのルートからの相対パス（`tree.*` と同じ）。外へ出るもの・リンクの先が外のものは `denied`、無いものは `not_found`、フォルダは `invalid_params`。`line` と `col` は 0 始まりで、`col` は rune の位置（`Pos` と同じ）。どちらも省くと、開いていたファイルのカーソルは動かない。`pane` が 2 つ並べた相手のペインなら、そちらで開く。ワークスペースに `core` が無ければ作る。
  - `shj serve` の `core` は TUI と同じく、頼んだ仕事（`Effect`：言語サーバー、タイマー、検索 …）をそれぞれの goroutine で回し、戻ってきた事象を反映したら画面を作り直す（`core.Workspace.Update` / `Apply`、`Workspaces.SetOnChange`）。作ったときに言語サーバーの待ちとファイルの監視を始める。Port の `Exit` は捨てる。
- GUI の実装（E2）で決めた細部（`ui/gui/app/src/files/input.ts`・`filesInput.ts`・`FilesView.tsx`・`clipboard.ts`）：
  - キーは見えない `textarea` で受ける（IME の変換と貼り付けを OS に任せるため）。IME の候補の窓がカーソルの近くに出るよう、変換を始めたときにカーソルのマス目へ動かす。
  - `input.key` は `keydown` だけを送る（`release` は `core` が使わないので送らない）。修飾キーだけ・dead key・変換中のキー（`isComposing`、`keyCode` 229）も送らない。 macOS の Option で打つ文字（ドイツ語配列の Option+L = `@` など）は `alt` を付けずに送る（macOS のターミナルの既定と同じ）。
  - IME：変換中は `input` のイベントごとに `input.composition`（`cursor` は UTF-16 の位置を rune の位置にしたもの）、確定したら `cursor: null` を送ってから、確定した文字を `{key: "Process", text}` の `input.key` で送る。
  - GUI が受けて送らないキー：OS のクリップボードからの貼り付け（macOS は Cmd+V、ほかはターミナルと同じ Ctrl+Shift+V。Ctrl+V は shj のレジスタから貼る Helix のキーなので送る）、`Ctrl+Shift+T`・``Ctrl+Shift+` ``（F3・F4 で使う）。
  - マウス：押したペインの中で、押したまま動かしたときだけ、マス目が変わったら `move` を送る（ペインの外へ出ても押したペインのマス目で数え、はみ出しは丸めない。上は負の行になり、`core` がスクロールする）。離したのを取りこぼしたら（`buttons` が離れている、ウィンドウがフォーカスを失った）、そこで `up` を送る。`clicks` は同じボタン・同じマス目を 400 ms 以内に押したら増やす（3 まで）。ホイールの px は行（`dy`）と桁（`dx`）にし、端数は次に持ち越す。
  - `clipboard.write` は `navigator.clipboard.writeText` で入れる。WebKit がユーザーの操作の外だとして断ったら覚えておき、次にキーかマウスを押したときに書き直す。覚えている間の貼り付けは、その文字を使う。 ウィンドウがフォーカスを失ったら覚えた文字は捨てる（ほかのアプリでコピーした内容を上書きしないため）。
  - 送る順番：Ctrl+Shift+V でクリップボードを読む間に来た入力は、読み終えて `input.paste` を送るまで待たせる（ブラケットペーストと同じく、貼り付けの後のキーが先に届かないように）。

### shj から GUI への通知（その他）

| メソッド | 向き | パラメータ |
| --- | --- | --- |
| `clipboard.write` | ← GUI | `{text}`。コピーしたとき、GUI 側の OS のクリップボードに入れる（TUI では OSC 52） |
| `resize.start` | ← GUI | `{}`。`Alt+R` かパレットの「リサイズ」で、core がリサイズモードに入った。境界の値は GUI が持ち、動かすキーも GUI が受ける（終わるときは Esc を `input.key` で送る） |
| `resize.key` | ← GUI | `{key}`。core がリサイズモード中に受けたキー（GUI が受けるので、ふだんは来ない）。`esc`・`enter`・`q`・`alt+r` で core はモードを終える |
| `resize.reset` | ← GUI | `{}`。パレットの「ペインの大きさを初期値に戻す」。GUI は境界を全部元の大きさに戻す |
| `url.open` | ← GUI | `{url}`。`:open-url` など。GUI 側のブラウザで開く |
| `notify` | ← GUI | `{level, text}`。画面に出さない通知（接続のログなど） |

### ターミナル

`Screen` には変換しない。PTY の出力をそのまま流す。ターミナルは**サーバー全体で持ち**（ワークスペースの `core` には属さない）、**ワークスペースごとに、プライマリターミナル 1 つと分割したターミナル 0〜5 個**を持つ。どのワークスペースに属するかは作るときに決まり、cwd からは決まらない（次の節）。

- **プライマリターミナル**：ワークスペースを作ると同時にできる。IDE モードの右下と、ターミナルモードの 1 つ目の欄は、同じプライマリターミナル。そのシェルの cwd がワークスペースのフォルダを決める。プライマリターミナルは `term.close` で閉じられず、ワークスペースが消えるとき（`workspace.close`）にだけ終わる。
- **分割したターミナル**：ターミナルモードで足した 2 つ目以降（0〜5 個。合計で 6 個まで）。`term.create` で作り、`term.close` で閉じる。cwd が変わってもワークスペースには何も影響しない。
- 始めるフォルダ：プライマリターミナルは、フォルダ未定のワークスペースならそのマシンの `[server] start_dir`、決まっていればそのフォルダ。分割したターミナルは、ワークスペースのフォルダ（フォルダ未定なら `start_dir`）。

| メソッド | 向き | パラメータ → 結果 |
| --- | --- | --- |
| `term.create` | → shj | `{workspaceId, cols, rows, shell?, env?}` → `{termId, pid, cwd}`。分割したターミナルを足す。ワークスペースのフォルダ（フォルダ未定なら `start_dir`）で始める。そのワークスペースにすでに 6 個あれば `busy`。`shell` が無ければ今の設定どおり。プライマリターミナルは `workspace.create` が作るので、ここでは作らない |
| `term.list` | → shj | `{}` → `{terms: [{termId, pid, cwd, workspaceId, primary: bool, title, cols, rows, alive}]}` |
| `term.attach` | → shj | `{termId, fromSeq?}` → `{seq, replay (base64), cols, rows}`。つなぎ直したとき、溜めておいた出力（1 ターミナルにつき最大 1 MiB のリングバッファ）を取り直す。`fromSeq` より前が捨てられていれば、残っている分だけ返す |
| `term.close` | → shj | `{termId}` → `{}`。シェルに SIGHUP を送る。分割したターミナルだけ（プライマリターミナルに送ると `denied`。ワークスペースごと閉じるときは `workspace.close`） |
| `term.restart` | → shj | `{termId}` → `{pid, cwd}`。終わったプライマリターミナルに新しいシェルを始める（`termId` はそのまま）。プライマリターミナルだけ（分割したターミナルに送ると `denied`）。ワークスペースのフォルダ（フォルダ未定なら `start_dir`）で始める。シェルがまだ動いていれば `busy` |
| `term.resize` | → shj | `{termId, cols, rows}` → `{}` |
| `term.input` | → shj | `{termId, data (base64)}` → `{}`。coneko-term が作ったバイト列をそのまま PTY に書く |
| `term.output` | ← GUI | 通知 `{termId, seq, data (base64)}`。PTY の出力。`seq` はバイト数の累計 |
| `term.ack` | → shj | 通知 `{termId, seq}`。GUI が処理したバイト数。shj は `seq` から 256 KiB より先までは送らない。このとき PTY は読み続けてリングバッファに溜め、溢れた分は捨てる（GUI が止まってもシェルは止めない。捨てた分は `term.attach` で取り直す）（`yes` のような大量の出力で回線と WebView が詰まらないように） |
| `term.exit` | ← GUI | 通知 `{termId, code, signal?}`。シェルが終わった。送り残した `term.output` より先に届くことがある（GUI は `term.exit` のあとも `term.attach` で残りを取る）。溢れて捨てられた分は `term.output` の `seq` が飛んで届くので、欠けは `seq` の連続性で分かる |
| `term.title` | ← GUI | 通知 `{termId, title}` |

- 終わったプライマリターミナルは `alive: false` のまま残り、ワークスペースを消さない（「ワークスペース」の節の 11）。
- JSON では base64 にするので出力が約 1.33 倍になる。MessagePack に変えれば生のバイト列で送れる。「速さが足りなければ MessagePack に」が一番効くのはここ。
- ターミナルの中身を読む `ui/tui/vt` は TUI だけで使う。GUI ではサーバーは PTY のバイト列を中継するだけで、エミュレートしない。コマンドの終了を知らせる印（`command-end`、`shellint`）は、サーバーでは取り出さない（B6 で確かめた）。バイト列は coneko-term にそのまま届くので、印が要る機能は GUI の側（coneko-term の `registerOscHandler`）で拾う。サーバーが出力から読むのはタイトル（OSC 0 / 2）だけ。
- GUI の側（F1）で決めた細部（`ui/gui/app/src/terminal/link.ts`）：
  - `term.output` の `seq` は、そのかたまりの終わりのバイト数の累計。GUI は書いた分の `seq` を覚え、かたまりの始め（`seq` − 長さ）がそれより先なら欠けとみなして `term.attach`（`fromSeq` は覚えた `seq`）で取り直す。重なる分は捨てる。
  - `term.ack` は coneko-term が書き終えた（`write` のコールバックが来た）ときに返す。画面が遅れると shj が送るのを待つので、大量の出力でも WebView が詰まらない。
  - 取り直した分（最大 1 MiB）は ack の窓の外なので、coneko-term が書き終えるまでは次の `term.attach` を送らず、その間の欠けは書き終えてから 1 回だけ取り直す（coneko-term に積まれる量を「取り直し 1 回分 + ack の窓」までにする）。
  - `term.attach` の返事を待つ間に届いた `term.output` は捨てる（取り直す分に入っている）。キー入力はその間も送る（`yes` を止める Ctrl+C を落とさない）。`term.create` の返事より先に `term.output` が届くことがあるので、作ったら `term.attach`（0 から）で取り直す。
  - 右下に出すのは、フォーカスしているワークスペース（無ければ最初につながったマシンの最初のワークスペース）のプライマリターミナル。シェルが終わったら知らせを出し、Enter で `term.restart` する。画面を外している間や切れている間に終わると `term.exit` が届かないので、付け直し・つなぎ直しのあとに `term.list` で生きているかを確かめ、`term.input`・`term.resize` の `not_found` も終わったものとして扱う。
- GUI の側（F2）：帯を押して `workspace.focus` が受け付けられたら、そのワークスペースのプライマリターミナル（返事の `termId`）に切り替え、溜めた出力を全部取り直して描く（前のシェルは止めない）。どのワークスペースにも必ずプライマリターミナルがあるので、ターミナルを探して作る処理は要らない。切り替えたターミナルの大きさが画面と違えば `term.resize` で合わせる。
- GUI の側（F3。`ui/gui/app/src/mode.ts`）：``Ctrl+Shift+` `` で、ファイルの欄とターミナルの 2 枚のカードの上下を入れ替える。IDE モードは上が大きなファイルの欄・下が 300px のターミナル、ターミナルモードは上が大きなターミナル・下が 300px のファイルの欄。どちらのカードも隠さない（タブにしない）。割り付けはすぐ変え、見た目だけを 0.3 秒かけて前の位置と大きさから動かす（FLIP）。カードは作り直さないので中身は動き続け、`view.resize`・`term.resize` も割り付けを変えたときに送る。キーは上に来たカードに向ける。動きを減らす設定（`prefers-reduced-motion`）なら動かさない。IDE モードでも、フォーカスしているワークスペースでファイルを開いていない（ファイルの欄のペインが `welcome` だけ・画面がまだ無い・ワークスペースが無い）あいだは、ファイルの欄を出さず右の列を全部ターミナルにする（親 #271 のモック U2）。ファイルを開いたら上がファイルの欄・下が 300px のターミナルに戻る。ファイルの欄を出していないあいだは `view.resize` を送らず、出したときに測り直して送る。ターミナルモードは開いていなくても変えない。
- GUI の側（F4。`ui/gui/app/src/terminal/group.ts`・`grid.ts`）：ターミナルモードでは、フォーカスしているワークスペースのターミナル（プライマリ 1 つと分割したもの。6 個まで）を並べる。プライマリターミナルが 1 つ目の欄。1 個は全体、2 個は左右、3〜4 個は 2×2、5〜6 個は 3×2 で、升目が 1 つ余るとき（3 個・5 個）は最後のターミナルを 2 升ぶんの幅にする。IDE モードの右下に出すのは、プライマリターミナル（分割したものは作り直さずに動かし続ける。隠したものを忘れないよう、ほかにもあればその数を右上に出す）。`Ctrl+Shift+T` で `term.create` して足し（6 個なら足さない）キーを向ける。分割したターミナルのシェルが終わったら（`exit`）`term.close` してその欄を閉じ、並び直して隣にキーを向ける。プライマリターミナルのシェルが終わったら、IDE モードでもターミナルモードでも欄を閉じず「Enter で作り直す」を出し、Enter で `term.restart` する。`Ctrl+Shift+矢印` は、ターミナルモードでキーがターミナルに向いているときだけ GUI が受けて隣へ移る（ファイルの欄では shj に送る）。上下は今の欄の左端の列にかかる欄へ移る。今使っている欄は、上端にマシンの色の線を引く（タブの見出しは作らない）。F2 でワークスペースを移したときは、並べるターミナルがそのワークスペースのものに替わり、今使うのはそのプライマリターミナルになる。

### ワークスペース

**ワークスペースは作業の単位で、フォルダとは 1 対 1 ではない。** 同じフォルダを指すワークスペースが 2 つ以上あってよい。ワークスペースは `workspace.create` で作り、`workspace.close`（GUI の [×]）でしか消えない。フォルダは、プライマリターミナルのシェルの cwd から決まる。

用語：

- **マシン**：サイドバーの見出し 1 つ。「ローカル」と、ユーザーが足した ssh の行き先（総称は「マシン」。「ホスト」とは呼ばない。ローカル以外は「リモート」）。
- **ワークスペース**：作業の単位。サイドバーでは帯 1 本で見せる（「帯」は見た目の呼び名で、仕様ではワークスペースと呼ぶ）。
- **プライマリターミナル**：ワークスペースごとに 1 つのターミナル（「ターミナル」の節）。
- **分割したターミナル**：ターミナルモードで足した 2 つ目以降のターミナル（0〜5 個）。

決めたこと（番号は #445 で決めた順）：

1. **フォルダと 1 対 1 ではない**。同じフォルダを指すワークスペースが 2 つ以上あってよい。`workspaceId` はフォルダのパスから作らず、shj が作るときに振る不透明な文字列（保存して次の起動でも同じ値を使う）。
2. **[+] で作る**：マシンの見出しの [+] を押すと、フォルダ未定のワークスペースがすぐできる（`workspace.create`）。プライマリターミナルは、そのマシンの `~/.config/shijimi-editor/config.toml` の `[server] start_dir` で始まる（書いていなければ `~`。書いたフォルダが無ければ設定ファイルの間違い。17 と同じ扱い）。キーはプライマリターミナルに向く。フォルダ未定のあいだ、サイドバーには「（フォルダ未定）」と出し、ファイルツリーとファイルの欄は空。フォルダを選ぶ窓は作らない（`cd` や zoxide の `z` で移ればよい）。
3. **フォルダはプライマリターミナルの cwd だけから決める**（IDE モードでもターミナルモードでも同じ。シェルは同じなので）。決め方は下の「フォルダの決め方」。同じフォルダの中での `cd`（`cd src` など）では何も起きない。
4. **`cd` はプロジェクトの切り替え**：プライマリターミナルが別のフォルダへ `cd` したら、そのワークスペースのフォルダがそこに切り替わる（新しいワークスペースは増えない。`workspace.changed` の `updated` で `folder` が変わる）。
   - 開いているファイルは、自動保存の 1 秒を待たずにすぐ保存してから閉じる。
   - 自動保存を切っている（`[editor.auto-save.after-delay] enable = false`）ときは、切り替えのときに保存するか捨てるかを `[editor.auto-save] on-switch = "save" | "discard"` に必ず書く。既定値は無く、書いていなければ設定ファイルの間違い（起動しない。17）。
   - 行き先のフォルダを指すワークスペースがすでにあっても、まとめない（同じフォルダのワークスペースが 2 つになる）。
   - 分割したターミナルはそのまま残す（元のフォルダにいたまま、そのワークスペースに属する。勝手に止めない、`cd` を打ち込まない）。
5. **`cd ~` と `cd /`（ホームと `/` そのもの）では切り替えない**。開いているファイルも閉じない。次にプロジェクトのフォルダへ移ったときに切り替わる。
6. **分割したターミナルの `cd` は、ワークスペースに何も影響しない**。
7. **[×] で閉じる**（`workspace.close`）：開いているファイルを保存して閉じ、そのワークスペースのターミナル（プライマリと分割）を全部終わらせる。プログラムが動いているターミナルがあれば `busy` で断り、GUI は「動いているプログラムを終わらせますか」と確認を出してから `force: true` で送り直す。ワークスペースは [×] でしか消えない（シェルがいなくなっても、ファイルが無くても消えない）。
8. **同じファイルを 2 つ以上のワークスペースで開いたら、メモリの写し（バッファ）は 1 つで共有する**。1 文字打てばほかのワークスペースにもすぐ出る。カーソルの位置とスクロールの位置はワークスペースごと。取り消し（undo）の履歴も共有になる（実装は #449）。
9. **`shj serve` が止まったあと**（7 日の idle 停止・`server.shutdown`）：ワークスペースの一覧（`workspaceId` とそれぞれのフォルダ。フォルダ未定も）をそのマシンのファイルに保存しておき、次に起動したときに作り直す。プライマリターミナルはそのフォルダ（フォルダ未定なら `start_dir`）で自動で作り直す。保存していたフォルダがもう無ければ、フォルダ未定として作り直し、プライマリターミナルは `start_dir` で始める（ワークスペースは消さない）。分割したターミナルと開いていたファイルは戻さない（未保存の変更は今までどおり `.bk`）。保存先は `$XDG_STATE_HOME/shijimi-editor/workspaces.json`（`serve.log` と同じ場所。nightly は別。実装は #450）。
10. **ターミナルの形**（「ターミナル」の節）：ワークスペースごとに、プライマリターミナル 1 つと分割したターミナル 0〜5 個。ターミナルモードで並べるのは、フォーカスしているワークスペースのターミナル。
11. **プライマリターミナルで `exit` しても、欄を閉じない**。「Enter で作り直す」を出し、Enter でワークスペースのフォルダ（フォルダ未定なら `start_dir`）で新しいシェルを始める（`term.restart`）。IDE モードでもターミナルモードでも同じ。分割したターミナルの `exit` は、欄を閉じて並び直す。
12. **リモートを足す**：サイドバーの一番下は「+ リモートを足す」（herdr の `machine add` のような形）。カードの窓で ssh の行き先（`~/.ssh/config` の候補）と名前（空なら ssh の行き先）を入れる。足すときに ssh でつなぎ（「ssh 越しに shj を起動する」）、`shj` が無ければ確認してから送り、`shj serve` を起動できたらマシンを保存して見出しを出す。つなげなければ理由を出して保存しない（実装は #451）。マシンの一覧は GUI の側（手元）が持つ。shj のプロトコルには出ない。
13. **サイドバーに出るマシン**は「ローカル」と足したマシンだけ。`~/.ssh/config` のホストを全部並べない（候補に出すだけ）。
14. **マシンの見出しを右クリック**して「名前を変える」「外す」。外しても、そのマシンの `shj serve` は止めない。
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

`core` はワークスペースごとに 1 つ持つ。フォルダが切り替わるとき、`core` はファイルを閉じたうえで新しいフォルダに作り直す（LSP なども新しいフォルダのものになる）。フォルダ未定のあいだの `core` はファイルを持たない。

| メソッド | 向き | パラメータ → 結果 |
| --- | --- | --- |
| `workspace.list` | → shj | `{}` → `{workspaces: [Workspace], focus}`。`Workspace` は `{id, folder: path\|null, kind: "git"\|"shijimi"\|"cwd"\|null, name: string\|null, branch?, primary: termId, terms: [termId], files: [path]}`。`folder` が `null`（`kind` も `null`）なのはフォルダ未定のあいだ。`name` はフォルダ未定なら `null`（GUI は「（フォルダ未定）」と出す）。`primary` はプライマリターミナル、`terms` は分割したターミナル（並べる順） |
| `workspace.create` | → shj | `{}` → `{id, termId}`。フォルダ未定のワークスペースを作り、プライマリターミナルを `start_dir` で始める。`termId` はそのプライマリターミナル。作ったワークスペースにはフォーカスしない（GUI が `workspace.focus` を送る） |
| `workspace.close` | → shj | `{id, force?: bool}` → `{}`。開いているファイルを保存して閉じ、ターミナル（プライマリと分割）を全部終わらせてワークスペースを消す。プログラムが動いているターミナルがあれば、`force` が無い限り `busy` で断る（何も閉じない。GUI は確認を出してから `force: true` で送り直す）。保存できなかったファイルがあれば、`force` に関わらず何も閉じずに `busy` で断る。`busy` の `data` に `{reason: "running" \| "unsaved", paths?: [...]}` を付け、GUI は文言を分ける（`running` は「動いているプログラムを終わらせますか」の確認、`unsaved` は保存できなかったファイルの一覧を出すだけで、確認しても送り直さない）。`force: true` が終わらせるのは動いているプログラムだけで、保存できなかったファイルは捨てずに残す（黙ってデータを失わない） |
| `workspace.changed` | ← GUI | 通知 `{added?: [Workspace], removed?: [id], updated?: [Workspace]}`。ワークスペースが増えた / 減った / 中身（`folder`、ターミナルの増減、ブランチ、開いているファイル）が変わった。`workspace.create`・`workspace.close` を送った GUI にも届く（返事より先に来ることがある） |
| `workspace.focus` | → shj | `{id}` → `{rev, termId}`。フォーカスを移す。画面（`Screen`）はそのワークスペースの `core` のものに切り替わる。`termId` はそのワークスペースのプライマリターミナル |

- `workspace.focus` を境に、`input.*` と `screen.update` の宛先が変わる。`rev` はサーバー全体で 1 つの数にする（ワークスペースを移しても増え続ける）。
- ファイルは、ワークスペースごとに `core` が覚える（同じファイルを複数のワークスペースで開いたときの共有は 8）。フォーカスを外しても `core` は残る（外したワークスペースの LSP を止めるかは、P14 のあとで測って決める）。
- **前の設計から消すもの**：`term.cwd`（フォルダが変わったことは `workspace.changed` の `folder` で分かる。分割したターミナルの cwd は GUI は要らない）と `workspace.close_files`（ワークスペースは [×] でしか消えず、ファイルだけ閉じる操作は作らない。ファイルの欄から 1 つずつ閉じる）。`workspaceId` を `null` にして「ワークスペースに属さない」を表すこともしない（どのターミナルもどれかのワークスペースに属する）。
- 空きの扱い：ワークスペースが 1 つも無いとき、GUI は何も出さずに [+] を待つ。ワークスペースを自動では作らない。

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
- GUI でファイルの行を押す（Enter・Space でも）と、`file.open` を `pane` を省いて送る（ファイルの欄でフォーカスしているペインで開く）。`seq` は `input.*` と同じ数え方。送れたら、IDE モードならキーをファイルの欄に向ける（つながっていなくて送れなかったときは移さない。初めて開くときは、画面が来てファイルの欄が出てから向ける）。断られたら（`denied`・`not_found` など）、帯を押して移れなかったときと同じ所に「<path> を開けませんでした（理由）」を `role="alert"` で出す。ワークスペースを移している途中（`workspace.focus` の返事待ち）は送らない（shj は `file.open` でフォーカスを動かさないので、開いても移った先では見えない）。ファイルの欄でフォーカスしているペイン（テキストか画像）の `id`（ファイルの絶対パス）がルートの中なら、その行を強調する（`ui/gui/app/src/tree/model.ts` の `rowAction`・`currentFile`）。

### ssh 越しに shj を起動する

GUI はシステムの `ssh` を子プロセスとして起動する（`~/.ssh/config` と ssh-agent をそのまま使うため）。ssh がパスワードや 2 段階認証を求めるときは `SSH_ASKPASS` で GUI の窓に出す。

1. **shj の場所**：`~/.cache/shijimi-editor/<GUI の版>/shj`。無ければ、PATH、次によく使う場所（`~/.nix-profile/bin`・`/etc/profiles/per-user/$USER/bin`・`/run/current-system/sw/bin`・`/opt/homebrew/bin`・`/usr/local/bin`・`~/.local/bin` など。ssh が動かす非対話・非ログインのシェルの PATH には Nix のプロファイルが入っていないことがあるため）の `shj`（nightly 版の GUI は `shj-nightly` を先に）のうち、`--version` が GUI と同じ版（nightly はコミットまで同じ）のものを使う。版の違う shj や `attach` を持たない古い shj は使わない。同じ版がどこにも無ければ、ユーザーに聞いてから GUI が転送する。PATH の `shj` には触らない。リモートの OS とアーキテクチャは `uname -sm` で調べ、合う実行ファイルを GitHub Releases から GUI が取って送る。取ったら送る前に、GitHub Releases の checksums（Release に上げる `SHA256SUMS`。`sha256sum` の形式）にある SHA-256 と、取得した実行ファイルを比べる（取得の段階の確認。合わなければ ssh を起動する前に捨てる）。リモートに置いたファイルも同じ値かを確かめる（転送の壊れの確認。リモートで一時ファイルの SHA-256 を計り、合ったときだけ `shj` の名前にする）。shj が無いことは、2 のコマンドの終了コード 97 で知る（`ssh` 自身の失敗は 255）。nightly 版の GUI は、動くタグ `nightly` の `shj-nightly-<os>-<cpu>` を取る。
2. **つなぐ**：`ssh -T host -- sh -c '<1 の順に探し、無ければ exit 97。あれば exec <shj> attach>'`（ログインシェルが fish などでも動くよう `sh -c` で包む。環境変数 `SHIJIMI_REMOTE_SHJ` で場所を指定したときは、その場所だけを見て `command -v <shj> >/dev/null 2>&1 || exit 97; <shj> attach`）（`-T` は端末を割り当てない）。ユーザーの `ssh_config`（`ControlMaster` など）はそのまま効く。
3. **`shj attach` がすること**（リモートで動く橋渡し）：
   1. 標準出力に `@@shj-rpc 1@@` を出す。
   2. ソケットのフォルダを見て、`shj serve` が動いていれば、その Unix ソケットにつなぐ。**すでに動いている shj につなぎ直す方法はこれ。** ssh のたびに新しい shj は起動しない。
   3. 動いていなければ、`shj serve` を切り離して起動する（`setsid`。標準入出力は閉じ、ログはファイルへ）。ソケットができるまで（最大 5 秒）待ってつなぐ。2 台の GUI が同時に起動しても 1 つになるよう、ソケットのフォルダの中のロックファイル（`flock`）を使う。
   4. 標準入出力とソケットの間を、バイトのままコピーする（プロトコルは解釈しない）。どちらかが閉じたら終わる。
4. **「ローカル」**：`ssh` を挟まず、GUI が同じ `shj attach` を直接起動する。Finder や Dock から起動した macOS のアプリはログインシェルの PATH を引き継がないので、起動のときにログインシェル（`$SHELL -l -i -c`、5 秒で諦める）に PATH を聞き、GUI の PATH と 1 のよく使う場所を足した PATH で `shj` を探す（環境変数 `SHIJIMI_SHJ` があればそれを使う。nightly 版の GUI は `shj-nightly` を先に。入れる手段が無いので版は確かめない）。待つのはメインスレッドの外（`connect` は async のコマンド）。`shj attach` にもこの PATH を渡す（`shj serve` の中のターミナルが引き継ぐ）。
5. **版が違う shj が動いていたら**：`session.hello` の結果で GUI が気づく（前の節）。`attach` は版が違っても動いているサーバーにつなぐ（勝手に入れ替えない）。

セキュリティ：Unix ソケットは 0700 のフォルダの中（自分のユーザーだけ）。`shj serve` はネットワークに待ち受けない。リモートの認証は ssh に任せる。`shj attach` の段階で追加の認証はしない（同じユーザーなら元々シェルを開ける）。

### サーバーモード（`shj serve`）の中身

- `core` をワークスペースごとに持つ（P14 以降）。制御用ソケット（`ctl`）と Claude Code 連携（`ide`）は今と同じようにサーバーに 1 つ持つ。`shj diff` などの CLI は、フォーカスしているワークスペースの `core` に届ける。
- 実装（B11）：`server.Workspace`（`Control` と `IDE`）を実装した `core` を `SetFocus` するとそこへ届く。フォーカスが無いうちは `ctl` も `ide` もエラーを返す。制御用ソケットは TUI と同じ `<pid>.sock` で、`shj serve` が開くターミナルには `SHIJIMI_SOCKET` などの環境変数を渡す。Claude Code のロックファイルのワークスペースはホームディレクトリ。`clipboard.write` と `url.open` は `Server.WriteClipboard` / `OpenURL`（`core.Port`）が今の GUI に通知する。
- ログは `$XDG_STATE_HOME/shijimi-editor/serve.log`（無ければ `~/.local/state/…`）。サイズが 10 MiB を超えたら先頭を捨てる。

### GUI の配り方と自動更新（C8）

- リリースの workflow（`.github/workflows/gui-release.yml`。`release.yml` と `nightly.yml` から呼ぶ）が、Linux の AppImage（x86_64・aarch64）と macOS の署名なしの `.dmg`（universal）を作り、Tauri の updater の `latest.json` と一緒に Release に上げる。
- 自動更新は AppImage と `.dmg` だけ（cargo の feature `updater`。workflow だけが付ける）。Nix で作る版（`nix build .#gui`・home-manager の `programs.shijimi-editor.gui`）は付けないので、更新は `nix flake update` と `home-manager switch` で行う。
- 更新は、起動のときに 1 度だけ調べ、新しい版があれば右下に出し、ユーザーが「更新して再起動」を押したときだけ入れ替える（編集中に勝手に起動し直さない）。調べられなかったときは何も出さない。
- 普通の版は `releases/latest/download/latest.json`（pre-release の nightly は入らない）、nightly 版は pre-release `nightly` の `latest.json` を見る。nightly 版は `tauri.nightly.conf.json` を重ね、名前 `shijimi-editor-nightly` と identifier を変えて普通の版と並べて入れられるようにする。nightly は版の前後を問わず、`latest.json` の版が今と違えば更新とする（`allowDowngrades`）。
- GUI の版は Tauri の設定の `version`（workflow は `tauri build --config`、Nix は `TAURI_CONFIG` で入れる）。リモートに入れる shj の版（上の「ssh 越しに shj を起動する」の 1）もこれを使う。
- 署名鍵は minisign で、パスワードは付けない（秘密鍵は 1Password にしか置かないので、足しても守りは強くならない）。workflow は 1Password のサービスアカウントで、ビルドの直前に読む。公開鍵は `tauri.conf.json` の `plugins.updater.pubkey`。

## 4. あとから足せる余地

- **打った文字だけ先に手元で出す**：`input.*` の `seq` と `Screen.AckSeq` があるので、GUI が「文字を入れた行」を手元で先に描き、`AckSeq` が追いついたら shj の画面に置き換える形にできる。必要になったら `Line` に版を足す。今は作らない。
- **速さが足りないとき**：`encoding` を `msgpack` にする。効くのは `term.output`（base64 が無くなる）、次に `screen.update`。
- **ネイティブの画面**：プロトコルは領域と等幅のマス目の単位で話すので、Rust の画面も同じ `Screen` を描ける。`Style` は意味の名前なので、色はテーマで決まる。
- **新しいメソッド**は `capabilities` で見分ける。メソッドの意味を変えるときは `protocol.major` を上げる。ワークスペースをフォルダから切り離す変更（「ワークスペース」の節）は `workspace.*`・`term.*` の意味と形を変えるので、`protocol.major` を 1 つ上げる（実装は #448）。文言を `Msg` で送る変更（`screen.update` の文言が文字列から `{key, args}` になる）も形が変わるので、`protocol.major` を 3 に上げた（実装は #466）。

## 5. 決めたことと理由

- **変わった分だけ送る**（領域ごとの版 + 行単位の差分 + `screen.get`）：回線が遅くても使えるため。全部送る形にも、`lines.rows` に全部の行を入れれば同じ形のまま退化できる。逆（全部送る形から差分への移行）は形が変わる。
- **`Screen` は意味の名前でスタイルを伝える**：テーマの変更に GUI が追従でき、TUI と GUI の見た目の差を描く側に閉じ込められる。
- **ターミナルは `Screen` に入れない**：`ui/tui/vt` を GUI に持ち込まず、coneko-term の機能をそのまま使える。
- **ワークスペースごとに `core` を持つ**：「開いたファイルはワークスペースごとに覚える」を、状態の切り替えではなくインスタンスを分けることで満たす。メモリは増えるが、ワークスペース数は少ない。
- **ツリーは `Screen` と別の API**：GUI は複数のワークスペースのツリーを同時に持ち、開閉は GUI の状態だから。
- **`shj attach` と `shj serve` を分ける**：ssh が切れても状態を残し、つなぎ直しを同じ流れ（`attach` を再実行）にするため。
- **framing は改行区切りの JSON**：ssh の標準入出力に載せやすく、ACP・制御用ソケットと同じ。MessagePack にするときは長さ付きにする。
- **版が違う shj を勝手に入れ替えない**：動いているシェルが消えるため。
- **ワークスペースの消え方**：[×]（`workspace.close`）でしか消えない。シェルがいなくなっても、ファイルが無くなっても消えない。理由：`cd` はプロジェクトの切り替えで、フォルダが変わるのはワークスペースが替わるのではなく同じ作業の場所が移るだけ。前の設計（シェルもファイルも無くなったら消える）は、`cd ~` や `exit` で、並べたワークスペースが勝手に消えてサイドバーの並びが動いた。ユーザーが作ったものは、ユーザーが閉じるまで残す。
- **ワークスペースをフォルダから切り離す**（`workspaceId` をパスから作らない）：同じプロジェクトにワークスペースを 2 つ並べたい（別のブランチの作業、別のターミナルの使い方）。フォルダが ID だと 1 つにしかできず、`cd` のたびに ID が変わって帯が消えて増える。
- **フォルダはプライマリターミナルの cwd だけから決める**：どのターミナルの cwd からでも決めると、分割したターミナルで `cd` するたびにワークスペースが動き、`git log` を見に別のフォルダへ寄っただけで開いているファイルが閉じる。IDE モードでもターミナルモードでも同じシェルを指すので、ユーザーに分かりやすい。
- **`cd ~`・`cd /` で切り替えない**：プロジェクトの外へ出ただけでファイルを閉じない。次にプロジェクトに入ったときに切り替わる。
- **`cd` のときの保存**：自動保存の 1 秒を待たずに保存して閉じる（待つと、閉じられるファイルの変更が失われる）。自動保存を切っている人にだけ「保存か捨てるか」を設定に必ず書かせる（どちらも黙って選ぶと、データを失うか、勝手に書き換えるため。既定値を置かない）。
- **`cd` でまとめない**：行き先のフォルダにワークスペースがあっても、勝手に 1 つにしない（ワークスペースは [×] でしか消えず、1 対 1 でもないため。2 つに見えるのは、ユーザーが作ったとおり）。
- **同じファイルのバッファは 1 つで共有する**：別々に持つと、2 つのワークスペースで同じファイルを開いて編集したときに、後から保存したほうが先の変更を消す。共有なら 1 文字ずつ両方に出る。undo の履歴も共有になる。
- **プライマリターミナルと分割したターミナル**：どのワークスペースにも、フォルダを決める 1 つのシェルが必ずある（フォルダ未定でも）。プライマリターミナルの `exit` で欄を閉じないのは、閉じるとフォルダを決めるシェルがいなくなり、IDE モードの右下が空になるため。
- **`protocol.major` を上げる**：`workspaceId` の作り方、`term.create` の形、`workspace.list` の形が変わり、古い GUI は正しく動かないため。
- **`workspace.close_files`・`term.cwd` は消す**：前者は「帯だけ残してファイルを閉じる」ためのもので、ワークスペースが勝手に消えなくなったので要らない。後者は、どのターミナルの cwd でもワークスペースが決まった前の設計のためのもの。
- **マシンの一覧は GUI が持つ**：`shj serve` はマシンの一覧を知らない（自分のマシンのことしか知らない）。「ローカル」の shj も、足した ssh の先の shj も、同じプロトコルで同じように話す。
- **設定ファイルの間違いで起動しない**：知らない項目を黙って捨てると、`start_dir` のつづりを間違えたときに `~` で始まり、原因が分からない。
- **名前の無いファイルを作らない**：ワークスペースがフォルダ未定にもなるので、名前の無いファイルの保存先が決まらない。
- **core と UI の境目は TUI と GUI で同じ形にし、違うのは運び方だけにする**：core が TUI 専用の機能（ターミナルのパネル、マルチプレクサ、境目のドラッグ、OSC 52、レイアウトの状態）を持つと、GUI のアダプターがそれを空の実装で埋めることになり、core が UI の違いを知ってしまう。UI が増えたり変わったりするたびに core を直すことにもなる。そのため core は Port（「1. 中身と TUI の描画の境目」の「core が知る相手は Port だけ」）だけを知り、TUI 専用のものは tui に出す。Port のメソッドは、どの UI でも同じ意味で、戻り値を待たない形に限る。

## 6. GUI の残りの作業（起票する Issue の一覧）

この文書がマージされたあと、この一覧を Issue にする。1 つが 1 PR の大きさ。親は #271。

**ワークスペースをフォルダから切り離す変更**（「ワークスペース」の節の 1〜18）は、次の Issue で進める（下の表の B7・C5・D1・F1〜F4 は、これらが済んだあとの形で作る）。

| Issue | 中身 | 設計書の番号 |
| --- | --- | --- |
| #446 | 設定ファイルに間違いがあれば起動せず、場所・行・理由を出す | 17 |
| #447 | 名前の無いファイルを作れなくする（`:new` に名前を必須にする） | 18 |
| #448 | shj：ワークスペースをフォルダから切り離し、プライマリターミナルの `cd` でフォルダを切り替える（`workspace.create`・`workspace.close`・`term.restart`、`protocol.major` を上げる） | 1〜7、10、11 |
| #449 | 同じファイルを複数のワークスペースで開いたら、メモリの写しを 1 つにして共有する | 8 |
| #450 | shj serve：ワークスペースの一覧を保存し、次に起動したときに戻す | 9 |
| #451 | GUI：「ホストを開く」を「+ マシンを足す」にし、足したマシンだけをサイドバーに出す | 12〜14、16 |
| #452 | GUI：マシンの見出しの [+] でワークスペースを作り、[×] で閉じ、ターミナルをワークスペースごとに出す | 2、7、10、11 |
| #453 | GUI：手元の `config.toml` の `[[gui.machines]]` で既定のマシンを出す | 15 |

### A. `internal/ui` の切り離し

手順 P1〜P14（「2. 分けていく順番」）をそのまま Issue にする（表の 1 行が 1 つの Issue）。

### B. shj のサーバーモード

| ID | タイトル | 依存 | 中身 |
| --- | --- | --- | --- |
| B1 | `ui/gui/rpc`：JSON-RPC の型とメッセージの読み書き | なし | 改行区切りの JSON、要求・通知・応答・エラー、`encoding` の差し替え口、テスト用のパイプ |
| B2 | `shj serve`：`session.hello` / `bye` / `ping` / `server.info` | B1 | 画面を持たないプロセス、Unix ソケット、版の確認、`serverId` |
| B3 | `shj attach`：切り離して起動する・つなぎ直す・橋渡し | B2 | `@@shj-rpc 1@@`、`setsid`、`flock`、ソケットへのコピー |
| B4 | 7 日で止まる + `config.toml` の `[server]` | B2 | `lastClientAt`、`idle_stop_days`、`server.shutdown`、未保存の扱い |
| B5 | 引き継ぎ（後からつないだ GUI が勝つ） | B2 | `session.superseded`、`not_owner` |
| B6 | ターミナル管理と `term.*` | B2 | PTY、リングバッファ、`term.ack` の流量制御、`term.attach` |
| B7 | ワークスペースの決定と `workspace.*` | B6 | cwd の取得（Linux / macOS）、フォルダ探し、`workspace.changed`（フォルダの切り離しは #448 で作り直す） |
| B8 | ツリーと git の印：`tree.*`・`git.*` | B7 | 1 階層の一覧、監視、`git.changed`、作成 / 名前変更 / 削除 |
| B9 | 画面の配信：`view.*`・`screen.*`・`theme.get`・`i18n.get`・`blob.get` | P9、P14、B7 | 購読、差分、`ack`、まとめて送る |
| B10 | 入力：`input.*`・`command.run`・`file.open` | P5、B9 | `seq`、IME、マウス（ペイン内の座標） |
| B11 | 制御用ソケットと Claude Code 連携をサーバーモードに載せる | P7d、P7e、B2 | `shj diff` などが動く。`clipboard.write` と `url.open` の通知 |

### C. Tauri アプリの土台

| ID | タイトル | 依存 | 中身 |
| --- | --- | --- | --- |
| C1 | Tauri の雛形、Web 画面のビルド、CI | なし | Linux / macOS でビルド、`nix build` |
| C2 | プロトコルのクライアント（TypeScript） | B1 | 型、要求と応答の対応、通知 |
| C3 | ssh で shj につなぐ | B3、C2 | `ssh` の起動、`~/.ssh/config` のホスト一覧、askpass を GUI で受ける |
| C4 | 自動で再接続、状態の表示 | C3 | 切れたときの再接続、`screen.get`、一覧の状態 |
| C5 | 前回ワークスペースがあったマシンへの自動接続 | C3 | 前回の記録の保存、起動時の接続（足したマシンの一覧は #451。ワークスペースの一覧の保存は shj の側で #450） |
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
| F1 | coneko-term で 1 つ出す（IDE モードの右下） | B6、C2 | `term.*`、流量制御、大きさ |
| F2 | ワークスペースの切り替えでターミナルも切り替える | B7、D1、F1 | プライマリターミナルに切り替える（#452 で作り直す） |
| F3 | ターミナルモード：カードの入れ替え | F1 | ``Ctrl+Shift+` ``、約 0.3 秒の動き |
| F4 | ターミナルの自動分割と操作 | F3 | 2 個は左右、3〜4 個は 2×2、5〜6 個は 3×2。`Ctrl+Shift+T`・矢印、分割したターミナルの `exit` で閉じる（プライマリは閉じない。#452） |

### 進める順番

B1・B2・C1・P1・P2 が最初に始められる。P の系列と B の系列はほぼ独立なので並行できる。E と F は B9 / B6 が済んでから。
