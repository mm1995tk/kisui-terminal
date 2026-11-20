// `kisui db propose`（#382）の、画面に依存しない決まり：書く先のタブの選び方・聞かずに書いてよいか・上書きを決める Enter。
// DOM には触らない（node --test で確かめられる）。頼みを受けて書く流れは proposeController.ts。
import type { KeyLike } from "../commands/guiKeys.ts";
import { isComposingKey } from "../commands/ime.ts";
import type { DbRef, TabRef } from "../workspaces/model.ts";

/**
 * tabs（ワークスペース 1 つのタブ）の中の、マシン target・接続・変種が同じ DB のタブ。2 つ以上あれば、今出しているタブ
 * （shown がその id）、それも無ければ並びの最初のもの。無ければ undefined。
 */
export function proposeTab(
  tabs: readonly TabRef[],
  shown: string | undefined,
  target: string,
  connection: string,
  variant?: string,
): DbRef | undefined {
  const same = tabs.filter(
    (r): r is DbRef =>
      r.kind === "db" &&
      r.target === target &&
      r.connection === connection &&
      (r.variant ?? "") === (variant ?? ""),
  );
  return same.find((r) => r.id === shown) ?? same[0];
}

/** 入力欄の SQL を、聞かずに sql に替えてよいか：空（空白だけ）か、もう同じ SQL のとき。 */
export function replaceable(current: string, sql: string): boolean {
  return current.trim() === "" || current === sql;
}

/**
 * 上書きを聞く窓を開いてから、この時間（ms）がたつまでの Enter は受けない。この窓は人の操作と関係なく開くので、
 * ターミナルなどに打っていた Enter が、読む前に上書きを決めてしまわないようにする。
 */
export const PROPOSE_ENTER_GUARD_MS = 500;

/**
 * 上書きを聞く窓で押したキー e を「上書きする」として受けるか。受けるのは、修飾キーの無い Enter だけ。
 * 変換を確定する Enter・押しっぱなしの繰り返し・開いた直後（sinceOpen が PROPOSE_ENTER_GUARD_MS より短い）・
 * ボタンの上（onButton。ボタンが自分で受ける）は受けない。
 */
export function isProposeEnter(
  e: KeyLike,
  sinceOpen: number,
  onButton: boolean,
): boolean {
  if (isComposingKey(e) || e.key !== "Enter") return false;
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey)
    return false;
  return !onButton && sinceOpen >= PROPOSE_ENTER_GUARD_MS;
}
