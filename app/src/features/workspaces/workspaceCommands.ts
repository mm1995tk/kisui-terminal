// `kisui workspace`（#512）：Pane の中のコマンドが Window に頼む、Workspace の一覧と操作（new・rename・close・move・show）。
// commands/windowRun.ts の受け持ちの表を作る。行うことは、キー操作の Command（workspace.new・workspace.rename・workspace.close・
// workspace.move と、workspace.step・workspace.nth・workspace.last の行き先）と同じで、違いは、相手の Workspace を引数（id か名前）で
// 指すことと、Dialog を出さないこと。Dialog を開くだけの workspace.switch は CLI にしない。画面にも Tauri にも触らない。
//
// 届く範囲：Workspace は Machine をまたいで Tab を束ねるので、Tab ごとに決める（sessions/machines.ts の windowReachAllowed。`kisui tab` と同じ）。
//   - Machine from の Pane に見える・指せる Workspace は、届く Tab を 1 つでも持つものと、Tab の無いもの。Tab の数は、届く Tab だけを数える。
//     届かない Workspace は、一覧に出さず、指されたら「無い」ときと同じ文で断る（届かない Tab があるかを教えない）。
//   - close は、中の Tab を全部閉じるので、中の Tab が全部届くときだけ行う。
//   - show は、その Workspace が表示している Tab へ人のキーを向ける。`tab.show` と同じく、リモートの Machine の Pane からは、
//     許している間か、キーが今その Machine の Terminal tab に向いていて、行き先の Tab もその Machine の Terminal tab のときだけ通す。
//   - new・rename・move は、Tab に触らない（rename は名前を全 Machine に知らせるだけ）。
import { untrack, type Accessor } from "solid-js";

import { T } from "../../i18n/index.ts";
import {
  argFlag,
  argString,
  CODE_BUSY,
  WindowCommandError,
  type WindowCaller,
  type WindowCommandTable,
} from "../commands/windowRun.ts";
import type { Sessions } from "../sessions/controller.ts";
import { windowReachAllowed } from "../sessions/machines.ts";
import { LOCAL } from "../sessions/shell.ts";
import { tabEntries } from "./tabs/tabCommands.ts";
import {
  displayName,
  gwsByRef,
  hiddenGws,
  type Gws,
  type GwsState,
  type TabRef,
} from "./model.ts";
import type { Row } from "./rows.ts";
import type { Tabs } from "./tabs/controller.ts";
import type { Workspaces } from "./controller.ts";

/** `kisui workspace list --json` の 1 つ（cmd/kisui/workspace.go の workspaceInfo と同じ形）。 */
export interface WorkspaceInfo {
  id: string;
  name: string;
  /** 中の Tab の数（頼んだ Pane から届く Tab だけ） */
  tabs: number;
  /** Window が今いる Workspace */
  current?: true;
  /** 頼んだ Pane の Terminal tab が入っている Workspace */
  self?: true;
}

/** Tab ref の Machine（Browser tab と Database tab は手元の PC の Tab として扱う）。 */
const targetOf = (r: TabRef): string => (r.kind === "term" ? r.target : LOCAL);

