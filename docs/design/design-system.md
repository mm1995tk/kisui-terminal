# デザインシステムの基礎（Window の画面）

kisui-terminal の Dialog（`app/src/`）の、共通の色・余白・字・状態と、共通の部品の使い方の決まり。#315 で作った（親は #312）。

- 基準は実装。値は `app/src/ui/styles/tokens.css`、部品は `app/src/ui/components/` にあり、アプリと Storybook（[storybook.md](storybook.md)）は同じものを読む。見本だけの部品は作らない。
- この文書は、実装に書けないこと（何に使うか・使わないか・意味）を持つ。値そのものは書き写さない（`tokens.css` と Storybook の `styles/Tokens` を見る）。
- 画面全体の点検の結果と、画面をまたぐ共通ルールは [ui-ux-review.md](ui-ux-review.md)（#306）。まだ決まっていないことは、下の「#306 との対応」に「未確定」と書き、今の見た目と手順のまま残す（案は ui-ux-review.md の 5 章）。

## 最初のセットと、後に回したもの

最初のセットは「Dialog（カード）とボタン」。真ん中に出す Dialog と右下の知らせは 18 のファイルで使われ、いちばん広く共有されている。
そのうち、意味の決まりが #306 の未確定に触れないものだけを、部品として決めた。

| 入れたもの             | 実装                                                        | Storybook                                                     |
| ---------------------- | ----------------------------------------------------------- | ------------------------------------------------------------- |
| 共通の値               | `ui/styles/tokens.css`（読み取りは `tokens.ts`）            | `styles/Tokens`（色・状態・余白・字・角）                     |
| 状態の決まり           | `tokens.css` の `--state-*`・`--connection-*`、この文書     | `styles/Tokens/States`、`components/Button` の各状態           |
| ボタン                 | `ui/components/Button.tsx`・`button.css`                    | `components/Button`                                           |
| Dialog の枠と中の部分       | `ui/components/Card.tsx` の `ModalCard`・`CardBody`・`CardTitle`・`CardText`・`CardError`・`CardActions`、`card.css` | `components/ModalCard`                    |
| 入力欄（形だけ）       | `ui/components/Field.tsx` の `Field`・`Input`               | `components/Field`                                            |
| その場の入力欄         | `ui/components/InlineInput.tsx`・`inline-input.css`         | `components/InlineInput`                                      |
| キー操作のヒント       | `ui/components/KeyHints.tsx` の `KeyHints`・`Kbd`、`key-hints.css` | `main-window/sessions/MachineDialog` など、ヒントのある Dialog |
| Dialog の Key footer（共通フッタ） | `ui/components/KeyFooter.tsx` の `KeyFooter`（#306）          | 同上                                                          |
| 組み合わせた Dialog         | 下の「組み合わせの例」の Dialog                                  | `main-window/…`                                               |

Dialog と知らせの下のボタンは `Button` を使う（`button` に CSS のクラスを付けて直に書かない）。Dialog の中の見出し・本文・ボタンの並び・入力欄も、`Card.tsx` と `Field.tsx` の部品を使う。

`ui/components/` には、1 つの役目の部品（ボタン・Dialog の枠と中の部分・入力欄・その場の入力欄・キー操作のヒント）だけを置く。部品を組んだ Dialog（ワークスペースを閉じる確認など）は、使う所（`ui/main-window/…`）に置く。

名前を変える操作（ワークスペース・タブ・マシンの名前、ファイルツリーの名前の変更と新しいファイル・フォルダ）は、Dialog を出さず、名前を出している行をその場の入力欄（`InlineInput`）にして行う。Enter で決め、Esc でやめ、フォーカスが外れてもやめる。断られたら、入力欄の下に理由を出し、開けたままにする。

