// `kisui pane … --machine`（#344）：別のマシンのペインへの頼みの中継。
// serve はマシンごとに 1 つで、自分のマシンのペインしか知らない。GUI は全部のマシンの serve につながっているので、
// 頼まれた serve の pane.relay を受け、名前（[[gui.machines]] の名前。local は手元の PC）のマシンの serve に pane.run で送る。
// open-tab（kisui pane open）は、pane.open と同じく GUI がそのマシンにタブを作る（openTab）。
// 答え（pane.relayed）は呼ぶ側が送る。確認は出さない（何をするかはコマンドの引数に出ている）。画面にも Tauri にも触らない。
import { untrack } from "solid-js";

import { T } from "../../i18n/index.ts";
import type {
  PaneOpenReport,
  PaneOpenRequest,
  PaneRunReply,
  PaneRunRequest,
} from "../../infrastructure/rpc/protocol.ts";
import type { Sessions } from "./controller.ts";
import { machineNames, machineTarget } from "./machines.ts";

/** pane.relay を受けて、頼みをそのマシンで行う関数を作る。 */
export function createPaneRelay(deps: {
  sessions: Pick<Sessions, "sessions" | "states" | "machines" | "labelOf">;
  /** マシン target に、ワークスペースのターミナルのタブを開く（`kisui pane open`。投げずに、開けなければ理由を返す） */
  openTab(target: string, rq: PaneOpenRequest): Promise<PaneOpenReport>;
}) {
  const { sessions, states, machines, labelOf } = deps.sessions;
  /** マシン machine で rq を行い、答えを返す（投げない。できなければ error に理由）。 */
  return async function relay(
    machine: string,
    rq: PaneRunRequest,
  ): Promise<PaneRunReply> {
    const list = untrack(machines);
    const name = machine.trim();
    const target = machineTarget(list, name);
    if (target === undefined)
      return {
        error: T("paneRelay.err.noMachine", {
          machine: name,
          machines: machineNames(list).join(", "),
        }),
      };
    if (rq.cmd === "open-tab") {
      const r = await deps.openTab(target, {
        id: "",
        workspace: rq.workspace ?? "",
        name: rq.name ?? "",
        // 無ければそのマシンの始めのフォルダ（workspace.create の dir 無し）
        dir: rq.cwd ?? "",
        ...(rq.new === true ? { new: true } : {}),
        ...(rq.argv?.length ? { argv: rq.argv } : {}),
      });
      return "error" in r ? { error: r.error } : { ok: true, id: r.termId };
    }
    const s = untrack(sessions)[target];
    if (!s || untrack(states)[target]?.kind !== "connected")
      return {
        error: T("err.session.notConnected", { machine: labelOf(target) }),
      };
    try {
      return await s.runPane(rq);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };
}