/** `kisui workspace` の受け持ちの表を作る。 */
export function createWorkspaceCommands(deps: {
  sessions: Pick<Sessions, "states" | "machines" | "labelOf">;
  gws: Accessor<GwsState>;
  /** Sidebar の行（workspaces/controller.ts の rows） */
  rows: Accessor<readonly Row[]>;
  workspaces: Pick<
    Workspaces,
    | "closeWorkspaceNow"
    | "moveWorkspace"
    | "renameWorkspace"
    | "createEmptyWorkspace"
    | "showGws"
    | "goRow"
  >;
  tabs: Pick<Tabs, "activateTab">;
  /** 内蔵ブラウザを使うか（使わなければ、Browser tab だけの Workspace は Sidebar に出ないので、指せない） */
  browser: boolean;
  /** Machine from に、手元の PC の Pane の操作を、今、時間を決めて許しているか（paneGrant.ts） */
  granted(from: string): boolean;
  /** 手元の PC に、操作のたびに人に聞くと決めた Pane が 1 つでもあるか（paneApproval.ts） */
  anyAskEach(): boolean;
}): WindowCommandTable {
  const { states, machines, labelOf } = deps.sessions;
  const up = (target: string) => untrack(states)[target]?.kind === "connected";

  /** Machine from の Pane から、Tab r に届くか。 */
  function reaches(from: string, r: TabRef): boolean {
    return windowReachAllowed(
      untrack(machines),
      from,
      targetOf(r),
      deps.granted(from),
    );
  }

  /** Machine from の Pane から見える・指せる Workspace（Sidebar に出ているもの。並びの順）。 */
  function visible(from: string): Gws[] {
    return untrack(deps.gws).list.filter(
      (g) =>
        !hiddenGws(g, deps.browser) &&
        (g.tabs.length === 0 || g.tabs.some((r) => reaches(from, r))),
    );
  }

  /** 引数 workspace（id か名前）が指す、見える Workspace 1 つ。無い・見えない・2 つ以上に当たるときは断る。 */
  function resolve(args: Record<string, unknown>, c: WindowCaller): Gws {
    const ref = argString(args, "workspace").trim();
    const seen = new Set(visible(c.from).map((g) => g.id));
    const found = gwsByRef(untrack(deps.gws), ref).filter((g) =>
      seen.has(g.id),
    );
    if (found.length === 1) return found[0];
    if (found.length > 1)
      throw new WindowCommandError(
        T("wsCli.err.ambiguous", {
          name: ref,
          count: found.length,
          ids: found.map((g) => g.id).join(", "),
        }),
      );
    throw new WindowCommandError(
      c.from === LOCAL
        ? T("wsCli.err.noWorkspace", { name: ref })
        : T("wsCli.err.noWorkspaceReach", { name: ref, from: labelOf(c.from) }),
    );
  }

  return {
    "workspace.list": {
      remote: true,
      run: (_args, c): { workspaces: WorkspaceInfo[] } => {
        const rows = untrack(deps.rows);
        return {
          workspaces: visible(c.from).map((g) => ({
            id: g.id,
            name: displayName(g),
            tabs: g.tabs.filter((r) => reaches(c.from, r)).length,
            ...(rows.find((r) => r.gws === g.id)?.band.focused
              ? { current: true as const }
              : {}),
            ...(g.tabs.some(
              (r) => r.kind === "term" && r.target === c.from && r.ws === c.tab,
            )
              ? { self: true as const }
              : {}),
          })),
        };
      },
    },

    "workspace.new": {
      remote: true,
      run: (args) => {
        const r = deps.workspaces.createEmptyWorkspace(argString(args, "name"));
        if ("error" in r) throw new WindowCommandError(r.error);
        return { id: r.id };
      },
    },

    "workspace.rename": {
      remote: true,
      run: (args, c) => {
        const g = resolve(args, c);
        const bad = deps.workspaces.renameWorkspace(
          g.id,
          argString(args, "name"),
        );
        if (bad) throw new WindowCommandError(bad);
        return { id: g.id };
      },
    },

    "workspace.close": {
      remote: true,
      run: async (args, c) => {
        const g = resolve(args, c);
        const force = argFlag(args, "force");
        // 中の Tab を全部閉じるので、届かない Tab があれば閉じない
        if (!g.tabs.every((r) => reaches(c.from, r)))
          throw new WindowCommandError(
            T("wsCli.err.closeReach", {
              name: displayName(g),
              from: labelOf(c.from),
            }),
          );
        // 人が「操作のたびに聞く」と決めた Pane があるうちは、リモートの Machine に、手元の PC の Terminal tab を、聞かずに閉じさせない
        if (
          c.from !== LOCAL &&
          deps.anyAskEach() &&
          g.tabs.some((r) => r.kind === "term" && r.target === LOCAL)
        )
          throw new WindowCommandError(T("tabCli.err.askEach"));
        const r = await deps.workspaces.closeWorkspaceNow(g.id, force);
        if (r === "running")
          throw new WindowCommandError(
            T("wsCli.err.running", { name: displayName(g) }),
            CODE_BUSY,
          );
        return { id: g.id };
      },
    },

    "workspace.move": {
      remote: true,
      run: (args, c) => {
        const g = resolve(args, c);
        const dir = argString(args, "dir");
        if (dir !== "up" && dir !== "down")
          throw new WindowCommandError(T("windowRun.err.arg", { name: "dir" }));
        return { id: g.id, moved: deps.workspaces.moveWorkspace(g.id, dir) };
      },
    },

    "workspace.show": {
      remote: true,
      run: (args, c) => {
        const g = resolve(args, c);
        const entries = tabEntries(untrack(deps.gws), untrack(deps.rows));
        // 人のキーが行く先：その Workspace が表示している Tab（無ければ、Tab の無い画面で、手元の PC のもの）
        const shown = entries.find((e) => e.gws.id === g.id && e.shown);
        const dest = shown ? shown.target : LOCAL;
        if (c.from !== LOCAL && !deps.granted(c.from)) {
          // キーの行き先が同じ Machine の中でしか変わらないときだけ（手元の PC やほかの Machine で打っているキーを奪えない）
          const now = entries.find((e) => e.focused);
          if (
            !(
              now?.ref.kind === "term" &&
              now.target === c.from &&
              dest === c.from
            )
          )
            throw new WindowCommandError(
              T("wsCli.err.focus", { from: labelOf(c.from) }),
            );
        }
        if (shown?.ref.kind === "term" && !up(shown.target))
          throw new WindowCommandError(
            T("err.session.notConnected", { machine: labelOf(shown.target) }),
          );
        if (shown) deps.tabs.activateTab(g.id, shown.ref);
        else {
          const row = untrack(deps.rows).find((r) => r.gws === g.id);
          if (row) deps.workspaces.goRow(row);
          else deps.workspaces.showGws(g.id);
        }
        return { id: g.id };
      },
    },
  };
}