「どのキーで何をするか」のヒントは、どこでも `KeyHints` で出す（キーを並べたあとに何をするかの字。項目は横に流して折り返す）。Dialog では、Key footer（`footer`）に `KeyFooter` を置き、今効く操作を見出し付きの行で出す（下の「共通フッタ」）。行の中にキーを 1 つだけ出すとき（閉じる確認の `y` `n` など）は `Kbd` を使う。`kbd` に CSS のクラスを付けて直に書かない。

後に回したもの（順は決めていない。サイドバーとワークスペースの Issue（#303・#311・#307・#308）で使う所から進める）：

| 部品                                       | 今の実装                                | 後に回した理由                                                 |
| ------------------------------------------ | --------------------------------------- | -------------------------------------------------------------- |
| 入力の失敗の伝え方                         | `Field`・`Input` と `CardError`           | #306 の「入力に失敗したときの説明」が未確定。部品は形だけで、見た目は今のまま |
| エラーの文の色                             | `CardError`                             | 色（警告の黄か失敗の赤か）が未確定                             |
| Dialog の一覧の行                               | `.card-row`・`.card-rows`               | 選択とフォーカスの見せ方が未確定                               |
| 状態の丸                                   | `.state-dot`                            | サイドバーの見出しと合わせて決める                             |
| チェックボックス・小さいアイコンのボタン   | `.card-check`                       | 使う所が 1〜2 か所。増えたときに部品にする                     |
| 右下の知らせ                               | `Notices.tsx`（`.card-notice`）         | 知らせは Esc で閉じる Dialog ではない。閉じる操作の形は未確定       |
| サイドバーの帯・タブの行・境目             | `sidebar/`                              | 境目の見た目は #303 で決めた（`PaneBorder.stories.tsx`）。帯・タブの行は #311 |

`tokens.css` の外の CSS（サイドバー・ツリー・ブラウザなど）は、まだパレット（`--gh-*`）を直に読む。その部品を直すときに、役割の名前に移す。

## 置き場

| ファイル                                | 持つもの                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------- |
| `ui/styles/theme.css`                   | パレット（生の色。GitHub Dark）。`--gh-*`                                              |
| `ui/styles/tokens.css`                  | 役割の名前（色・状態・接続の状態・余白・字・角）。各値のすぐ上のコメントが説明          |
| `ui/styles/tokens.ts`                   | `tokens.css` の読み取り（Storybook とテストが使う）                                    |
| `ui/styles/Tokens.stories.tsx`          | `tokens.css` の名前・値・説明を並べる                                                  |
| `ui/styles/tokens.test.ts`              | 下の「テストが見張ること」                                                             |
| `ui/components/Button.tsx`・`button.css` | ボタン                                                                                |
| `ui/components/Card.tsx`・`card.css`    | Dialog の枠（`ModalCard`）と、カードの中の部分（`CardBody`・`CardTitle`・`CardText`・`CardError`・`CardActions`） |
| `ui/components/Field.tsx`               | 入力欄（`Field` がラベル、`Input` が 1 行の入力）                                       |
| `ui/components/InlineInput.tsx`・`inline-input.css` | その場の入力欄（一覧の行の名前を、その行の中で変える）                         |
| `ui/components/KeyHints.tsx`・`key-hints.css` | キー操作のヒント（`KeyHints`）と、キー 1 つ（`Kbd`）                            |
| `ui/components/KeyFooter.tsx`           | Dialog の Key footer（共通フッタ）の中身（知らせ・今効く操作の行）                 |

`theme.css` と `tokens.css` は、起動のとき `index.tsx` が読む（Storybook では `.storybook/preview.tsx`）。

## 共通の値

部品の CSS は、パレット（`--gh-*`）ではなく `tokens.css` の名前を使う。値を足すときは、すぐ上に説明のコメントを 1 つ書き、`== 見出し ==` のコメントの下に置く（Storybook はそのコメントを説明として出す）。

### 色

