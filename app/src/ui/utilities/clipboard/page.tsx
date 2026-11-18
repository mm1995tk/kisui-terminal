// kisui-terminal の外から開くクリップボードの履歴の窓（#95）。窓を出し入れするのは Tauri の側（clipboard_popup.rs）。
// 全体のキー（Mac は Option+Space、Linux は Alt+Space）で出る小さな窓に、履歴の一覧（HistoryPanel）だけを出す。
// 選ぶとクリップボードに戻し、「コピーしました」を少し見せてから窓を隠し、前のアプリに戻る（貼るのはユーザー）。Esc は何もせずに隠す。
// ほかのアプリを使っている間でもデスクトップから呼び出す常駐ツールの画面なので、メインウィンドウ（ui/main-window/）とは別に置く。
import { isComposingKey } from "../../../features/commands/ime.ts";
import type {
  ClipboardPopupOs,
  ListClipboardHistory,
} from "../../../features/clipboard/history.ts";
import { T } from "../../../i18n/index.ts";
import { createSignal, onCleanup, Show, type JSX } from "solid-js";

import "../../components/card.css";
import { HistoryPanel } from "../../modules/clipboard-history/HistoryPanel.tsx";

/** kisui-terminal の外から開く履歴の窓の中身。出し直されるたびに一覧を作り直し、Esc で窓を隠す。 */
export function ClipboardUtilityPage(props: {
  /** 窓の出し入れとクリップボードへの書き込み（殻への頼み） */
  os: ClipboardPopupOs;
  /** 履歴を読む */
  list: ListClipboardHistory;
}): JSX.Element {
  // 窓を出し直すたびに中身を作り直す（履歴を読み直し、絞り込みを空にし、入力欄にフォーカスを置く）
  const [shown, setShown] = createSignal(1);
  const unlisten = props.os.onShown(() => setShown((n) => n + 1));
  onCleanup(() => void unlisten.then((f) => f()));

  const dismiss = () => void props.os.dismiss();
  // クリップボードに書くだけ（窓を隠すのは、「コピーしました」を見せたあとの dismiss）
  const copy = (text: string) =>
    props.os.copy(text).then(
      () => true,
      () => false,
    );

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !isComposingKey(e)) {
      e.preventDefault();
      dismiss();
    }
  };
  window.addEventListener("keydown", onKeyDown);
  onCleanup(() => window.removeEventListener("keydown", onKeyDown));

  return (
    <Show when={shown()} keyed>
      {(_shown) => (
        <div
          class="card history-popup"
          role="dialog"
          aria-label={T("history.label")}
        >
          <HistoryPanel
            list={props.list}
            onPutBack={copy}
            onClose={dismiss}
            outside
          />
        </div>
      )}
    </Show>
  );
}
