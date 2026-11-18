// 前の版のサイドバーの並び順の記録（リーダーの w J / w K が覚えていたもの）を読む。
// 並びは GUI のワークスペースが覚えるようになった（gws/model.ts。#231）ので、この記録はもう書かない。
// GUI のワークスペースの記録が無い GUI が初めて一覧を見たときに、新しく作るワークスペースの並びを、この記録の順にそろえるのだけに使う。
// 記録の形は、{ target, id } の配列を JSON にしたもの（ワークスペースの並びの順）。置き場所は webview の localStorage。

import type { WorkspaceId } from "../../infrastructure/rpc/protocol.ts";
import type { KeyValueStore } from "../sessions/machines.ts";

/** マシンのワークスペース 1 つを指すもの（どのマシンの、どれか）。 */
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
