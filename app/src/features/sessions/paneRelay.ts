// `kisui pane … --machine`（#344）：別のマシンのペインへの頼みの中継。
// serve はマシンごとに 1 つで、自分のマシンのペインしか知らない。GUI は全部のマシンの serve につながっているので、
// 頼まれた serve の pane.relay を受け、名前（[[gui.machines]] の名前。local は手元の PC）のマシンの serve に pane.run で送る。
// open-tab（kisui pane open）は、pane.open と同じく GUI がそのマシンにタブを作る（openTab）。
// 答え（pane.relayed）は呼ぶ側が送る。確認は出さない（何をするかはコマンドの引数に出ている）。画面にも Tauri にも触らない。
//
// pane.relay は頼んだマシンの serve が作る通知なので、ssh 先のマシンのものは、手元の設定で許した先にだけ中継する
// （そのマシンの `allow_pane_to`。machines.ts の paneRelayAllowed）。手元の PC の serve のものは、どのマシンにも中継する。
import { untrack } from "solid-js";

import { T } from "../../i18n/index.ts";
import type {
  PaneOpenReport,
  PaneOpenRequest,
  PaneOrigin,
  PaneRunReply,
  PaneRunRequest,
} from "../../infrastructure/rpc/protocol.ts";
import type { Sessions } from "./controller.ts";
import { machineNames, machineTarget, paneRelayAllowed } from "./machines.ts";
import { LOCAL } from "./shell.ts";

/**
 * マシン from のペイン pane を、相手の serve に名乗る名前。serve は、この名前のペインが作ったペインと、その先にだけ届かせる
 * （server/panereach.go）。どの serve のペインかは、窓が from の接続から決める（頼みの通知に書いてあっても使わない）。
 * serverId は serve が自分で言う値なので、ssh 先の serve は、ほかのマシンの serverId を言える。だから、ssh 先のマシン from の
 * serverId が、つないでいるほかのマシンのものと同じなら、名乗らない（ほかのマシンのペインになりすませないように、どこにも
 * 届かせない）。手元の PC の serve は信頼するので、いつも名乗る。from がつながっていない・pane が無い（古い serve）ときも名乗らない。
 */
export function callerOrigin(
  serverIds: Record<string, string | undefined>,
  from: string,
  pane: string | undefined,
): PaneOrigin | undefined {
  const server = serverIds[from];
  if (!server || !pane) return undefined;
  for (const [target, id] of Object.entries(serverIds))
    if (from !== LOCAL && target !== from && id === server) return undefined;
  return { server, pane };
}

/** pane.relay を受けて、頼みをそのマシンで行う関数を作る。 */
export function createPaneRelay(deps: {
  sessions: Pick<Sessions, "sessions" | "states" | "machines" | "labelOf">;
  /** マシン target に、ワークスペースのターミナルのタブを開く（`kisui pane open`。投げずに、開けなければ理由を返す） */
  openTab(target: string, rq: PaneOpenRequest): Promise<PaneOpenReport>;
}) {
  const { sessions, states, machines, labelOf } = deps.sessions;
  /**
   * マシン from（pane.relay を送ってきた serve のマシン）の頼み rq を、マシン machine で行い、答えを返す
   * （投げない。できなければ error に理由）。
   */
  return async function relay(
    from: string,
    machine: string,
    rq: PaneRunRequest,
    by: { pane?: string; ancestry?: PaneOrigin[] } = {},
  ): Promise<PaneRunReply> {
    const list = untrack(machines);
    const name = machine.trim();
    const target = machineTarget(list, name);
    // ssh 先のマシンには、許していない先のことを何も教えない（その名前のマシンがあるかも、マシンの名前の一覧も）
    if (
      from !== LOCAL &&
      (target === undefined || !paneRelayAllowed(list, from, target))
    )
      return {
        error: T("paneRelay.err.notAllowed", {
          from: labelOf(from),
          machine: name,
        }),
      };
    if (target === undefined)
      return {
        error: T("paneRelay.err.noMachine", {
          machine: name,
          machines: machineNames(list).join(", "),
        }),
      };
    const all = untrack(sessions);
    const caller = callerOrigin(
      Object.fromEntries(
        Object.entries(all).map(([t, x]) => [t, x.connectedServerId]),
      ),
      from,
      by.pane,
    );
    if (rq.cmd === "open-tab") {
      const r = await deps.openTab(target, {
        id: "",
        workspace: rq.workspace ?? "",
        name: rq.name ?? "",
        // 無ければそのマシンの始めのフォルダ（workspace.create の dir 無し）
        dir: rq.cwd ?? "",
        ...(rq.new === true ? { new: true } : {}),
        ...(rq.argv?.length ? { argv: rq.argv } : {}),
        // 名乗れない送り元（callerOrigin）の作ったタブには、系譜を持たせない（どのペインからも届かない）
        ...(caller && by.ancestry?.length ? { ancestry: by.ancestry } : {}),
      });
      return "error" in r ? { error: r.error } : { ok: true, id: r.termId };
    }
    const s = all[target];
    if (!s || untrack(states)[target]?.kind !== "connected")
      return {
        error: T("err.session.notConnected", { machine: labelOf(target) }),
      };
    try {
      return await s.runPane(rq, caller);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };
}