| 名前の頭        | 何に使うか                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------- |
| `--color-`      | 地（`bg`・`surface`・`field`）、字（`text`・`text-strong`・`text-muted`・`text-dim`）、縁、主の操作（`accent`）、幕 |
| `--shadow-`     | 後ろを触れたまま重ねるものの影                                                                      |
| `--state-`      | 状態（下の「状態」）                                                                                |
| `--connection-` | 接続の状態（状態の丸）                                                                              |

- Dialog の地（`--color-bg`）の上の本文は `--color-text`、カード（`--color-surface`）の中の字は `--color-text-strong`。
- 補いの字（ラベル・説明・状態の文）は `--color-text-muted`。さらに退かせるもの（未接続）だけ `--color-text-dim`。
- `--color-accent` は主の操作の地と、Focus frame にだけ使う。強調したいだけの字には使わない。
- マシンの色（`--machine-color`。`colors.ts` が決め、画面が style で入れる）は、どのマシンのものかを表す。状態の色としては使わない。

### 余白・角

- 余白は `--space-2`・`4`・`6`・`8`・`10`・`12`・`16`・`20`（数は px）から選ぶ。モックの寸法（px）とそのまま対応させるため、名前に数を入れた。
- 角の丸みは `--radius-4`（キーの印）・`6`（小さいアイコンのボタン）・`8`（ボタン・入力欄・行）・`12`（カード）。
- ボタンの高さ（44px）・入力欄の高さ（40px）・Window の幅（560px）は、その部品の CSS に置く（ほかで使わないため）。

### 字

- 画面の字は `--font-ui`（IBM Plex Sans JP。`fonts.ts` で同梱）。コマンド・パス・長いエラー・ターミナルからコピーした字は `--font-mono`（ターミナルと同じ並び）。
- 大きさは役割で選ぶ：`--text-title`（Dialog の見出し）・`--text-input`（入力欄に打つ字）・`--text-body`（本文。画面の既定）・`--text-caption`（ラベル・補い・等幅）・`--text-label`（一覧の見出し・キーの印）。
- 太さは `--weight-regular`（本文）と `--weight-strong`（見出し・主ボタン・選んでいる行）の 2 つ。`fonts.ts` は 700 も読むが、Window の画面では使っていない。
- 折り返す本文の行の高さは `--leading-text`。

## 状態

状態は意味で決める。部品は、必要な状態だけを持つ（すべての状態を、どの部品にも足さない）。

| 状態     | 意味                                               | 今の見せ方（値）                                                                 | 持つ部品（最初のセット）           |
| -------- | -------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------- |
| 通常     | 押せる・読める                                     | —                                                                                | ボタン                             |
| hover    | 押せるものの上にポインタがある                     | 地を `--state-hover-bg` に（主ボタンは `--color-accent-hover`）。押せないときは変えない | ボタン                             |
| フォーカス | キーの行き先                                     | キーボードで移ったときだけ（`:focus-visible`）枠 `--state-focus-ring`（太さ・間も `--state-focus-ring-*`）。入力欄は内側 1px の枠 | ボタン、Dialog の枠（focusSelf の Dialog そのものは枠を出さない） |
| 選択     | 一覧の中で、操作の対象として選んでいる             | Dialog の一覧の行：地 `--state-selected-bg`、枠 `--state-selected-outline`、太字        | （後に回した Dialog の一覧の行）         |
| 無効     | 今は押せない                                       | 濃さ `--state-disabled-opacity`、ポインタは矢印                                  | ボタン                             |
| 処理中   | 押したことを処理している。終わるまで押せない       | 無効と同じ見た目に、`aria-busy`。字を「…しています」に変えるのは呼ぶ側           | ボタン（`busy`）                   |
| 空       | 見せるものが無い                                   | 一覧の代わりに `.card-empty` の文                                                | （後に回した Dialog の一覧）             |
| 成功     | 済んだ・できた                                     | `--state-success`                                                                | —                                  |
| 警告     | 続けられるが気をつける                             | `--state-warning`                                                                | —                                  |
| 失敗     | できなかった。壊す操作                             | `--state-danger`。ただし Dialog のエラーの文（`.card-error`）は今は警告の色（未確定）   | —                                  |

