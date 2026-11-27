// `kisui db`（#516）の、Window の操作：Pane の中のコマンドが Window に頼む、Database tab の画面の操作（open・refresh・export・history・page・
// view・result・elevate-end）。commands/windowRun.ts の受け持ちの表を作る。行うことは、キー操作の Command（db.open・db.refresh・db.export・
// db.history・db.page・db.view・db.result・db.closeResult・db.elevateEnd）と同じで、違いは、相手の Tab を引数（id か名前。Database tab でなければ断る）で
// 指すことと、Dialog を出さないこと（今できないときは理由で断る）と、人のキーをどこにも向けないこと（`open` だけは、キーの
// db.open と同じく、足した Tab を表示する）。画面にも Tauri にも触らない。
// `kisui db query・schema・propose・connections`（Pane の serve が DB に直接つなぐもの）とは別の口で、それらは変えない。
//
// 作らないもの：
//   - db.elevate（権限を強める）：権限を強めるのは、人が Window で行う。docs/database.md の「Only you elevate」を、CLI でも守る
//     （強めた権限は、エージェントが自分で上げられない）。db.elevateEnd（強めた権限を今すぐ終える）は、弱める向きなので作る。
//   - db.tree（キーを Sidebar の schema tree に移す）：フォーカスを動かすだけ。
//
// 届く範囲：Database tab は手元の PC の Tab として扱う（`kisui tab` と同じ。sessions/machines.ts の windowReachAllowed）。
//   - 手元の PC の Pane からは、いつでも届く。
//   - リモートの Machine の Pane からは、Window の前の人が時間を決めて許している間（paneGrant.ts。Machine の Dialog の `p`）だけ届く。
//     許していなければ、一覧にも出さず、指されたら「無い」ときと同じ文で断る。`open` も、同じ許しが要る。
//   - 許している間でも、手元の PC に「操作のたびに聞く」と決めた Pane があるうちは、結果や DB の情報を Pane に返す頼み（export・history）は
//     リモートの Machine には通さない（needNoAskEach に理由を書いた）。
//   - export と history は、手元の PC の Pane にも、エージェントの権限が none の接続では通さない（結果と履歴は、人が人の権限で実行した
//     SQL のもの。`kisui db query` が none で断られるのに、エージェントが同じ中身を受け取れてはいけない）。
//   - 人のキーの行き先が変わるのは、`open` が足した Tab を表示するときだけ。行き先は手元の PC なので、keysMayMove を通す。
import { untrack, type Accessor } from "solid-js";

import { T } from "../../i18n/index.ts";
import {
  argOptionalString,
  argString,
  WindowCommandError,
  type WindowCaller,
  type WindowCommandTable,
} from "../commands/windowRun.ts";
import type { Sessions } from "../sessions/controller.ts";
import { windowReachAllowed } from "../sessions/machines.ts";
import { LOCAL } from "../sessions/shell.ts";
import {
  gwsByRef,
  gwsOfTerm,
  hiddenGws,
  type Gws,
  type GwsState,
} from "../workspaces/model.ts";
import type { Row } from "../workspaces/rows.ts";
import {
  findTabs,
  keysMayMove,
  tabEntries,
  type TabEntry,
} from "../workspaces/tabs/tabCommands.ts";
import type { DbTabs } from "./controller.ts";
import type { ExportFormat } from "./export.ts";

/** `kisui db history --json` の 1 つ（internal/db の履歴と同じ形）。 */
export interface HistoryInfo {
  sql: string;
  at: string;
  ok: boolean;
  /** エージェントが実行した文なら "agent" */
  actor?: string;
}

const FORMATS: readonly ExportFormat[] = ["csv", "tsv", "json"];

