// `kisui tab`（#511）：Pane の中のコマンドが Window に頼む、Tab の一覧と操作（rename・close・move・show）。
// commands/windowRun.ts の受け持ちの表を作る。行うことは、キー操作の Command（tab.rename・tab.close・tab.move・tab.moveTo と、
// tab.step・tab.nth の行き先）と同じで、違いは、相手の Tab を引数（id か名前）で指すことと、Dialog を出さないこと。
// 画面にも Tauri にも触らない。
//
// 届く範囲：どの Workspace の Tab にも届く（`[server] pane_reach` は関係しない）。どの Machine の Tab に届くかは、頼みを送ってきた
// serve の Machine で決める（sessions/machines.ts の windowReachAllowed）。Browser tab と Database tab は、手元の PC の Tab として扱う。
// 届かない Tab は、一覧に出さず、指されたら「無い」ときと同じ文で断る（リモートの Machine に、届かない Tab があるかを教えない）。
import { untrack, type Accessor } from "solid-js";

import { T } from "../../../i18n/index.ts";
import {
  argFlag,
  argOptionalString,
  argString,
  CODE_BUSY,
  WindowCommandError,
  type WindowCaller,
  type WindowCommandTable,
} from "../../commands/windowRun.ts";
import type { Sessions } from "../../sessions/controller.ts";
import { machineCliName, windowReachAllowed } from "../../sessions/machines.ts";
import { LOCAL } from "../../sessions/shell.ts";
import {
  displayName,
  gwsByRef,
  hiddenGws,
  nameErrorText,
  refKey,
  type Gws,
  type GwsState,
  type TabRef,
} from "../model.ts";
import type { Row } from "../rows.ts";
import type { Tabs } from "./controller.ts";

/** `kisui tab list --json` の 1 つ（cmd/kisui/tab.go の tabInfo と同じ形）。 */
export interface TabInfo {
  id: string;
  name: string;
  kind: "terminal" | "browser" | "database";
  /** Tab が入っている Workspace の id と名前 */
  workspace: string;
  workspaceName: string;
  /** Terminal tab の Machine の名前（`--machine` で選ぶ名前）。Browser tab と Database tab は local */
  machine: string;
  /** その Workspace が今表示している Tab */
  shown?: true;
  /** 頼んだ Pane の Terminal tab */
  self?: true;
}

/** 指せる Tab 1 つ（Sidebar に出ている Tab）。 */
export interface TabEntry {
  /** CLI で指す id。Terminal tab は Machine のワークスペースの id、Browser tab と Database tab はその Tab の id */
  id: string;
  /** Sidebar に出ている名前 */
  name: string;
  /** Tab が入っている Workspace */
  gws: Gws;
  /** Tab の Machine（ssh の行き先。手元の PC は LOCAL）。Browser tab と Database tab は LOCAL */
  target: string;
  ref: TabRef;
  /** その Workspace が今表示している Tab か */
  shown: boolean;
  /** 人のキーが今この Tab に向いているか（今いる Workspace が表示している Tab） */
  focused: boolean;
}

const KIND = {
  term: "terminal",
  browser: "browser",
  db: "database",
} as const;

/** Sidebar の行 rows から、指せる Tab を並びの順に作る（Sidebar に出ていない Workspace と Tab は入らない）。 */
export function tabEntries(s: GwsState, rows: readonly Row[]): TabEntry[] {
  const out: TabEntry[] = [];
  for (const row of rows) {
    const g = s.list.find((x) => x.id === row.gws);
    if (!g) continue;
    for (const item of row.tabs.items) {
      const ref = g.tabs.find((r) => refKey(r) === item.key);
      if (!ref) continue;
      out.push({
        id: ref.kind === "term" ? ref.ws : ref.id,
        name: item.title,
        gws: g,
        target: ref.kind === "term" ? ref.target : LOCAL,
        ref,
        shown: row.tabs.shown === item.key,
        focused: row.tabs.focused && row.tabs.shown === item.key,
      });
    }
  }
  return out;
}