同じ見た目に寄せてはいけない、別の意味のもの：

| 意味       | 表すもの                         | 値                                                 |
| ---------- | -------------------------------- | -------------------------------------------------- |
| 所属マシン | どのマシンのワークスペース・タブか | `--machine-color`（マシンごと）                    |
| 接続の状態 | マシンにつながっているか         | `--connection-up`・`--connection-pending`・`--connection-down`（状態の丸） |
| フォーカス | キーの行き先                     | `--state-focus-ring`                               |
| 選択       | 操作の対象として選んでいる行     | `--state-selected-*`                               |

新しく作る所では、この 4 つを別の値で表す。今のサイドバー・ツリー・CHANGES には、フォーカスを接続の色やマシンの色で表す所がある（#306 の「フォーカス・選択・状態の意味」）。どれに寄せるかは未確定なので、変えていない。

## 部品

### ボタン（`Button`）

- **目的**：押して 1 つの操作をする。Dialog と右下の知らせの下の並び（`.card-actions`）に置く。
- **使う場面**：Dialog の「決める」、確認や許可の「はい・いいえ」、知らせの操作。Esc で閉じる Dialog の、閉じるだけ・やめるだけのボタンは置かない（「閉じ方」）。
- **使わない場面**：サイドバーの帯・タブの行の小さいボタン、ツリーや一覧の行（行そのものを押す）、サイドバーなどのアイコンだけのボタン、ブラウザのツールバー、URL を開くリンク。これらは今の見た目のまま、後で決める。
- **引数**：
  - `variant`：`"primary"`（主の操作）か `"secondary"`（既定）。主ボタンは 1 つの並びに 1 つまでで、右端に置く。確認や許可の「やめる」「許さない」は `secondary`。
  - `type`：既定は `"button"`。form の中で送るボタンだけ `"submit"`（入力欄の Enter で送れる。`AskpassDialog`）。
  - `disabled`：今は押せない。
  - `busy`：処理中。押せなくし、`aria-busy` を立てる。字を変えるときは呼ぶ側が children を変える（`UpdateBar` の「更新しています…」）。
  - `onClick`、`children`（字は翻訳の表から `T("…")` で引く）。
- **状態**：通常・hover・フォーカス（focus-visible）・無効・処理中。
- **操作とフォーカス**：ふつうの `button` と同じ。Tab で移り、Enter・Space で押す。ボタンはキーを足さない（Dialog のキーは Dialog が受ける）。無効・処理中のボタンにはフォーカスが移らない。
- **組み合わせの例**：`components/Button` の `CancelAndPrimary`、下の「組み合わせの例」の Dialog。

### Dialog の枠（`ModalCard`）

- **目的**：真ん中に出して、閉じるまで後ろを触らせない Dialog の枠。
- **使う場面**：確かめる（閉じる・入れる・許す）、名前を入れる、一覧から選ぶ、キーの一覧。
- **使わない場面**：後ろを触れたまま出しておく知らせ（右下の `.card-notice`。`Notices.tsx`）、すぐ消えるトースト、リーダーの案内、ページ内検索のような帯。
- **引数**：
  - `label`：Dialog の名前（読み上げ）。見出しと同じ文にする。
  - `onCancel`：Esc（かな漢字変換の Esc は除く）と、`closeOnOutside` のときの外のクリックで呼ぶ。Dialog は自分では閉じない。閉じるのは、呼んだ側が出すのをやめたとき。
  - `width`：省くと 560px。キーの一覧・マシンの一覧は 640px、Workspace switcher は 880px。狭い画面では左右 16px をあけて縮む。
  - `focusSelf`：ユーザーの操作と関係なく開く Dialog（確認・ssh の質問・許可）。フォーカスを中のボタンではなく Dialog そのものに置き、打っていた Enter がボタンを押さないようにする。
  - `closeOnOutside`：打ちかけの入力を失わない Dialog だけ、外のクリックで閉じる。
  - `header`・`footer`：上と下に固定する段（下の「3 つの段」）。JSX をそのまま渡す。
