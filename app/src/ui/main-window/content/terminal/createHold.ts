// タブを切り替えた直後、新しいペインが最初の画面を描けるまで、前のタブのペインを前の位置・見た目のまま残す仕組み（TerminalGrid が使う）。
// ペインの要素を作り直すと、新しい coneko-term は kisui serve から画面の状態が届くまで空なので、それを見せないため。
// どれを残すかの決まりは hold.ts（heldCells）。ここは、描けた印と、残しているペインの持ち物を Solid の計算として持つ。
import { createMemo, createSignal, untrack, type Accessor } from "solid-js";

import { heldCells, type Held } from "./hold.ts";

/** createHold が返す持ち物。 */
export interface Hold<L, V> {
  /** 描くペイン。今のタブのペイン（先頭から links と同じ順）のあとに、残しているペイン */
  cells: Accessor<readonly L[]>;
  /** 残しているペインなら、外れたときの見た目。今のタブのペインなら undefined */
  heldOf: (link: L) => V | undefined;
  /**
   * ペインが最初の画面を描けた（on）・ペインの要素が消えた（off）。消えたら印を外す
   * （同じタブに戻ると、ペインは作り直されて空から描くため）。
   */
  markDrawn: (link: L, on: boolean) => void;
}

/**
 * 前のタブのペインを残す仕組みを作る。links は今のタブのペインの並び、view はそのペインの今の見た目
 * （残すときに、この見た目のまま固める）。
 */
export function createHold<L, V>(deps: {
  links: Accessor<readonly L[]>;
  view: (link: L, index: number) => V;
}): Hold<L, V> {
  // 最初の画面を描けたペイン
  const [drawn, setDrawn] = createSignal<ReadonlySet<L>>(new Set());
  const views = createMemo(
    () => new Map(deps.links().map((l, i): [L, V] => [l, deps.view(l, i)])),
  );
  // 残すペインは、並びと同じ計算の中で決める（効果で後から足すと、For が前のペインを先に消してしまう）
  const holding = createMemo(
    (prev: { views: ReadonlyMap<L, V>; held: Held<L, V>[] }) => {
      const next = views();
      const d = drawn();
      return {
        views: next,
        held: heldCells(prev.held, prev.views, next, (l) => d.has(l)),
      };
    },
    { views: new Map(), held: [] },
  );
  const held = () => holding().held;
  return {
    cells: () => [...deps.links(), ...held().map((h) => h.link)],
    heldOf: (l) => held().find((h) => h.link === l)?.view,
    markDrawn(link, on) {
      const d = untrack(drawn);
      if (d.has(link) === on) return;
      const next = new Set(d);
      if (on) next.add(link);
      else next.delete(link);
      setDrawn(next);
    },
  };
}
