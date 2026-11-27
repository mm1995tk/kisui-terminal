# Window の画面のコードの配置（`app/src/`）

kisui-terminal の Dialog（`app/`）の画面（Solid + TypeScript）を、どこに何を置くかと、どちら向きに依存してよいかの決まり。#313 で決めた（親は #312）。

- 仕組みは Solid + TypeScript + Vite のまま。DDD の 4 層は持ち込まない。
- Rust（`app/src-tauri/`）と、Go の `kisui`・shijimi-editor との取り決め（`docs/protocol.md`）は、この配置の外にある。
- ファイルを足す・移すときは、この文書の決まりに合わせる。決まりの一部は、テストが見張る（下の「テストが見張ること」）。

## 3 つの置き場

| 置き場            | 持つもの                                                               | 例                                                                 |
| ----------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `ui/`             | 表示と入力。画面の部品、専用の CSS、表示用の状態、キーの受け取り       | サイドバー、ターミナルのペイン、Dialog、境目のドラッグ、キーの行き先   |
| `features/`       | 機能の状態・操作・規則。画面にも Tauri にも触らない                    | 接続、ワークスペースとタブ、ブラウザのタブのページ、ツリー、コマンドの表 |
| `infrastructure/` | 外とのやりとりの実装                                                   | Tauri の殻の命令と知らせ、kisui serve との JSON-RPC、webview の記録 |

`index.tsx` は起動と、外への頼みの本物の組み立てだけを持つ。`i18n/` は画面の文の表、`assets/` は同梱する字。

## 配置

```text
app/src/
  index.tsx                 # 起動と、外への頼みの本物（infrastructure/）の組み立て
  ui/
    ports.ts                # 画面が外に頼むことの束（Ports）と、それを部品に配る文脈
    main-window/            # メインウィンドウ
      page.tsx              # 入口。機能の持ち物と表示用の状態を作り、部品を並べる（動きは書かない）
      layout.tsx            # 割り付け（サイドバー・境目のつまみ・右のペイン・上に重ねるもの）
      layout.css
      keys.ts               # 受けるキー（リーダー・Shortcut・リサイズモード）
      focus.ts              # キーの行き先を移す（ターミナル・ページ・ツリー・CHANGES）
      paneResize.ts         # 境目の大きさとサイドバーの開閉（値の決まりは panes.ts）
      sidebar/
        Sidebar.tsx
        workspaces/         # Workspace band と、中のタブの行
        file-tree/          # ツリー、メニュー、ファイル操作の Dialog
        db-tree/            # DB のタブを出している間にファイルツリーの場所に出す、スキーマの木
        changes/
      content/
        ContentArea.tsx
        terminal/
        browser/            # URL バー、ページ内検索、ブックマーク、新しいタブのページ
        db/                 # DB のタブの画面（SQL の入力欄と結果の表。#347）
        proxy/              # プロキシのパネル（通信の一覧と中身。#409）
        media/              # 画像、動画、PDF
      sessions/             # 接続先を足す・管理する・認証の Dialog
      workspaces/           # Workspace switcher、作る・閉じるときの Dialog
      tab-window/           # 今出しているタブの種類ごとの Dialog（リーダーの a）。種類の出し分けと、ターミナルのタブの Dialog（#457）・DB のタブの Dialog（#458）・ブラウザのタブの Dialog（#459）
      db/                   # DB の接続を選ぶ Dialog、DB のパスワードを聞く Dialog（#347）
      clipboard/            # メインウィンドウの中の履歴の Dialog・読み取りの許可の確認
      file-transfer/
      mascot/
      notifications/        # 右下の知らせ、トースト、新しい版の知らせ
      commands/             # リーダーの案内、キーの一覧
    utilities/              # ほかのアプリを使っている間でも、デスクトップから呼び出す常駐ツール
      clipboard/
        page.tsx            # クリップボードの履歴の小さな Dialog（今あるのはこれだけ）
    modules/                # 画面をまたいで使う、機能の知識を持つ部品
      clipboard-history/
        HistoryPanel.tsx    # 履歴の一覧（メインウィンドウの Dialog と、常駐ツールの Dialog の両方が使う）
    components/             # 機能の知識を持たない部品（ボタン、ダイアログの枠と中の部分、入力欄、その場の入力欄）。決まりは design-system.md
    styles/                 # 共通の色・余白・字（theme.css はパレット、tokens.css は役割の名前、字の定義）
  features/
    sessions/               # 接続（Session）、マシンの記録、接続の状態の文
    workspaces/             # GUI のワークスペース、フォーカス、サイドバーの行の組み立て、CLI の `kisui workspace` の受け持ち（`workspaceCommands.ts`）、CLI の `kisui pane focus` などの受け持ち（`paneCommands.ts`）
      tabs/                 # 中のタブ（ターミナル・ブラウザ・DB）の追加・削除・並び順・選択、CLI の `kisui tab` の受け持ち（`tabCommands.ts`）
    browser/                # ブラウザのタブ 1 つずつのページの操作、ブックマーク、ダウンロード、CLI の `kisui browser` の受け持ち（`browserCommands.ts`）
    db/                     # DB のタブ（#347）の中身：書きかけの SQL、SQL の実行と結果、接続の一覧、パスワードを聞く
    proxy/                  # プロキシのパネル（#409）：タブの通信を kisui serve のプロキシに通す、一覧と中身
    terminal/               # ターミナルのペイン（分割の木、ペインの中身のつなぎ）
    file-tree/
    changes/
    clipboard/
    file-transfer/
    mascot/
    updates/
    scale/                  # 表示の大きさ
    commands/               # コマンドの表（リーダーと Shortcut）、キーの書き方、コマンドを動かす、Window に頼む CLI の受け口（`windowRun.ts`。#511）
    compose.ts              # 機能の持ち物（各 controller）を作って、互いをつなぐ
    keyValueStore.ts        # 小さな記録の読み書きの受け口（機能をまたいで使う）
    problem.ts              # 「できなかったこと」の知らせの形（機能をまたいで使う）
  infrastructure/
    tauri/                  # TypeScript から Rust（app/src-tauri/）を呼ぶ受け口
    rpc/                    # kisui serve との JSON-RPC（取り決めの型・エラーコード・クライアント）
    storage/                # webview の localStorage
  i18n/
  assets/
```

