// `kisui proxy panel・close・stop・hold`（#517）：Pane の中のコマンドが Window に頼む、Tab をプロキシに通す操作（proxy.*）。
// commands/windowRun.ts の受け持ちの表を作る。行うことはキー操作の Command（proxy.panel・proxy.close・proxy.stop・proxy.hold）と
// 同じで、違いは、相手の Tab を引数（`kisui tab` と同じ id か名前）で指すことと、hold を入れるかやめるかを引数で決めること。
// キーを動かす（パネルに向ける・ターミナルに戻す）のは、指した Tab が今出している Tab のときだけ（controller.ts の *Of）。
// 画面にも Tauri にも触らない。
//
// 届く範囲：どれも remote を書かず、手元の PC の Pane の頼みだけを受ける。プロキシに通すと、その Tab の通信（Browser tab なら
// 手元の PC の webview の通信）を記録し、要求を止めて書き換えられる。リモートの Machine の Pane に、手元の PC の Tab の通信の
// 行き先を変えさせない。
import { untrack, type Accessor } from "solid-js";

import { T } from "../../i18n/index.ts";
import {
  argFlag,
  argString,
  WindowCommandError,
  type WindowCommandTable,
} from "../commands/windowRun.ts";
import type { Problem } from "../problem.ts";
import type { GwsState } from "../workspaces/model.ts";
import type { Row } from "../workspaces/rows.ts";
import {
  findTabs,
  tabEntries,
  type TabEntry,
} from "../workspaces/tabs/tabCommands.ts";
import type { Proxy, ProxyFail, ProxySubject } from "./controller.ts";

/** `kisui proxy` の答え（cmd/kisui/proxywin.go の proxyState と同じ形）。 */
export interface ProxyStateInfo {
  /** 指した Tab の id */
  id: string;
  /** プロキシに通しているか */
  on: boolean;
  /** 要求を行き先に送る前に止めているか */
  holding: boolean;
}

/** `kisui proxy` の受け持ちの表を作る。 */
export function createProxyCommands(deps: {
  proxy: Pick<
    Proxy,
    | "subjectOf"
    | "openPanelOf"
    | "closePanelOf"
    | "stopOf"
    | "holdOf"
    | "stateOf"
  >;
  gws: Accessor<GwsState>;
  /** Sidebar の行（workspaces/controller.ts の rows） */
  rows: Accessor<readonly Row[]>;
}): WindowCommandTable {
  /** 引数 tab が指す Tab 1 つと、それを通す相手。無い・2 つ以上に当たる・通せない Tab（Database tab）は断る。 */
  function resolve(args: Record<string, unknown>): {
    e: TabEntry;
    s: ProxySubject;
  } {
    const tab = argString(args, "tab").trim();
    const found = findTabs(
      tabEntries(untrack(deps.gws), untrack(deps.rows)),
      tab,
    );
    if (found.length > 1)
      throw new WindowCommandError(
        T("tabCli.err.ambiguous", {
          tab,
          count: found.length,
          ids: found.map((e) => e.id).join(", "),
        }),
      );
    const e = found[0];
    if (!e) throw new WindowCommandError(T("tabCli.err.noTab", { tab }));
    const s = deps.proxy.subjectOf(e.ref);
    if (!s)
      throw new WindowCommandError(T("proxyCli.err.kind", { tab: e.name }));
    return { e, s };
  }

  /** controller の操作 f を、できなかった理由を受け取りながら行う。できなかったら、その理由で断る。 */
  async function attempt(
    f: (fail: ProxyFail) => boolean | Promise<boolean>,
  ): Promise<void> {
    let why: Problem | undefined;
    const ok = await f((p) => {
      why ??= p;
    });
    if (ok) return;
    if (!why) throw new WindowCommandError(T("proxyCli.err.busy"));
    // 見出しが「プロキシを使えない」だけのものは、理由だけを出す
    throw new WindowCommandError(
      why.title === T("cannot.proxy.title")
        ? why.error
        : `${why.title}: ${why.error}`,
    );
  }

  /**
   * 止めた要求が残っていれば断る（`close` と `hold --off` は、止めていた要求をそのまま行き先に流す。人がパネルで書き換え・捨てる
   * つもりで止めていた要求を、CLI が流さないように。止めた要求は、人がパネルで流す・捨てる）。
   */
  function needNoHeld(e: TabEntry, s: ProxySubject) {
    const held = deps.proxy.stateOf(s)?.held ?? 0;
    if (held > 0)
      throw new WindowCommandError(
        T("proxyCli.err.held", { tab: e.name, count: held }),
      );
  }

  /** 指した Tab の今の状態（答え）。 */
  function stateOf(e: TabEntry, s: ProxySubject): ProxyStateInfo {
    const st = deps.proxy.stateOf(s);
    return { id: e.id, on: !!st, holding: st?.holding ?? false };
  }

  return {
    "proxy.panel": {
      run: async (args) => {
        const { e, s } = resolve(args);
        await attempt((fail) => deps.proxy.openPanelOf(s, fail));
        return stateOf(e, s);
      },
    },

    "proxy.close": {
      run: (args) => {
        const { e, s } = resolve(args);
        needNoHeld(e, s);
        // 開いていなければ何もしない（キー操作と同じ）
        deps.proxy.closePanelOf(s);
        return stateOf(e, s);
      },
    },

    "proxy.stop": {
      run: async (args) => {
        const { e, s } = resolve(args);
        await attempt((fail) => deps.proxy.stopOf(s, fail));
        return stateOf(e, s);
      },
    },

    "proxy.hold": {
      run: async (args) => {
        const { e, s } = resolve(args);
        const off = argFlag(args, "off");
        if (off) needNoHeld(e, s);
        await attempt((fail) => deps.proxy.holdOf(s, !off, fail));
        return stateOf(e, s);
      },
    },
  };
}
