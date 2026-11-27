// クリップボードの履歴の一覧（#54）。キーで開き、選んだ文字を今の欄に貼るか、OS のクリップボードに戻す。
// 履歴を持つのは Tauri の側（clipboard_history.rs）。ここは開くたびに読み、選ばせる。
// 一覧の中身（ui/modules/clipboard-history/HistoryPanel.tsx）は、kisui-terminal の外から開く小さな Window（ui/utilities/clipboard/page.tsx）でも使う。
import { T } from "../../../i18n/index.ts";
import { createSignal, Show, type JSX } from "solid-js";

import { ModalCard } from "../../components/Card.tsx";
import { HistoryPanel } from "../../modules/clipboard-history/HistoryPanel.tsx";
import { usePorts } from "../../ports.ts";
import { openKeyList } from "../commands/KeyListDialog.tsx";
import { focusedPasteTarget } from "../content/terminal/pasteTarget.ts";

interface Opened {
  /** 開いたときにキーが向いていた欄に貼る関数（無ければ貼れない） */
  paste?: (text: string) => void;
}

const [opened, setOpened] = createSignal<Opened | undefined>();

/** 履歴の Dialog を出す（Shortcut の Cmd+Shift+H / Ctrl+Shift+H と、リーダーの `y`）。出ている間は何もしない。 */
export function openClipboardHistory(): void {
  // Dialog を出すと欄からフォーカスが外れるので、宛先は先に決める
  if (!opened()) setOpened({ paste: focusedPasteTarget() });
}

/** 履歴の Dialog。開いていなければ何も出さない。 */
export function ClipboardHistoryDialog(): JSX.Element {
  return (
    <Show when={opened()} keyed>
      {(o) => <History opened={o} />}
    </Show>
  );
}

function History(props: { opened: Opened }): JSX.Element {
  const ports = usePorts();
  const close = () => setOpened(undefined);
  const target = props.opened.paste;
  return (
    <ModalCard label={T("history.label")} onCancel={close}>
      <HistoryPanel
        list={ports.clipboardHistory}
        onPaste={
          target &&
          ((text) => {
            close();
            target(text);
          })
        }
        onPutBack={(text) =>
          ports.clipboard.write({ kind: "text", text }).then(
            () => true,
            () => false,
          )
        }
        onClose={close}
        onHelp={() => openKeyList("history")}
      />
    </ModalCard>
  );
}