置き場の名前についての決まり：

- `ui/main-window/` はメインウィンドウ全体。`ui/utilities/` は常駐ツールの画面で、今あるのはクリップボードの履歴だけ。メインウィンドウの中の Dialog（ダイアログ）は `utilities/` に置かない。
- 画面全体の分け方の名前に、`workspace`（アプリのワークスペースと取り違える）・`workbench`・`global`・`popups`・`daemon`・`screens` は使わない。`ui/main-window/workspaces/` と `ui/main-window/sidebar/workspaces/` は、アプリのワークスペースそのものの部品なので、この名前でよい。
- `layout.tsx` と `page.tsx` は置き方の決まりで、Next.js や自動のルーティングを入れたのではない。`layout.tsx` は割り付けだけ、`page.tsx` は何を出すかを持つ。
- `features/workspaces/tabs/` は、ターミナルのタブ・ブラウザのタブ・DB のタブを合わせたタブ全体の、追加・削除・並び順・選択を持つ。`features/browser/` は、ブラウザのタブ 1 つずつのページの操作・ブックマーク・ダウンロードを持つ。`features/db/` は、DB のタブ 1 つずつの中身（書きかけの SQL・結果）と SQL の実行を持つ。
- `file-tree` と `file-transfer` は別のもの（サイドバーのツリーと、ターミナルのファイル転送）。

## 部品をどこに置くか

- 部品、専用の CSS、表示用の状態、テスト、Storybook の stories は、使う所の近くに置く（同じフォルダ）。stories の足し方は [storybook.md](storybook.md)。
- 同じ画面の中で 2 か所が使う部品は、その 2 か所にいちばん近い共通の親のフォルダに置く。例：タブの行（`sidebar/workspaces/TabRow.tsx`）は、サイドバーと Workspace switcher が使う。
- 画面をまたいで使う部品のうち、機能の知識を持つもの（履歴の一覧など）だけを `ui/modules/` に置く。機能の分け方をそのまま `ui/modules/` に写さない。
- 機能の知識を持たないボタン・入力欄・ダイアログの枠・メニューは `ui/components/`、共通の色・余白・字は `ui/styles/` に置く。値・状態・部品の使い方の決まりは [design-system.md](design-system.md)。
- スクロールの位置・キーの行き先・Dialog や欄の開閉のような表示用の状態は、画面の近く（`ui/`）に残す。機能の規則を画面の部品に戻さない。

## 依存の向き

```text
index.tsx ──▶ ui ──▶ features ◀── infrastructure
    │                                  ▲
    └──────────────────────────────────┘
```

- `ui/` は `features/` の状態と操作を使う。
- `features/` は、`ui/` にも、`infrastructure/tauri/`・`infrastructure/storage/` にも、Tauri の API（`@tauri-apps/*`）にも依存しない。
  - 例外は `infrastructure/rpc/` だけ。kisui serve との取り決め（型・エラーコード）と、輸送路を受け取って動く JSON-RPC のクライアントで、Tauri に触らない。輸送路（殻への読み書き）は `ShellApi` で受け取る。
