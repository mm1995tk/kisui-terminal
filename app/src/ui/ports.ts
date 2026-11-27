// 画面が外（Tauri の殻・webview の記録）に頼むことの束。形は機能ごとの受け口（features/ の各インターフェース）で、
// 本物（infrastructure/）を組み立てて渡すのは index.tsx。画面は本物を直に読まず、ここから受け取る
// （Tauri の無い所でも、偽物を渡せば部品を出せる）。
import { createContext, useContext } from "solid-js";

import type { FeaturePorts } from "../features/compose.ts";
import type { ClipboardOs } from "../features/clipboard/clipboardBridge.ts";
import type { ListClipboardHistory } from "../features/clipboard/history.ts";
import type { TransferOs } from "../features/file-transfer/transfer.ts";
import type { ShowOsNotification } from "../features/terminal/notify.ts";

/** メインウィンドウが外に頼むこと。機能が使うもの（FeaturePorts）に、画面の部品が直に使うものを足す。 */
export interface Ports extends FeaturePorts {
  /** OS のクリップボード */
  clipboard: ClipboardOs;
  /** クリップボードの履歴 */
  clipboardHistory: ListClipboardHistory;
  /** ターミナルのファイル転送 */
  transfer: TransferOs;
  /** OS の通知 */
  notify: ShowOsNotification;
}

/** メインウィンドウの部品に Ports を配る（ui/main-window/page.tsx が置く）。 */
export const PortsContext = createContext<Ports>();

/** 今の画面の Ports。PortsContext.Provider の外で呼ぶと投げる。 */
export function usePorts(): Ports {
  const p = useContext(PortsContext);
  if (!p) throw new Error("PortsContext.Provider is missing");
  return p;
}