- **3 つの段**：`header`（見出し。ふつうは `CardTitle`）・中身（`children`）・`footer`（ふつうは `CardActions`。キーの案内も置ける）。見出しと `footer` は動かず、Dialog の高さに収まらないときは中身だけがスクロールする。段の境目には、カードの縁と同じ色（`--color-border`）の 1px の線を、いつも引く。`footer` は省ける。`header` を省けるのは、中身が自分で見出しを描く Dialog（履歴の一覧 `HistoryPanel`）だけ。
- **段の中身**：中身は `CardBody`（本文 `CardText`・入力欄 `Field`・理由 `CardError`）や一覧。`CardActions` は `Button` を右寄せにし、主ボタンが右端。狭いとボタンは折り返す。Dialog の中で `.card-body` などの class を手で書かない。右下の知らせも同じ部分を使う（見出しは `CardTitle level={2}`）。
- **送るボタン**：form の送るボタンは `footer`（form の外）に置くので、`Button` の `form` に form の id を渡す（`AskpassDialog`）。
- **閉じ方**：Esc で閉じる Dialog には、閉じるだけの「閉じる」「やめる」ボタンも右上の ✕ も置かない（閉じ方は、どの Dialog でも `Esc`。Key footer には出さない。まだ前の決まりの Dialog（クリップボードの履歴・DB の履歴・DB の権限を強める Dialog）は、Key footer に `Esc` を出す）。ボタンを置くのは、決める・許す・送る操作と、それとやめるを選ぶ確認の Dialog（`CardActions`）だけ。キーで一覧を動かす Dialog は、`footer` に `KeyFooter` を置く（下の「共通フッタ」）。
- **操作とフォーカス**：開くと中の最初の押せるもの（`focusSelf` なら Dialog そのもの）にフォーカスが移る。Esc で `onCancel`（macOS の全画面が解けないよう、Esc の既定の動きは止める）。閉じると、開く前にフォーカスがあった所へ戻す。決める（Enter）は Dialog ごとに決める（入力欄の Enter で決める Dialog は、入力欄が `isComposingKey` で変換の Enter を除く）。
- **組み合わせの例**：下の表。

### 共通フッタ（`KeyFooter`）

- **目的**：Dialog の Key footer に、その Dialog で今効く操作を全部、何に効くかの見出し付きの行で出す。キーを覚えなくても、`?` を開かなくても、次に何ができるかが分かるようにする（#487）。決まりの全部は [ui-ux-review.md](ui-ux-review.md) の 4.7。
- **使う場面**：キーで一覧を動かす Dialog（マシンのダイアログ・Workspace switcher・タブの Dialog・一覧から選ぶ Dialog・ブックマークの一覧）。`ModalCard` の `footer` に渡す。
- **使わない場面**：確認の Dialog と、入力して送る Dialog（ボタンが案内を兼ねる。`CardActions` だけを置く）。ペイン（ファイルツリー・CHANGES・動画・画像。Key footer が無いので `?` だけ）。
- **出すもの**：
  - 今効く操作だけ。効かない操作は出さない。選んでいる行・効いている列・Dialog の状態が変わると、中身が変わる。
  - 何に効くかで行を分け、行の頭に見出し（`title`）を置く。見出しは説明の文（日本語の Dialog では日本語、英語の Dialog では英語）。操作の名前は、どちらの言語でも英語。
  - どの Dialog でも同じ意味のキー（`Enter`・`Esc`・`h` `j` `k` `l`・矢印・`?`。`placeKeys.ts` の `COMMON_KEYS`）は出さない。意味が変わる間だけ出す。
  - `?` の一覧への案内は出さない。
  - Key footer はいつも出す。操作が無い行も、見出しは出す。
  - 選ぶ間の選択肢（作るタブの種類）は、押せるボタンにする（項目の `act`。押すと `onPress(act)`。字を押したのと同じ）。