- 外への頼みは、機能の近くにインターフェースを置き、`infrastructure/` がそれを満たす。本物を選んで渡すのは `index.tsx` だけ。

| 頼むこと                         | インターフェース（機能の近く）                          | 本物                                   |
| -------------------------------- | ------------------------------------------------------- | -------------------------------------- |
| 接続（ssh・kisui attach）と設定  | `features/sessions/shell.ts` の `ShellApi`              | `infrastructure/tauri/shell.ts`        |
| 小さな記録                       | `features/keyValueStore.ts` の `KeyValueStore`          | `infrastructure/storage/localStorage.ts` |
| 内蔵ブラウザのタブ               | `features/browser/os.ts` の `BrowserOs`                 | `infrastructure/tauri/browser.ts`      |
| OS のクリップボード              | `features/clipboard/clipboardBridge.ts` の `ClipboardOs` | `infrastructure/tauri/clipboard.ts`    |
| クリップボードの履歴・履歴の Dialog   | `features/clipboard/history.ts` の `ListClipboardHistory`・`ClipboardPopupOs` | `infrastructure/tauri/clipboardHistory.ts` |
| ターミナルのファイル転送         | `features/file-transfer/transfer.ts` の `TransferOs`    | `infrastructure/tauri/transfer.ts`     |
| OS の通知                        | `features/terminal/notify.ts` の `ShowOsNotification`   | `infrastructure/tauri/notify.ts`       |
| 外部ブラウザ                     | `features/terminal/urlOpen.ts` の `OpenUrlExternally`   | `infrastructure/tauri/openUrl.ts`      |
| 表示の大きさ                     | `features/scale/scale.ts` の `ApplyScale`               | `infrastructure/tauri/scale.ts`        |
| キャラクター                     | `features/mascot/mascot.ts` の `MascotOs`               | `infrastructure/tauri/mascot.ts`       |
| 新しい版                         | `features/updates/store.ts` の `UpdatesOs`              | `infrastructure/tauri/updates.ts`      |

`index.tsx` はこれらを `Ports`（`ui/ports.ts`。機能が使う分は `features/compose.ts` の `FeaturePorts`）にまとめて、メインウィンドウの `page.tsx` に渡す。`page.tsx` は機能の持ち物を作るときに引数で渡し、奥の部品（ターミナルのペインなど）には文脈（`usePorts()`）で配る。Tauri の無い所（テスト・Storybook。[storybook.md](storybook.md)）では、偽物を渡せば動かせる。

## メインウィンドウの組み立て

機能の持ち物（`features/` の `create…`）を作って互いをつなぐのは `features/compose.ts` の `createFeatures`。`ui/main-window/page.tsx` はそれを呼び、この画面の表示用の状態（`keys.ts`・`focus.ts`・`paneResize.ts`・知らせ・Dialog の開閉）を作り、部品に渡す。どちらにも動きは書かない。

| 持ち物                                            | 受け持つこと                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| `features/sessions/controller.ts`                 | マシンを足す・外す・名前を変える、つなぐ・切る・つなぎ直す、ssh の質問       |
| `features/workspaces/controller.ts`               | ワークスペースのフォーカス、作る・閉じる・移る・並べ替える・名前を変える     |
| `features/workspaces/tabs/controller.ts`          | タブを足す・閉じる・選ぶ・並べ替える・名前を変える                           |
| `features/browser/tabsStore.ts`・`pages.ts`       | ブラウザのタブの中身、URL を開く、ページが開いた・閉じた Dialog、ページ内検索     |
| `features/browser/bookmarksStore.ts`・`downloads.ts` | ブックマーク、ダウンロード                                                |
| `features/db/controller.ts`                       | DB のタブの中身（書きかけの SQL・結果）、接続を選ぶ Dialog、SQL の実行と取り消し、パスワードを聞く |
| `features/proxy/controller.ts`                   | 今のタブをプロキシに通す・やめる、パネルの開閉、通信の一覧と選んだ通信の中身（#409）、要求を書き換えて送り直す（#410）、要求を途中で止めて流す・書き換える・捨てる（#411） |
| `features/terminal/controller.ts`                 | フォーカスしているワークスペースのペイン、隠す・分ける                       |
| `features/file-tree/controller.ts`・`features/changes/controller.ts` | ツリーと CHANGES の中身と操作                              |
| `features/commands/run.ts`                        | コマンドの表のコマンドを動かす（リーダーの葉と Shortcut）                         |
| `features/commands/windowRun.ts`                  | Window に頼む CLI（`kisui tab`・`kisui workspace`・`kisui browser`・`kisui pane focus` など）を、名前ごとの受け持ちに渡す（#511）    |

