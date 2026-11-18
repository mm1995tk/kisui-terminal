// 画面が外（Tauri の殻・webview の記録）に頼むことの束。形は機能ごとの窓口（features/ の各インターフェース）で、
// 本物（infrastructure/）を組み立てて渡すのは index.tsx。画面は本物を直に読まず、ここから受け取る
// （Tauri の無い所でも、偽物を渡せば部品を出せる）。
import { createContext, useContext } from "solid-js";

import type { BrowserOs } from "../features/browser/os.ts";
import type { ClipboardOs } from "../features/clipboard/clipboardBridge.ts";
import type { ListClipboardHistory } from "../features/clipboard/history.ts";
import type { TransferOs } from "../features/file-transfer/transfer.ts";
import type { KeyValueStore } from "../features/keyValueStore.ts";
import type { MascotOs } from "../features/mascot/mascot.ts";
import type { ApplyScale } from "../features/scale/scale.ts";
import type { ShellApi } from "../features/sessions/shell.ts";
import type { ShowOsNotification } from "../features/terminal/notify.ts";
import type { OpenUrlExternally } from "../features/terminal/urlOpen.ts";
import type { UpdatesOs } from "../features/updates/store.ts";

/** メインウィンドウが外に頼むこと。 */
export interface Ports {
  /** 接続（ssh・kisui attach）と設定ファイル */
  shell: ShellApi;
  /** 小さな記録の置き場（使えない環境では undefined。そのときは覚えない） */
  store: KeyValueStore | undefined;
  /** 内蔵ブラウザのタブ */
  browser: BrowserOs;
  /** OS のクリップボード */
  clipboard: ClipboardOs;
  /** クリップボードの履歴 */
  clipboardHistory: ListClipboardHistory;
  /** ターミナルのファイル転送 */
  transfer: TransferOs;
  /** OS の通知 */
  notify: ShowOsNotification;
  /** 外部ブラウザ */
  openUrl: OpenUrlExternally;
  /** 窓の中の画面全体の大きさ */
  applyScale: ApplyScale;
  /** キャラクター */
  mascot: MascotOs;
  /** 新しい版 */
  updates: UpdatesOs;
}

/** メインウィンドウの部品に Ports を配る（ui/main-window/page.tsx が置く）。 */
export const PortsContext = createContext<Ports>();

/** 今の画面の Ports。PortsContext.Provider の外で呼ぶと投げる。 */
export function usePorts(): Ports {
  const p = useContext(PortsContext);
  if (!p) throw new Error("PortsContext.Provider is missing");
  return p;
}