- **引数**：
  - `rows`：今効く操作の行（`placeKeys.ts` の `FooterRow`）。Dialog ごとのキーのファイル（`dbWindowKey.ts` の `dbWindowFooter`・`switcherKey.ts` の `switcherFooter`・`terminalWindowKey.ts` の `terminalWindowFooter`・`browserWindowKey.ts` の `browserWindowFooter`・`machineFooter.ts` の `machineDialogFooter`・`bookmarkFooter.ts` の `bookmarkDialogFooter`・`features/db/pickerKeys.ts` の `dbPickerFooter`）が、Dialog の状態から作る。選ぶだけの小さな Dialog は、`pickOnlyRows(見出し)` で見出しだけの 1 行にする。ふだんの操作の項目は `placeItem(場所, キー, 名前)` で `?` の一覧の表の行から引くので、Key footer・`?` の一覧・判定のキーがずれない。
  - `onPress`：押せる項目を押した。
  - `items`：まだ行の形にしていない Dialog（クリップボードの履歴・DB の履歴・DB の権限を強める Dialog）の基本操作のヒント（`basicHints`）。使う Dialog が無くなったら消す。
  - `note`：行の上に出す知らせ（操作できない理由など。`role` を付けた `CardText`）。
- **`?` の一覧**：Dialog のキーの全部の表（今効かない操作・どの Dialog でも同じキー・別のキーを含む）。`placeKeys.ts` の表（`placeKeys()`。使うときに今の言語で作る）に書き、Dialog のキーの判定が `?` を受けて `openKeyList(場所)` を呼ぶ。Dialog の場所（`isWindowPlace`）は、その Dialog のキーだけを出す。閉じると、下の Dialog の、`?` を押す前にフォーカスがあった所へ戻る（`ModalCard` が戻す）。
- **Dialog の枠を自分で持つ中身**（履歴の一覧 `HistoryPanel`。外から開く小さな Dialog にも出る）は、`CardFooter` の中に `KeyHints` を自分で置く（「コピーしました」の知らせの入れ物と一緒に）。
- **組み合わせの例**：`main-window/workspaces/WorkspaceSwitcher`（行。列と状態で替わる。作るタブの種類はボタン）、`main-window/tab-window/DbWindow`・`BrowserWindow`・`TerminalWindow`（知らせと 2 行。ターミナルのタブの Dialog は、分ける向きを待つ間だけ別の 1 行）、`main-window/sessions/MachineDialog`（知らせと 2 行。名前を打つ間は見出しだけ）、`main-window/content/browser/BookmarkDialog`（1 行）、選ぶだけの小さな Dialog（`MachinePicker`・`TabMovePicker`・`WorkspaceKindPicker`・`MascotDialog`・`DbConnectionPicker`・`DbExportDialog`。見出しだけの 1 行）。

## 組み合わせの例

どれもアプリの Window そのもの（見本だけの作り直しではない）。Storybook では、外への頼みだけを偽物にして出す。

