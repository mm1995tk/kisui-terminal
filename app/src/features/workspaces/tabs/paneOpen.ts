// `kisui pane open`（#343）：ペインの中のコマンドが頼んだ、GUI のワークスペースへのターミナルのタブの追加。
// serve の pane.open を受け、ワークスペースを名前で探し（--new なら作り）、タブを作るマシンの serve に workspace.create
// （argv・env・name つき）を送って、できたタブをそのワークスペースの一番後ろに入れる。フォーカスは移さない（今いるワークスペースも、
// そのワークスペースで最後に使っていたタブも変えない）。答え（pane.opened）は呼ぶ側が送る。
// タブを作るマシン（target）は呼ぶ側が決める。今は頼んだ serve のマシン。別のマシンに開く（--machine。#344）ときも、target を変えればよい。
// 画面にも Tauri にも触らない。
import { T } from "../../../i18n/index.ts";
import { untrack, type Accessor } from "solid-js";

import type {
  PaneOpenReport,
  PaneOpenRequest,
  WorkspaceId,
} from "../../../infrastructure/rpc/protocol.ts";
import type { Sessions } from "../../sessions/controller.ts";
import {
  addEmptyWorkspace,
  addTerm,
  gwsByName,
  nameErrorText,
  newGwsId,
  termKey,
  type GwsState,
} from "../model.ts";

/** タブを入れる先：あるワークスペース（id）か、新しく作るワークスペース（名前）か、断る理由か。 */
export type PaneOpenPlan =
  | { kind: "into"; gid: string }
  | { kind: "new"; name: string }
  | { kind: "error"; error: string };

/**
 * `--workspace name`（isNew は `--new`）から、タブを入れる先を決める。名前は、サイドバーに出ている名前（名前を付けていなければ「ws1」）。
 * --new が無ければ、その名前のワークスペースが 1 つだけあればそこ。無い・2 つ以上なら断る（どちらに入れるか決められない）。
 * --new なら、その名前のワークスペースがもうあれば断る（同じ名前が 2 つになると、後で名前で指せなくなる）。名前の決まりに合わなくても断る。
 */
export function planPaneOpen(
  s: GwsState,
  name: string,
  isNew: boolean,
): PaneOpenPlan {
  const n = name.trim();
  const found = gwsByName(s, n);
  if (isNew) {
    if (found.length > 0)
      return { kind: "error", error: T("paneOpen.err.exists", { name: n }) };
    const bad = nameErrorText(n);
    return bad ? { kind: "error", error: bad } : { kind: "new", name: n };
  }
  if (found.length === 0)
    return { kind: "error", error: T("paneOpen.err.noWorkspace", { name: n }) };
  if (found.length > 1)
    return {
      kind: "error",
      error: T("paneOpen.err.ambiguous", { name: n, count: found.length }),
    };
  return { kind: "into", gid: found[0].id };
}

/**
 * 作ったタブ（target のマシンのワークスペース ws）を、plan の先の一番後ろに入れる（最後に使っていたタブは変えない）。
 * 作るのを待つ間に、入れる先のワークスペースが閉じられていたら、その名前で作り直す。--new で、待つ間に同じ名前のものが
 * 1 つできていたら、そこに入れる。
 */
export function placeOpenedTab(
  s: GwsState,
  plan: Exclude<PaneOpenPlan, { kind: "error" }>,
  workspace: string,
  target: string,
  ws: WorkspaceId,
  id: string = newGwsId(),
): GwsState {
  let gid: string | undefined;
  if (plan.kind === "into") {
    if (s.list.some((g) => g.id === plan.gid)) gid = plan.gid;
  } else {
    const found = gwsByName(s, plan.name);
    if (found.length === 1) gid = found[0].id;
  }
  let next = s;
  if (gid === undefined) {
    gid = id;
    next = addEmptyWorkspace(
      s,
      plan.kind === "new" ? plan.name : workspace.trim(),
      gid,
    );
  }
  return addTerm(next, gid, target, ws, "", false);
}

/** pane.open を受けてタブを開く関数を作る。 */
export function createPaneOpen(deps: {
  sessions: Pick<Sessions, "sessions" | "states" | "workspaces" | "labelOf">;
  gws: Accessor<GwsState>;
  setGws: (f: (g: GwsState) => GwsState) => void;
  /** 作ったばかりで、マシンの一覧の知らせがまだ届いていないターミナルのタブ（reconcile が外さない） */
  justCreated: Set<string>;
}) {
  const { sessions, states, workspaces, labelOf } = deps.sessions;
  /** target のマシンに、rq のタブを開く。開けたら作ったペインの id、開けなければ理由を返す（投げない）。 */
  return async function openTab(
    target: string,
    rq: PaneOpenRequest,
  ): Promise<PaneOpenReport> {
    const plan = planPaneOpen(untrack(deps.gws), rq.workspace, rq.new === true);
    if (plan.kind === "error") return { error: plan.error };
    const s = sessions()[target];
    if (!s || states()[target]?.kind !== "connected")
      return {
        error: T("err.session.notConnected", { machine: labelOf(target) }),
      };
    let made: { id: WorkspaceId; termId: string };
    try {
      made = await s.createWorkspace(rq.dir, {
        argv: rq.argv,
        env: rq.env,
        name: rq.name,
      });
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
    // 一覧の知らせが返事より先に届いていれば、整理はもう済んでいる（createMachineWorkspace と同じ）
    if (!untrack(workspaces)[target]?.some((w) => w.id === made.id))
      deps.justCreated.add(termKey(target, made.id));
    deps.setGws((g) => placeOpenedTab(g, plan, rq.workspace, target, made.id));
    return { termId: made.termId };
  };
}
