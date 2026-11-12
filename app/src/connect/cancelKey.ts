// 窓を Esc で閉じるキーの判定。DOM を使わないので node --test で確かめられる。

/** 窓を閉じる Esc：かな漢字変換中の Esc（変換の取り消し）は除く。 */
export function isCancelKey(e: { key: string; isComposing: boolean }): boolean {
  return e.key === "Escape" && !e.isComposing;
}