/** `kisui db` の Window の受け持ちの表を作る。 */
export function createDbCommands(deps: {
  sessions: Pick<Sessions, "machines" | "labelOf">;
  gws: Accessor<GwsState>;
  /** Sidebar の行（workspaces/controller.ts の rows） */
  rows: Accessor<readonly Row[]>;
  /** 内蔵ブラウザを使うか（使わなければ、Browser tab だけの Workspace は Sidebar に出ないので、足す先にしない） */
  browser: boolean;
  db: Pick<
    DbTabs,
    | "openConnection"
    | "reloadCatalog"
    | "reloadStructure"
    | "stepPage"
    | "showView"
    | "stepResultTab"
    | "closeResult"
    | "exportData"
    | "historyOf"
    | "agentRunOf"
    | "endNow"
    | "runOf"
  >;
  /** Machine from に、手元の PC の Pane の操作を、今、時間を決めて許しているか（paneGrant.ts） */
  granted(from: string): boolean;
  /** 手元の PC に、操作のたびに人に聞くと決めた Pane が 1 つでもあるか（paneApproval.ts） */
  anyAskEach(): boolean;
}): WindowCommandTable {
  const { machines, labelOf } = deps.sessions;

  /** Machine from の Pane から届く Tab（Sidebar の並びの順）。Database tab は手元の PC の Tab。 */
  function reachable(from: string): TabEntry[] {
    const list = untrack(machines);
    const granted = deps.granted(from);
    return tabEntries(untrack(deps.gws), untrack(deps.rows)).filter((e) =>
      windowReachAllowed(list, from, e.target, granted),
    );
  }

  /**
   * 引数 tab が指す、届く Database tab 1 つ。無い・届かない・2 つ以上に当たる・Database tab でないときは断る
   * （届かない Tab は、「無い」ときと同じ文で断る。リモートの Machine に、届かない Tab があるかを教えない）。
   */
  function resolve(
    args: Record<string, unknown>,
    c: WindowCaller,
  ): { e: TabEntry; id: string } {
    const tab = argString(args, "tab").trim();
    const found = findTabs(reachable(c.from), tab);
    if (found.length > 1)
      throw new WindowCommandError(
        T("tabCli.err.ambiguous", {
          tab,
          count: found.length,
          ids: found.map((x) => x.id).join(", "),
        }),
      );
    if (found.length === 0)
      throw new WindowCommandError(
        c.from === LOCAL
          ? T("tabCli.err.noTab", { tab })
          : T("tabCli.err.noTabReach", { tab, from: labelOf(c.from) }),
      );
    const e = found[0];
    if (e.ref.kind !== "db")
      throw new WindowCommandError(T("dbCli.err.notDb", { tab }));
    return { e, id: e.ref.id };
  }

  /**
   * 手元の PC に「操作のたびに聞く」と決めた Pane があるうちは、結果や DB の情報を Pane に返す頼み（export・history）を、リモートの Machine の
   * Pane には通さない（許している間でも）。人が「リモートの Machine の操作は、1 つずつ確かめる」と決めたことを、`kisui db` で聞かずに済ませない
   * ため（`kisui browser` の copy-url・find、`kisui tab close` と同じ）。結果と履歴は、人が人の権限で実行した SQL のもので、Pane の `read`
   * （これも「毎回聞く」の対象）と同じく、人の手元のデータそのもの。
   * 通す：何も返さず、人が Window で見て元に戻せる頼み（refresh・page・view・result・open）と、権限を弱める向きの elevate-end。
   * 手元の PC の Pane は、いつも通す（人が自分の Pane に決めたことは、人が見ている）。
   */
  function needNoAskEach(c: WindowCaller) {
    if (c.from !== LOCAL && deps.anyAskEach())
      throw new WindowCommandError(T("dbCli.err.askEach"));
  }

  /**
   * タブ id の接続で、エージェントが SQL を実行してよいときだけ通す（export・history）。none（権限を書いていない接続も）は断る。
   * 聞けなかったときは、その理由で断る（通さない側に倒す）。
   */
  async function needAgentRun(id: string) {
    let run: string;
    try {
      run = await deps.db.agentRunOf(id);
    } catch (e) {
      throw new WindowCommandError(e instanceof Error ? e.message : String(e));
    }
    if (run === "none") throw new WindowCommandError(T("dbCli.err.agentNone"));
  }

  /** 実行している間は、出している結果が変わるので、結果を返す頼みは断る。 */
  function needIdle(id: string) {
    if (deps.db.runOf(id).running)
      throw new WindowCommandError(T("dbCli.err.running"));
  }

  /** 引数 workspace（名前か id）が指す Workspace 1 つ。無い・2 つ以上に当たるときは断る。 */
  function workspaceOf(ref: string, c: WindowCaller): Gws {
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

  return {
    "db.open": {
      remote: true,
      run: async (args, c) => {
        const connection = argString(args, "connection");
        const variant = argOptionalString(args, "variant");
        // 手元の PC の Pane と、許している Machine の Pane だけ。行き先は手元の PC の Tab
        if (
          !windowReachAllowed(
            untrack(machines),
            c.from,
            LOCAL,
            deps.granted(c.from),
          ) ||
          !keysMayMove(
            tabEntries(untrack(deps.gws), untrack(deps.rows)),
            c.from,
            deps.granted(c.from),
            LOCAL,
          )
        )
          throw new WindowCommandError(
            T("dbCli.err.reach", { from: labelOf(c.from) }),
          );
        const ws = argOptionalString(args, "workspace");
        // 足す先：--workspace、無ければ頼んだ Pane の Terminal tab がある Workspace（キーの db.open は、今いる Workspace）
        const to =
          ws !== undefined
            ? workspaceOf(ws, c)
            : gwsOfTerm(untrack(deps.gws), c.from, c.tab);
        if (!to)
          throw new WindowCommandError(
            T("tabCli.err.noWorkspace", { name: "" }),
          );
        try {
          const ref = await deps.db.openConnection(
            to.id,
            c.from,
            connection,
            variant,
          );
          return { id: ref.id, workspace: to.id };
        } catch (e) {
          throw new WindowCommandError(
            e instanceof Error ? e.message : String(e),
          );
        }
      },
    },

    "db.refresh": {
      remote: true,
      run: (args, c) => {
        const { id } = resolve(args, c);
        // 木の一覧と、選んだテーブルの構造を聞き直す（キーと同じ）。終わりは待たない
        void deps.db.reloadCatalog(id);
        deps.db.reloadStructure(id);
        return { id };
      },
    },

    "db.export": {
      remote: true,
      run: async (args, c) => {
        const { id } = resolve(args, c);
        needNoAskEach(c);
        const format = argString(args, "format");
        if (!FORMATS.includes(format as ExportFormat))
          throw new WindowCommandError(
            T("windowRun.err.arg", { name: "format" }),
          );
        await needAgentRun(id);
        needIdle(id);
        const out = deps.db.exportData(id, format as ExportFormat);
        if (!out) throw new WindowCommandError(T("cannot.dbExport.text"));
        return {
          id,
          format,
          text: out.text,
          rows: out.rows,
          truncated: out.truncated,
          truncatedCells: out.truncatedCells,
        };
      },
    },

    "db.history": {
      remote: true,
      run: async (args, c): Promise<{ id: string; entries: HistoryInfo[] }> => {
        const { id } = resolve(args, c);
        needNoAskEach(c);
        await needAgentRun(id);
        let entries;
        try {
          entries = await deps.db.historyOf(id);
        } catch (e) {
          throw new WindowCommandError(
            e instanceof Error ? e.message : String(e),
          );
        }
        return {
          id,
          entries: (entries ?? []).map((x) => ({
            sql: x.sql,
            at: x.at,
            ok: x.ok,
            ...(x.actor ? { actor: x.actor } : {}),
          })),
        };
      },
    },

    "db.page": {
      remote: true,
      run: (args, c) => {
        const { id } = resolve(args, c);
        const dir = argString(args, "dir");
        if (dir !== "next" && dir !== "prev")
          throw new WindowCommandError(T("windowRun.err.arg", { name: "dir" }));
        const why = deps.db.stepPage(id, dir);
        if (why === "none")
          throw new WindowCommandError(T("cannot.dbPage.none"));
        if (why === "edge")
          throw new WindowCommandError(
            T(dir === "next" ? "cannot.dbPage.noNext" : "cannot.dbPage.noPrev"),
          );
        // 次のページの結果を待たない（実行している間に頼んだ分は、結果が来てから順に送る）
        return { id };
      },
    },

    "db.view": {
      remote: true,
      run: (args, c) => {
        const { id } = resolve(args, c);
        const view = argString(args, "view");
        if (view !== "data" && view !== "structure")
          throw new WindowCommandError(
            T("windowRun.err.arg", { name: "view" }),
          );
        if (!deps.db.showView(id, view))
          throw new WindowCommandError(T("cannot.dbView.text"));
        return { id };
      },
    },

    "db.result": {
      remote: true,
      run: (args, c) => {
        const { id } = resolve(args, c);
        const to = argString(args, "to");
        if (to === "close") {
          if (!deps.db.closeResult(id))
            throw new WindowCommandError(T("dbCli.err.noResult"));
          return { id, moved: true };
        }
        if (to !== "next" && to !== "prev")
          throw new WindowCommandError(T("windowRun.err.arg", { name: "to" }));
        return { id, moved: deps.db.stepResultTab(id, to === "next" ? 1 : -1) };
      },
    },

    "db.elevateEnd": {
      remote: true,
      run: async (args, c) => {
        const { id } = resolve(args, c);
        // 権限を弱める向きなので、聞く Pane があっても通す。強めるほうは、CLI を作らない
        const r = await deps.db.endNow(id);
        if (!("who" in r)) throw new WindowCommandError(r.text);
        return { id, ended: r.who };
      },
    },
  };
}
