// 窓を Esc で閉じるキーの判定。DOM を使わないので node --test で確かめられる。

import { type ComposingKeyLike, isComposingKey } from "../ime.ts";

/** 窓を閉じる Esc：かな漢字変換の Esc（変換の取り消し）は除く。 */
export function isCancelKey(e: ComposingKeyLike): boolean {
  return e.key === "Escape" && !isComposingKey(e);
}
