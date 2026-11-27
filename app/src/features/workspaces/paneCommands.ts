// `kisui pane focus|swap|zoom|resize`（#513）：Pane の中のコマンドが Window に頼む、Pane のフォーカス・入れ替え・Primary の Pane だけの表示・大きさ。
// commands/windowRun.ts の受け持ちの表を作る。行うことは、キー操作の Command（pane.focus・pane.last・pane.swap・pane.zoom・pane.resize）と
// 同じで、違いは、相手の Pane を引数（id か名前）で指すことと、向きではなく Pane を指すこと。画面にも Tauri にも触らない。
//
// 届く範囲：`kisui pane send` などと同じ。Pane を指すときは、頼んだ Pane の serve に Pane の一覧（list）を、`--machine` と同じ中継
// （sessions/paneRelay.ts）で聞く。一覧は、中継が Machine の決まり（`allow_pane_to`・手元の PC への許可）で、serve が `[server] pane_reach` で
// 絞る。だから、届かない Pane は、無い Pane と同じ文で断る。
//
// キーの行き先：pane.focus と pane.last は、人のキーをその Pane へ向ける。リモートの Machine の Pane からは、Window の前の人が
// 時間を決めて許している間（paneGrant.ts）か、キーが今その Machine の Terminal tab に向いていて、行き先の Pane もその Machine の
// Terminal tab にあるときだけ通す（`kisui workspace show` と同じ。tabs/tabCommands.ts の keysOnMachine）。swap・resize は、キーを動かさない。zoom は、Primary pane だけの表示にするとき、その Terminal tab にキーが向いていれば、キーが Primary pane へ移るので、そのときだけ同じ確認をする。
import { untrack, type Accessor } from "solid-js";

import { T } from "../../i18n/index.ts";
import type {
  PaneRunReply,
  PaneRunRequest,
  PaneOrigin,
  WorkspaceId,
} from "../../infrastructure/rpc/protocol.ts";
import {
  argOptionalString,
  argString,
  WindowCommandError,
  type WindowCaller,
  type WindowCommandTable,
} from "../commands/windowRun.ts";
import type { Sessions } from "../sessions/controller.ts";
import { machineCliName, machineTarget } from "../sessions/machines.ts";
import { LOCAL } from "../sessions/shell.ts";
import type { Direction } from "../terminal/grid.ts";
import type { TermGroup, TermGroups } from "../terminal/group.ts";
import type { GwsState } from "./model.ts";
import type { Row } from "./rows.ts";
import { keysOnMachine, tabEntries } from "./tabs/tabCommands.ts";
import type { Tabs } from "./tabs/controller.ts";

/** 1 回の `kisui pane resize` が動かす回数の上限（1 回分は分割の 2%。50 回で分割の全体） */
export const MAX_RESIZE_STEPS = 50;

/** 指された Pane 1 つ。 */
interface PaneRef {
  /** Pane の Machine（ssh の行き先。手元の PC は LOCAL） */
  target: string;
  /** Pane の Terminal tab（その Machine の serve のワークスペースの id） */
  ws: WorkspaceId;
  /** Pane の id */
  id: string;
  /** 指されたとおりの名前（断る文に出す） */
  name: string;
}

/** list の答えの 1 行から、Pane の id・名前・Terminal tab の id を読む。形が違えば undefined。 */
function paneOf(
  x: unknown,
): { id: string; name?: string; tab: string } | undefined {
  if (typeof x !== "object" || x === null) return undefined;
  const { id, name, tab } = x as Record<string, unknown>;
  if (typeof id !== "string" || typeof tab !== "string") return undefined;
  return {
    id,
    tab,
    ...(typeof name === "string" && name !== "" ? { name } : {}),
  };
}

const DIRS: readonly Direction[] = ["right", "down", "left", "up"];