/**
 * 引数 tab（id か名前。前後の空白は落とす）が指す Tab を、届く Tab の並び list から探す。先に id で探し、無ければ名前で探す。
 * 1 つに決まればそれ。2 つ以上なら、それら（呼ぶ側が、id を並べて断る）。無ければ空。
 */
export function findTabs(list: readonly TabEntry[], tab: string): TabEntry[] {
  const t = tab.trim();
  if (t === "") return [];
  const byId = list.filter((e) => e.id === t);
  return byId.length > 0 ? byId : list.filter((e) => e.name === t);
}

/** `kisui tab` の受け持ちの表を作る。 */
export function createTabCommands(deps: {
  sessions: Pick<Sessions, "states" | "machines" | "labelOf">;
  gws: Accessor<GwsState>;
  /** Sidebar の行（workspaces/controller.ts の rows） */
  rows: Accessor<readonly Row[]>;
  tabs: Pick<
    Tabs,
    | "activateTab"
    | "closeTabRow"
    | "closeTermTabNow"
    | "setTabName"
    | "moveTabByStep"
    | "moveTabToWorkspace"
  >;
  /** 内蔵ブラウザを使うか（使わなければ、Browser tab だけの Workspace は Sidebar に出ないので、移す先にしない） */
  browser: boolean;
  /** Machine from に、手元の PC の Pane の操作を、今、時間を決めて許しているか（paneGrant.ts） */
  granted(from: string): boolean;
  /** 手元の PC に、操作のたびに人に聞くと決めた Pane が 1 つでもあるか（paneApproval.ts） */
  anyAskEach(): boolean;
}): WindowCommandTable {
  const { states, machines, labelOf } = deps.sessions;
  const up = (target: string) => untrack(states)[target]?.kind === "connected";

  /** Machine from の Pane から届く Tab（Sidebar の並びの順）。 */
  function reachable(from: string): TabEntry[] {
    const list = untrack(machines);
    const granted = deps.granted(from);
    return tabEntries(untrack(deps.gws), untrack(deps.rows)).filter((e) =>
      windowReachAllowed(list, from, e.target, granted),
    );
  }

  /** 引数 tab が指す、届く Tab 1 つ。無い・届かない・2 つ以上に当たるときは断る。 */
  function resolve(args: Record<string, unknown>, c: WindowCaller): TabEntry {
    const tab = argString(args, "tab").trim();
    const found = findTabs(reachable(c.from), tab);
    if (found.length === 1) return found[0];
    if (found.length > 1)
      throw new WindowCommandError(
        T("tabCli.err.ambiguous", {
          tab,
          count: found.length,
          ids: found.map((e) => e.id).join(", "),
        }),
      );
    throw new WindowCommandError(
      c.from === LOCAL
        ? T("tabCli.err.noTab", { tab })
        : T("tabCli.err.noTabReach", { tab, from: labelOf(c.from) }),
    );
  }

  /** 引数 workspace（名前か id）が指す Workspace 1 つ。無い・2 つ以上に当たるときは断る。 */
  function workspaceOf(ref: string): Gws {
    const found = gwsByRef(untrack(deps.gws), ref).filter(
      (g) => !hiddenGws(g, deps.browser),
    );
    if (found.length === 1) return found[0];
    throw new WindowCommandError(
      found.length === 0
        ? T("tabCli.err.noWorkspace", { name: ref.trim() })
        : T("paneOpen.err.ambiguous", {
            name: ref.trim(),
            count: found.length,
          }),
    );
  }

  /**
   * Machine from の Pane が、人のキーの行き先を変えてよいか。変えてはいけなければ断る（tab.show・tab.moveTo。どちらも、その Tab へ
   * 移ってキーを向ける）。
   * 手元の PC の Pane と、Window の前の人が時間を決めて許している Machine（paneGrant.ts）の Pane は、いつでもよい。
   * ほかのリモートの Machine の Pane は、キーが今その Machine の Terminal tab に向いているときだけ（キーの行き先が同じ Machine の
   * 中でしか変わらないので、手元の PC やほかの Machine で打っているキーを、その Machine に向けられない）。
   */
  function needKeysOn(c: WindowCaller) {
    if (c.from === LOCAL || deps.granted(c.from)) return;
    const now = tabEntries(untrack(deps.gws), untrack(deps.rows)).find(
      (e) => e.focused,
    );
    if (now?.ref.kind === "term" && now.target === c.from) return;
    throw new WindowCommandError(
      T("tabCli.err.focus", { from: labelOf(c.from) }),
    );
  }

  /** Terminal tab の Machine につながっていなければ断る（名前を変える・表示するのは、つながっている Machine の Tab だけ）。 */
  function needConnected(e: TabEntry) {
    if (e.ref.kind === "term" && !up(e.target))
      throw new WindowCommandError(
        T("err.session.notConnected", { machine: labelOf(e.target) }),
      );
  }

  return {
    "tab.list": {
      remote: true,
      run: (args, c): { tabs: TabInfo[] } => {
        const ws = argOptionalString(args, "workspace");
        const only = ws === undefined ? undefined : workspaceOf(ws).id;
        const list = untrack(machines);
        return {
          tabs: reachable(c.from)
            .filter((e) => only === undefined || e.gws.id === only)
            .map((e) => ({
              id: e.id,
              name: e.name,
              kind: KIND[e.ref.kind],
              workspace: e.gws.id,
              workspaceName: displayName(e.gws),
              machine: machineCliName(list, e.target),
              ...(e.shown ? { shown: true as const } : {}),
              ...(e.ref.kind === "term" &&
              e.target === c.from &&
              e.ref.ws === c.tab
                ? { self: true as const }
                : {}),
            })),
        };
      },
    },

    "tab.rename": {
      remote: true,
      run: async (args, c) => {
        const e = resolve(args, c);
        const name = argString(args, "name");
        const bad = nameErrorText(name);
        if (bad) throw new WindowCommandError(bad);
        needConnected(e);
        await deps.tabs.setTabName(e.gws.id, refKey(e.ref), name);
        return { id: e.id };
      },
    },

    "tab.close": {
      remote: true,
      run: async (args, c) => {
        const e = resolve(args, c);
        const force = argFlag(args, "force");
        if (e.ref.kind !== "term") {
          deps.tabs.closeTabRow(e.gws.id, refKey(e.ref));
          return { id: e.id };
        }
        // 人が「操作のたびに聞く」と決めた Pane があるうちは、リモートの Machine に、手元の PC の Terminal tab を、聞かずに閉じさせない
        if (c.from !== LOCAL && e.target === LOCAL && deps.anyAskEach())
          throw new WindowCommandError(T("tabCli.err.askEach"));
        const r = await deps.tabs.closeTermTabNow(
          e.ref.target,
          e.ref.ws,
          force,
        );
        if (r === "running")
          throw new WindowCommandError(
            T("tabCli.err.running", { tab: e.name }),
            CODE_BUSY,
          );
        return { id: e.id };
      },
    },

    "tab.move": {
      remote: true,
      run: (args, c) => {
        const e = resolve(args, c);
        const dir = argString(args, "dir");
        if (dir !== "up" && dir !== "down")
          throw new WindowCommandError(T("windowRun.err.arg", { name: "dir" }));
        return {
          id: e.id,
          moved: deps.tabs.moveTabByStep(e.gws.id, refKey(e.ref), dir),
        };
      },
    },

    "tab.moveTo": {
      remote: true,
      run: (args, c) => {
        const e = resolve(args, c);
        needKeysOn(c);
        const to = workspaceOf(argString(args, "workspace"));
        if (to.id === e.gws.id)
          throw new WindowCommandError(
            T("tabCli.err.sameWorkspace", {
              tab: e.name,
              workspace: displayName(to),
            }),
          );
        if (!deps.tabs.moveTabToWorkspace(refKey(e.ref), to.id))
          throw new WindowCommandError(T("tabCli.err.noTab", { tab: e.name }));
        return { id: e.id, workspace: to.id };
      },
    },

    "tab.show": {
      remote: true,
      run: (args, c) => {
        const e = resolve(args, c);
        needKeysOn(c);
        needConnected(e);
        deps.tabs.activateTab(e.gws.id, e.ref);
        return { id: e.id };
      },
    },
  };
}
