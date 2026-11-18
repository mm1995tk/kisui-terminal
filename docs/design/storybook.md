# Storybook（窓の画面の部品を 1 つずつ見る）

窓の画面（`app/src/`）の Solid の部品を、Tauri も kisui serve も無しに、ふつうのブラウザで 1 つずつ出す。#314 で入れた（親は #312）。
見本だけの作り直しは作らない。アプリと同じ部品・CSS・字・翻訳の表を読み、外への頼み（Tauri の殻・kisui serve・記録）と見本のデータだけを差し替える。

## 動かす

リポジトリの根で、Nix の devShell から動かす（`app/` に `cd` しない）。

```sh
npm ci                     # 最初と、package-lock.json が変わったとき
npm run storybook          # 開発用のサーバー（http://localhost:6006）。ブラウザは自分で開く
npm run build-storybook    # 静的なビルド（storybook-static/。git には入れない）
```

`storybook-static/` は静的なファイルだけなので、静的なファイルを出す HTTP サーバー（例：`python3 -m http.server -d storybook-static`）で出して開ける。
`vite.config.ts` の `server`・`root`・`build` は Storybook が自分の値に置き換えるので、`tauri dev` の固定ポート（1420）は使わず、`tauri dev` と同時に動かせる。

上の道具の「Language」（地球のアイコン）で、英語と日本語を切り替える。切り替えると story を作り直し、文を引き直す
（アプリでは、言語は起動のときに 1 度だけ決まる。`app/src/i18n/`）。

## 設定の置き場

| ファイル                   | 持つもの                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `.storybook/main.ts`       | 使う連携（`storybook-solidjs-vite`）、stories の場所（`app/src/**/*.stories.tsx`）、送信をやめる設定 |
| `.storybook/preview.tsx`   | アプリと同じ色（`ui/styles/theme.css`）と字（`ui/styles/fonts.ts`）を読む。言語の切り替え                  |
| `.storybook/preview.css`   | story を出す枠の地と字（メインウィンドウの `layout.css` の `body` と同じ値）                              |

Vite の設定は、根の `vite.config.ts` をそのまま読む（Solid の変換と、`@fontsource` の woff を落とす処理がアプリと同じになる）。
アドオンは足していない。Storybook 10 の本体に、Controls・Actions・道具（言語の切り替えに使う）・表示幅の切り替えが入っている。

## stories を足す

- stories は、出す部品の隣に `部品の名前.stories.tsx` で置く（[frontend-structure.md](frontend-structure.md) の「部品をどこに置くか」）。
- `title` は `app/src/ui/` からの置き場に合わせる（例：`components/RenameDialog`、`modules/clipboard-history/HistoryPanel`）。
- 書き方は CSF 3（`Meta`・`StoryObj` は `storybook-solidjs-vite` から）。押した・閉じたなどの呼び出しは `storybook/test` の `fn()` で受け、Actions に出す。
- 画面の文は、ほかのコードと同じく表のキーで引く（`T("…")`）。言語を切り替えたあとに引き直すよう、`T` は `args` に直に書かず、`render` の中で呼ぶ（`RenameDialog.stories.tsx` の `WithError`）。
- 見本のデータを複数の stories で使うときは、stories の隣に普通のファイルで置く（例：`ui/modules/clipboard-history/historyFixtures.ts`）。`*.stories.tsx` から名前付きで書き出したものは、Storybook が story として読んでしまう。
- 窓の部品（`ModalCard` を使うもの）は、アプリで入れている組み合わせのまま出す（`HistoryPanel.stories.tsx` は、メインウィンドウと同じく `ModalCard` に入れる）。

今ある stories：

| story                                               | 出すもの                                              | 差し替えたもの                                     |
| --------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------- |
| `ui/components/RenameDialog.stories.tsx`            | 名前を変える窓（名前あり・なし・理由を出したとき）    | 決めた・やめた（`fn()`）                           |
| `ui/modules/clipboard-history/HistoryPanel.stories.tsx` | 履歴の一覧（一覧・貼る欄あり・空・読み込み中・読めない） | 履歴を読む頼み `ListClipboardHistory`            |
| `ui/utilities/clipboard/page.stories.tsx`           | kisui-terminal の外から開く履歴の窓                   | 殻への頼み `ClipboardPopupOs`、`ListClipboardHistory` |

## 外への頼みを差し替える

部品は、外（Tauri の殻・kisui serve・webview の記録）への頼みを、機能の近くのインターフェースでしか知らない
（[frontend-structure.md](frontend-structure.md) の「依存の向き」）。stories は、`infrastructure/` の本物を読まず、同じ形の偽物を渡す。

- props で受け取る部品には、偽物を `args` に渡す。例：`HistoryPanel` の `list` に、決まった履歴を返す関数（`historyFixtures.ts` の `listOf`）、
  `ClipboardUtilityPage` の `os` に、何もしない `onShown` と `fn()` の `dismiss`・`copy`。
- 読み込み中・失敗は、答えない Promise・失敗する Promise を渡して出す（`HistoryPanel` の `Loading`・`Failed`）。
- 文脈（`usePorts()`）で受け取る奥の部品は、`ui/ports.ts` の `PortsContext.Provider` で、偽の `Ports` を渡して包む。テストと同じく、要る頼みだけを持つ偽物でよい。
- stories からも `infrastructure/tauri/`・`infrastructure/storage/` は読まない（`app/src/architecture.test.ts` が、`ui/` から読むと落ちる）。

## 使っている版と、確かめたこと

2026-11-18 に、リポジトリの版（Solid 1.9.17、Vite 8.3.4、vite-plugin-solid 2.11.14、TypeScript 7.0.2）で確かめた。

| パッケージ               | 版     | 備考                                                                                  |
| ------------------------ | ------ | ------------------------------------------------------------------------------------- |
| `storybook`              | 10.6.7 | 本体。Vite 8 に対応（`@storybook/builder-vite` 10.6.7 の peer は Vite 5〜8）          |
| `storybook-solidjs-vite` | 10.7.4 | Solid の連携（コミュニティの保守）。peer は Solid 1.8 以上、Vite 5〜8、Storybook 10   |

- `npm run storybook` で起動し、headless の Chromium で story を開いて、部品が出ること、上の道具で言語を切り替えると窓の文が英語と日本語で入れ替わることを確かめた。
- `npm run build-storybook` が通り、`storybook-static/` を HTTP で出して、3 つの stories を英語・日本語で開き、アプリと同じ色・IBM Plex Sans JP・JetBrains Mono で出ることを画像で確かめた。
- `tsc --noEmit`（`npm run build` の型の検査）は、stories と `.storybook/` も見る。
- 静的なビルドのとき、`storybook-solidjs-vite` の中の Solid 2 向けの分岐（`solid.merge`）に「import が無い」の警告が出る。Solid 1 では通らない分岐なので、動きには関わらない。