/** args の向き dir（right・down・left・up）。ほかは断る。 */
function argDir(args: Record<string, unknown>): Direction {
  const dir = argString(args, "dir");
  const found = DIRS.find((d) => d === dir);
  if (!found)
    throw new WindowCommandError(T("windowRun.err.arg", { name: "dir" }));
  return found;
}

/** `kisui pane focus|swap|zoom|resize` の受け持ちの表を作る。 */
export function createPaneCommands(deps: {
  sessions: Pick<Sessions, "states" | "machines" | "labelOf">;
  /** Machine ごとの Terminal tab の Pane の並び（sessions/controller.ts の termGroups） */
  termGroups: ReadonlyMap<string, TermGroups>;
  gws: Accessor<GwsState>;
  /** Sidebar の行（workspaces/controller.ts の rows） */
  rows: Accessor<readonly Row[]>;
  tabs: Pick<Tabs, "activateTab">;
  terminals: {
    isZoomed(target: string, id: WorkspaceId): boolean;
    canZoomWs(target: string, id: WorkspaceId): boolean;
    zoomWs(target: string, id: WorkspaceId, on: boolean | "toggle"): boolean;
  };
  /** `kisui pane … --machine` の中継（sessions/paneRelay.ts） */
  relay(
    from: string,
    machine: string,
    rq: PaneRunRequest,
    by: { id?: string; pane?: string; ancestry?: PaneOrigin[] },
  ): Promise<PaneRunReply>;
  /** Machine from に、手元の PC の Pane の操作を、今、時間を決めて許しているか（paneGrant.ts） */
  granted(from: string): boolean;
}): WindowCommandTable {
  const { states, machines, labelOf } = deps.sessions;
  const up = (target: string) => untrack(states)[target]?.kind === "connected";

  /**
   * 引数 pane（id か名前）が指す、届く Pane 1 つ。Machine は引数 machine（無ければ頼んだ Pane の Machine）。
   * 無い・届かないときは同じ文で断る。Machine に届かない・つながっていないときは、中継の理由で断る。
   */
  async function resolve(
    args: Record<string, unknown>,
    c: WindowCaller,
  ): Promise<PaneRef> {
    const name = argString(args, "pane").trim();
    const machine =
      argOptionalString(args, "machine")?.trim() ||
      machineCliName(untrack(machines), c.from);
    const r = await deps.relay(
      c.from,
      machine,
      { cmd: "list" },
      { pane: c.pane },
    );
    if (r.error !== undefined) throw new WindowCommandError(r.error);
    const target = machineTarget(untrack(machines), machine);
    const found = (r.panes ?? [])
      .map(paneOf)
      .find((p) => p !== undefined && (p.id === name || p.name === name));
    if (!found || target === undefined)
      throw new WindowCommandError(T("paneCli.err.noPane", { pane: name }));
    return { target, ws: found.tab, id: found.id, name };
  }

  /** Pane の Terminal tab の Pane の並び。無ければ（Machine が切れた・Tab が閉じた）断る。 */
  function groupOf(p: {
    target: string;
    ws: WorkspaceId;
    name: string;
  }): TermGroup {
    if (!up(p.target))
      throw new WindowCommandError(
        T("err.session.notConnected", { machine: labelOf(p.target) }),
      );
    const g = deps.termGroups.get(p.target)?.get(p.ws);
    if (!g)
      throw new WindowCommandError(T("paneCli.err.noPane", { pane: p.name }));
    return g;
  }

  /** 人のキーを、Machine dest の Terminal tab へ向けてよいか。向けてはいけなければ断る。 */
  function needKeysOn(c: WindowCaller, dest: string) {
    if (c.from === LOCAL || deps.granted(c.from)) return;
    if (
      dest === c.from &&
      keysOnMachine(tabEntries(untrack(deps.gws), untrack(deps.rows)), c.from)
    )
      return;
    throw new WindowCommandError(
      T("paneCli.err.focus", { from: labelOf(c.from) }),
    );
  }

  /** Pane の Terminal tab を表示して、Pane にキーを向ける。 */
  function show(p: PaneRef, paneId: string | undefined, g: TermGroup) {
    const entry = tabEntries(untrack(deps.gws), untrack(deps.rows)).find(
      (e) => e.ref.kind === "term" && e.target === p.target && e.id === p.ws,
    );
    if (!entry)
      throw new WindowCommandError(T("paneCli.err.noPane", { pane: p.name }));
    if (paneId !== undefined) {
      // 隠している間は、隠れている Pane は動けないので、戻す（ターミナルのタブの窓で Pane を選ぶときと同じ）
      if (g.list[0]?.id !== paneId)
        deps.terminals.zoomWs(p.target, p.ws, false);
      if (!g.activatePane(paneId))
        throw new WindowCommandError(T("paneCli.err.noPane", { pane: p.name }));
    }
    deps.tabs.activateTab(entry.gws.id, entry.ref);
  }

  /** 隠している間は、Pane の入れ替え・大きさを動かさない（隠れた Pane は見えない）。 */
  function needShown(p: PaneRef) {
    if (deps.terminals.isZoomed(p.target, p.ws))
      throw new WindowCommandError(T("paneCli.err.zoomed", { pane: p.name }));
  }

  return {
    "pane.focus": {
      remote: true,
      run: async (args, c) => {
        const p = await resolve(args, c);
        needKeysOn(c, p.target);
        const g = groupOf(p);
        show(p, p.id, g);
        return { id: p.id };
      },
    },

    "pane.last": {
      remote: true,
      run: (_args, c) => {
        const p = { target: c.from, ws: c.tab, name: c.pane };
        needKeysOn(c, c.from);
        const g = groupOf(p);
        needShown({ ...p, id: c.pane });
        const moved = g.focusPrevious();
        if (moved) show({ ...p, id: c.pane }, undefined, g);
        return { moved };
      },
    },

    "pane.swap": {
      remote: true,
      run: async (args, c) => {
        const p = await resolve(args, c);
        const dir = argDir(args);
        const g = groupOf(p);
        needShown(p);
        return { id: p.id, moved: g.swap(dir, p.id) };
      },
    },

    "pane.zoom": {
      remote: true,
      run: async (args, c) => {
        const p = await resolve(args, c);
        groupOf(p);
        if (!deps.terminals.canZoomWs(p.target, p.ws))
          throw new WindowCommandError(
            T("paneCli.err.noZoom", { pane: p.name }),
          );
        // Primary pane だけの表示にすると、その Terminal tab にキーが向いていれば、キーが Primary pane へ移る。
        // 人が打っているキーを別の Pane へ動かすので、キーの行き先を変える頼みと同じ確認をする
        // （表示を戻すときと、キーが向いていない Terminal tab は、キーを動かさない）
        if (
          !deps.terminals.isZoomed(p.target, p.ws) &&
          tabEntries(untrack(deps.gws), untrack(deps.rows)).some(
            (e) =>
              e.focused &&
              e.ref.kind === "term" &&
              e.target === p.target &&
              e.id === p.ws,
          )
        )
          needKeysOn(c, p.target);
        return {
          id: p.id,
          zoomed: deps.terminals.zoomWs(p.target, p.ws, "toggle"),
        };
      },
    },

    "pane.resize": {
      remote: true,
      run: async (args, c) => {
        const p = await resolve(args, c);
        const dir = argDir(args);
        const steps = args.steps;
        if (
          typeof steps !== "number" ||
          !Number.isInteger(steps) ||
          steps < 1 ||
          steps > MAX_RESIZE_STEPS
        )
          throw new WindowCommandError(
            T("windowRun.err.arg", { name: "steps" }),
          );
        const g = groupOf(p);
        needShown(p);
        return { id: p.id, moved: g.resizeToward(p.id, dir, steps) };
      },
    },
  };
}
