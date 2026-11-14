// サイドバーのワークスペースの並び順（ユーザーが並べた順）。
// 並びはマシンをまたぐので、各マシンの kisui serve ではなく、手元の GUI が覚える。
// 置き場所は webview の localStorage（機能の記録は colors.ts と同じく、消えたら元の並び＝マシンの順・作った順に戻るだけ）。
// 記録の形は、{ target, id } の配列を JSON にしたもの（ワークスペースの並びの順）。

import type { WorkspaceId, Workspace } from "../rpc/protocol.ts";
import type { KeyValueStore } from "../ssh/machines.ts";

/** ワークスペース 1 つを指すもの（どのマシンの、どれか）。 */
export interface WsRef {
  target: string;
  id: WorkspaceId;
}

/** localStorage のキー。値は WsRef の JSON 配列。 */
export const ORDER_KEY = "kisui-terminal.workspaceOrder";

const same = (a: WsRef, b: WsRef): boolean =>
  a.target === b.target && a.id === b.id;

/** 記録を読む。無い・壊れている・読めないときは空。形の違うものと重なりは捨てる。 */
export function loadOrder(store: KeyValueStore | undefined): WsRef[] {
  try {
    const raw = store?.getItem(ORDER_KEY);
    if (!raw) return [];
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const out: WsRef[] = [];
    for (const e of v) {
      if (
        typeof e === "object" &&
        e !== null &&
        typeof (e as WsRef).target === "string" &&
        typeof (e as WsRef).id === "string" &&
        !out.some((o) => same(o, e as WsRef))
      )
        out.push({ target: (e as WsRef).target, id: (e as WsRef).id });
    }
    return out;
  } catch {
    return [];
  }
}

/** 記録を書く。書けなくても、今回の並びは変わる（次の起動で元に戻る）。 */
export function saveOrder(
  store: KeyValueStore | undefined,
  order: readonly WsRef[],
): void {
  try {
    store?.setItem(ORDER_KEY, JSON.stringify(order));
  } catch {
    // 保存できなくても、今回は並べ替えが効く
  }
}

/**
 * items を order の順に並べる。order に無いもの（新しいワークスペース）は、items の順のまま後ろに付ける。
 */
export function sortByOrder<T>(
  items: readonly T[],
  ref: (item: T) => WsRef,
  order: readonly WsRef[],
): T[] {
  const index = (r: WsRef) => {
    const i = order.findIndex((o) => same(o, r));
    return i < 0 ? Infinity : i;
  };
  // Array.prototype.sort は安定なので、Infinity 同士は元の順のまま
  return items.slice().sort((a, b) => {
    const ia = index(ref(a));
    const ib = index(ref(b));
    return ia === ib ? 0 : ia < ib ? -1 : 1;
  });
}

/**
 * 並び（shown。画面に出ている順）で at を 1 つ上・下へ動かした、新しい記録。端で動かせなければ null。
 * 記録にあって今は出ていないもの（切れているマシンのワークスペース）は、記録の中の場所を変えない
 * （つなぎ直したときに元の場所に戻る）。出ていて記録に無いものは、記録の後ろに付ける。
 */
export function moveInOrder(
  order: readonly WsRef[],
  shown: readonly WsRef[],
  at: WsRef,
  dir: "up" | "down",
): WsRef[] | null {
  const i = shown.findIndex((s) => same(s, at));
  const j = dir === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= shown.length) return null;
  const next = shown.slice();
  [next[i], next[j]] = [next[j], next[i]];
  // 出ているものの場所に、動かしたあとの順で入れ直す
  const queue = next.slice();
  const out: WsRef[] = [];
  for (const o of order) {
    if (shown.some((s) => same(s, o))) {
      const n = queue.shift();
      if (n) out.push(n);
    } else out.push(o);
  }
  return [...out, ...queue];
}

/**
 * 記録から、もう無いワークスペース（つながっていて一覧が分かっているマシンで、一覧に無い id）を外す。
 * 一覧がまだ分からない（切れている）マシンのものは残す。
 */
export function pruneOrder(
  order: readonly WsRef[],
  workspaces: Record<string, Workspace[] | undefined>,
): WsRef[] {
  return order.filter((o) => {
    const list = workspaces[o.target];
    return !list || list.some((w) => w.id === o.id);
  });
}

/**
 * 新しいワークスペース at を、並びの一番下に入れた記録。
 * 記録に無い今の行（shown。画面に出ている順）は、今の並びのまま記録の後ろに入れてから at を足す。
 * こうしないと、並べ替えたことが無いとき、at が（記録に無い）ほかのマシンの行より上に出てしまう。
 */
export function appendToOrder(
  order: readonly WsRef[],
  shown: readonly WsRef[],
  at: WsRef,
): WsRef[] {
  const out = order.slice();
  for (const s of [...shown.filter((s) => !same(s, at)), at])
    if (!out.some((o) => same(o, s))) out.push(s);
  return out;
}
