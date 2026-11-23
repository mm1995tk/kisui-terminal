// 内蔵ブラウザのタブで、ページの読み込みが（ページが出る前に）失敗したときの、画面に出す形（#432）。
// 殻（src-tauri/src/browser_load.rs）が OS の WebView から失敗を受けて、理由を分類して知らせる。
// DOM も Tauri も使わない（node --test で確かめられる）。

import type { Key } from "../../i18n/index.ts";

/** 失敗の理由の分類（殻の Reason と同じ名前）。 */
export type LoadReason =
  | "cert-untrusted"
  | "cert-expired"
  | "cert-not-yet-valid"
  | "cert-name"
  | "cert-other"
  | "host-not-found"
  | "refused"
  | "timed-out"
  | "offline"
  | "lost"
  | "other";

/** タブの読み込みの失敗。次に読み込みが始まるまで、そのタブにはこれを出す（覚えない）。 */
export interface LoadError {
  /** 開こうとした URL */
  url: string;
  reason: LoadReason;
  /** OS が出した説明（OS の言語。空のこともある） */
  detail: string;
}

/** 理由ごとの文の鍵。 */
const REASON_KEYS: Record<LoadReason, Key> = {
  "cert-untrusted": "browser.loadFailed.cert-untrusted",
  "cert-expired": "browser.loadFailed.cert-expired",
  "cert-not-yet-valid": "browser.loadFailed.cert-not-yet-valid",
  "cert-name": "browser.loadFailed.cert-name",
  "cert-other": "browser.loadFailed.cert-other",
  "host-not-found": "browser.loadFailed.host-not-found",
  refused: "browser.loadFailed.refused",
  "timed-out": "browser.loadFailed.timed-out",
  offline: "browser.loadFailed.offline",
  lost: "browser.loadFailed.lost",
  other: "browser.loadFailed.other",
};

/** 理由の文の鍵。殻が知らない分類を送ってきたら、「そのほか」。 */
export function reasonKey(reason: string): Key {
  return Object.hasOwn(REASON_KEYS, reason)
    ? REASON_KEYS[reason as LoadReason]
    : REASON_KEYS.other;
}

/** 証明書の失敗か（開く道が無いことを添える）。 */
export function isCertReason(reason: string): boolean {
  return reason.startsWith("cert-");
}

/** 殻の知らせから、タブに持たせる形を作る。知らせの URL が空なら、タブの今の URL を使う。 */
export function toLoadError(
  e: { url: string; reason: string; detail: string },
  tabUrl: string,
): LoadError {
  return {
    url: e.url || tabUrl,
    reason: Object.hasOwn(REASON_KEYS, e.reason)
      ? (e.reason as LoadReason)
      : "other",
    detail: e.detail,
  };
}
