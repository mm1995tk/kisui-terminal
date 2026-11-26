// `kisui pane open`（#343）：ペインの中のコマンドが頼んだ、GUI のワークスペースへのターミナルのタブの追加。
// serve の pane.open を受け、ワークスペースを名前で探し（--new なら作り）、タブを作るマシンの serve に workspace.create
// （argv・env・name つき）を送って、できたタブをそのワークスペースの一番後ろに入れる。フォーカスは移さない（今いるワークスペースも、
// そのワークスペースで最後に使っていたタブも変えない）。答え（pane.opened）は呼ぶ側が送る。
// タブを作るマシン（target）は呼ぶ側が決める。頼んだ serve のマシンか、`--machine` で指したマシン（#344。sessions/paneRelay.ts）。
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
  gwsByRef,
  gwsNameErrorText,
  hiddenGws,
  isGwsIdLike,
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
 * `--workspace name`（isNew は `--new`）から、タブを入れる先を決める。name は、サイドバーに出ている名前（名前を付けていなければ「ws1」）か、
 * ワークスペースの id（`kisui pane list` に出る。id の形の値は、先に id として探す。gwsByRef）。
 * --new が無ければ、その名前のワークスペースが 1 つだけあればそこ。無い・2 つ以上なら断る（どちらに入れるか決められない）。
 * id で指せば、同じ名前のワークスペースが 2 つあっても 1 つに決まる。
 * --new なら、その名前のワークスペースがもうあれば断る（同じ名前が 2 つになると、後で名前で指せなくなる）。名前の決まりに合わなくても断る
 * （id の形の名前も。gwsNameErrorText）。
 * browser は内蔵ブラウザを使うか。使わないとき、ブラウザのタブしか持たないワークスペース（hiddenGws）はサイドバーに出ないので、
 * 入れ先には選ばない（--new の重なりには数える。内蔵ブラウザを有効に戻すと、同じ名前が 2 つ出てしまうため）。
 */
export function planPaneOpen(
  s: GwsState,
  name: string,
  isNew: boolean,
  browser = true,
): PaneOpenPlan {
  const n = name.trim();
  // --new の name は作る名前なので、id としては探さない
  const all = isNew ? gwsByName(s, n) : gwsByRef(s, n);
  const found = all.filter((g) => !hiddenGws(g, browser));
  // 隠れたワークスペースとだけ重なるときは、--new を付けても外しても開けないので、別の名前を勧める
  if (found.length === 0 && all.length > 0)
    return { kind: "error", error: T("paneOpen.err.hidden", { name: n }) };
  if (isNew) {
    if (all.length > 0)
      return { kind: "error", error: T("paneOpen.err.exists", { name: n }) };
    const bad = gwsNameErrorText(n);
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
 * 作るのを待つ間に、入れる先のワークスペースが閉じられていたら、その名前で作り直す（id で指していたら、同じ id では作り直せず、
 * id の形の名前も付けられないので、番号の名前で作る）。--new で、待つ間に同じ名前のものが 1 つできていたら、そこに入れる。
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
    const asked = workspace.trim();
    next = addEmptyWorkspace(
      s,
      plan.kind === "new" ? plan.name : isGwsIdLike(asked) ? "" : asked,
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
  /** 内蔵ブラウザを使うか（設定の [gui.browser] enabled。使わなければ、ブラウザのタブだけのワークスペースは入れ先にしない） */
  browser: boolean;
  /** 作ったばかりで、マシンの一覧の知らせがまだ届いていないターミナルのタブ（reconcile が外さない） */
  justCreated: Set<string>;
}) {
  const { sessions, states, workspaces, labelOf } = deps.sessions;
  /** target のマシンに、rq のタブを開く。開けたら作ったペインの id、開けなければ理由を返す（投げない）。 */
  return async function openTab(
    target: string,
    rq: PaneOpenRequest,
  ): Promise<PaneOpenReport> {
    const plan = planPaneOpen(
      untrack(deps.gws),
      rq.workspace,
      rq.new === true,
      deps.browser,
    );
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
