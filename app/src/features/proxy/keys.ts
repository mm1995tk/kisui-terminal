// プロキシのパネル（#409）にキーがあるときのキーの判定（場所のキー。docs/key-design.md の 5 章）。
// `?` の一覧に出す表は features/commands/placeKeys.ts の proxy。DOM には触らない（node --test で確かめられる）。
import { isComposingKey } from "../commands/ime.ts";
import type { KeyLike } from "../commands/guiKeys.ts";

/**
 * パネルのキーの動き。next・prev・first・last：一覧で選ぶ通信を動かす。side：中身の「要求」と「応答」を切り替える。
 * back：キーをタブ（ターミナル・ページ）に戻す（パネルは出したまま）。close：パネルを閉じる。
 */
export type ProxyPanelKey =
  "next" | "prev" | "first" | "last" | "side" | "back" | "close";

/** パネルで押したキー e の動き（当たらなければ null）。修飾キー（Shift 以外）を押していれば受けない。 */
export function proxyPanelKey(e: KeyLike): ProxyPanelKey | null {
  if (e.ctrlKey || e.metaKey || e.altKey || isComposingKey(e)) return null;
  switch (e.key) {
    case "j":
    case "ArrowDown":
      return e.shiftKey ? null : "next";
    case "k":
    case "ArrowUp":
      return e.shiftKey ? null : "prev";
    case "g":
    case "Home":
      return e.shiftKey ? null : "first";
    case "G":
    case "End":
      return "last";
    case "Tab":
    case "h":
    case "l":
    case "ArrowLeft":
    case "ArrowRight":
      return e.shiftKey && e.key !== "Tab" ? null : "side";
    case "Escape":
      return "back";
    case "q":
      return e.shiftKey ? null : "close";
  }
  return null;
}