持ち物どうしは互いを呼ぶ（接続の知らせでフォーカスを直す、など）。先に作る側には、後で作る側を呼ぶ関数を渡す（`compose.ts` の `hooks` や `() => …`）。機能が画面の側に頼むこと（キーを向ける・スクロールを戻す・Dialog を出す）は、`FeatureUi`・`CommandUi` の形で `page.tsx` が渡す。

画面から、対応する部品・機能・外への頼みをたどる例：

| 画面                         | 部品（`ui/main-window/`）                   | 機能（`features/`）                             | 外への頼み                         |
| ---------------------------- | ------------------------------------------- | ----------------------------------------------- | ---------------------------------- |
| サイドバーの帯とタブの行     | `sidebar/workspaces/`                       | `workspaces/`・`workspaces/tabs/`               | `KeyValueStore`、`ShellApi`        |
| ファイルツリー               | `sidebar/file-tree/`                        | `file-tree/`                                    | `ShellApi`（kisui serve へ）       |
| CHANGES                      | `sidebar/changes/`                          | `changes/`                                      | `ShellApi`                         |
| ターミナルのペイン           | `content/terminal/`・`content/media/`       | `terminal/`・`clipboard/`・`file-transfer/`     | `ClipboardOs`・`TransferOs`・`ShowOsNotification` |
| ブラウザのページ             | `content/browser/`                          | `browser/`                                      | `BrowserOs`                        |
| プロキシのパネル             | `content/proxy/`                            | `proxy/`                                        | `ShellApi`（kisui serve へ）・`BrowserOs` |
| マシンのダイアログ・足す Dialog   | `sessions/`                                 | `sessions/`                                     | `ShellApi`                         |
| Workspace switcher | `workspaces/`                               | `workspaces/`                                   | `KeyValueStore`                    |
| リーダーの案内・キーの一覧   | `commands/`、キーを受けるのは `keys.ts`     | `commands/`                                     | —                                  |
| タブの種類ごとの Dialog（ターミナルのタブの Dialog） | `tab-window/`                 | `commands/`（種類の決め方）・`terminal/`（ペインの地図と操作） | `ShellApi`（kisui serve へ）       |
| タブの種類ごとの Dialog（DB のタブの Dialog）           | `tab-window/`                 | `commands/`（種類の決め方）・`db/`（結果のタブの行と、タブの操作） | `ShellApi`（kisui serve へ）       |
| タブの種類ごとの Dialog（ブラウザのタブの Dialog）     | `tab-window/`                 | `commands/`（種類の決め方と、ページへの操作 `runBrowserOn`）・`browser/`（操作の行と、今できない理由） | `BrowserOs`                        |
| クリップボードの履歴         | `clipboard/`、常駐ツールは `ui/utilities/clipboard/` | `clipboard/`                           | `ListClipboardHistory`・`ClipboardPopupOs` |

## CSS の並び

CSS は部品ごとのファイルに分けてあり、ビルドすると、部品を import した順に並ぶ。同じ強さの規則は後のものが勝つので、CSS を持つ部品の import の順を変えると、見た目が変わりうる。順を保つ所には、コメントで書いてある（`page.tsx`・`content/ContentArea.tsx`・`sidebar/Sidebar.tsx`・`sidebar/Panes.tsx`）。

## テストが見張ること

| テスト                                            | 見張ること                                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `app/src/architecture.test.ts`                    | 依存の向き（`features/` は画面と外の実装に依存しない、Tauri の API は `infrastructure/tauri/` だけ、本物を組み立てるのは `index.tsx` だけ、など） |
| `app/src/ui/main-window/cssOrder.test.ts`         | メインウィンドウの CSS の並び                                                                |
| `app/src/features/compose.test.ts`                | 機能の持ち物のつなぎ。偽の殻（kisui serve の代わり）につないで、接続 → フォーカス、作る・閉じる → 移る、タブ → ブラウザのページ、shj の頼み → 画面、の流れが通ること |
| `app/src/features/commands/ime.test.ts`           | `app/src/` のどのファイルも、かな漢字変換のキーを `isComposingKey` で見分ける                |
| `app/src/ui/windowShow.test.ts`                   | Dialog の `<Show>` が `keyed`（閉じる操作が機能の持ち物にあるものも見る）                         |

ソースを読むテスト（`architecture`・`ime`・`windowShow`）は、どれも `app/src/` の全部を読む。ファイルを移しても、見る範囲から外れない。
