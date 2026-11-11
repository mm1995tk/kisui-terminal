// kisui-terminal の外から開くクリップボードの履歴の窓（#95）。窓を出し入れするのは Tauri の側（clipboard_popup.rs）。
// 全体のキー（Mac は Option+Space、Linux は Alt+Space）で出る小さな窓に、履歴の一覧（HistoryPanel）だけを出す。
// 選ぶとクリップボードに戻して窓を隠し、前のアプリに戻る（貼るのはユーザー）。Esc は何もせずに隠す。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createSignal, onCleanup, Show, type JSX } from "solid-js";

import { HistoryPanel } from "./ClipboardHistoryDialog.tsx";
import "./connect/card.css";

/** kisui-terminal の外から開く履歴の窓の中身。出し直されるたびに一覧を作り直し、Esc で窓を隠す。 */
export function ClipboardHistoryPopup(): JSX.Element {
  // 窓を出し直すたびに中身を作り直す（履歴を読み直し、絞り込みを空にし、入力欄にフォーカスを置く）
  const [shown, setShown] = createSignal(1);
  const unlisten = listen("clipboard-history-shown", () =>
    setShown((n) => n + 1),
  );
  onCleanup(() => void unlisten.then((f) => f()));

  const dismiss = () => void invoke("clipboard_popup_dismiss");
  const pick = (text: string) => void invoke("clipboard_popup_pick", { text });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !e.isComposing) {
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
          aria-label="クリップボードの履歴"
        >
          <HistoryPanel onPutBack={pick} onClose={dismiss} outside />
        </div>
      )}
    </Show>
  );
}