| Dialog                                                   | 組み合わせ                                                         | Storybook                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------- |
| ワークスペースを閉じる確認（`main-window/workspaces/CloseWorkspaceCard.tsx`） | `focusSelf` の Dialog・見出しと本文・やめると主ボタン | `main-window/workspaces/CloseWorkspaceCard`     |
| kisui を入れるかの確認（`main-window/sessions/InstallCard.tsx`） | `focusSelf` の Dialog・本文・前に失敗した理由・ボタン         | `main-window/sessions/InstallCard`              |
| ファイルの転送を許すかの確認（`main-window/file-transfer/TransferDialog.tsx`） | `focusSelf` の Dialog・本文・許すと読まれるものの一覧（`.transfer-list`。項目を省かず、多いときは一覧の中だけがスクロールする。Tab で一覧にフォーカスを移すと、ブラウザのふつうのキーで動く）・許さないと主ボタン | `main-window/file-transfer/TransferDialog` |
| 新しい版の知らせ（`main-window/notifications/UpdateBar.tsx`） | 右下の知らせ・本文・失敗の理由・処理中の主ボタン          | `main-window/notifications/UpdateBar`           |

## #306 との対応

#306（画面全体の点検と統一の方針）の項目と、ここでの扱い。#306 の本文は変えていない。点検の結果と、未確定の項目の案は [ui-ux-review.md](ui-ux-review.md)。

| #306 の項目                              | #306 での状態 | ここでの扱い                                                                                                    |
| ---------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------- |
| 基本操作は共通フッタ、詳しくは `?`       | 合意済み      | #306 で実装した。#487 で、今効く操作を全部共通フッタに出す決まりに変えた（上の「共通フッタ」）。`KeyFooter` にボタンの並びは置かない（閉じるだけのボタンは置かない）                      |
| 同じ入力エラーの色（黄と赤）             | 未確定        | 警告（`--state-warning`）と失敗（`--state-danger`）を別の名前にした。名前のエラーは、どこでも警告の色にそろった。`.card-error` と内蔵ブラウザの入力欄は今のまま（ui-ux-review.md の案 B） |
| 同じワークスペースを閉じる手順           | 未合意        | 変えていない。`CloseWorkspaceCard` は今の手順のまま、組み合わせの例として出すだけ                                |
| フォーカス・選択・状態の意味             | 未確定        | 4 つの意味（所属マシン・接続の状態・フォーカス・選択）を分けると決め、値の名前を分けた。サイドバー・ツリー・CHANGES の見え方は変えていない |
| Pane border のつかみ方と反応                     | 未確定        | 扱わない（#303）                                                                                               |
| 入力に失敗したときの説明                 | 未確定        | 扱わない。入力欄は後に回した                                                                                    |
| 同じ行操作・利用不能操作の伝え方         | 未確定        | ボタンの「無効」と「処理中」の見せ方だけ決めた（今の Dialog のボタンと同じ）。隠すか、理由を出すかの決まりは未確定（サイドバーは隠す） |
| 同じ名前変更操作のキー                   | 未合意        | 変えていない。`Button` はキーを足さない                                                                         |
| ヒントと詳細ヘルプ                       | 合意済み（フッタと `?`） | ヒントの見た目を `KeyHints` に、Dialog の Key footer を `KeyFooter` にそろえた。文のまま残るヒントは ui-ux-review.md の案 G |

## テストが見張ること

| テスト                              | 見張ること                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `app/src/ui/styles/tokens.test.ts`  | `tokens.css` のどの値にも説明と見出しがあり、名前が重ならず、読む名前がある。`card.css`・`button.css` が色を直に書かず、パレットを直に読まず、無い名前を読まない |
| `app/src/ui/main-window/cssOrder.test.ts` | メインウィンドウの CSS の並び（`button.css` を足した）                                                  |
| `app/src/features/commands/placeKeys.test.ts`・`app/src/ui/main-window/workspaces/switcherKey.test.ts`・`app/src/ui/main-window/tab-window/dbWindowKey.test.ts`・`app/src/features/db/connectionForm.test.ts` | 共通フッタの中身（`switcherFooter`・`dbWindowFooter`・`dbPickerFooter`。前の決まりの Dialog は `basicHints`）。Key footer に出す項目と `?` の一覧の表のキーを、その状態の Dialog のキーの判定が受けること。表の操作が、どこかの状態で Key footer に出ること |
