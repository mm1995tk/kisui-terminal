// shj が端末のコマンド（kisui pane …・kisui open・kisui update など）で GUI に頼んだこと（Session の onPane）を、受け持つ所へ振り分ける。
import type { WorkspaceId } from "../../infrastructure/rpc/protocol.ts";
import type { PaneEvent, Session } from "../sessions/session.ts";
import type { UpdateOutcome } from "../updates/store.ts";

/** 頼みごとの行き先。 */
export interface PaneEventTargets {
  /** shj が端末のコマンドで欄を出した。隠していれば戻し、その欄にキーを向ける */
  paneShow(target: string, id: WorkspaceId, termId: string): void;
  /** shj が動画などの欄を出した */
  paneShowExtra(target: string, id: WorkspaceId, extraId: string): void;
  /** shj が引数なしで起動した直後の、ツリーへのフォーカスの頼み */
  requestStartFocus(target: string, id: WorkspaceId): void;
  /** shj の Space e：サイドバーのファイルツリーにキーを向ける */
  focusExplorer(target: string, id: WorkspaceId): void;
  /** shj の Space E・cmd.diffchanges：サイドバーの CHANGES にキーを向ける */
  focusChanges(target: string, id: WorkspaceId): void;
  /** URL を開く（`kisui open`・shj の URL を開く要求） */
  openUrlFor(target: string, url: string, ws?: WorkspaceId): void;
  /** 新しい版を調べ直す（`kisui update`） */
  checkNow(): Promise<UpdateOutcome>;
  /** プライマリ以外の欄を隠す・戻す */
  zoomWs(target: string, id: WorkspaceId, on: boolean | "toggle"): boolean;
}

/** マシン target の shj の頼み ev を、to の受け持ちへ渡す。 */
export function routePaneEvent(
  to: PaneEventTargets,
  target: string,
  ev: PaneEvent,
  s: Pick<Session, "reportUpdate">,
): void {
  if (ev.kind === "show") to.paneShow(target, ev.workspaceId, ev.termId);
  else if (ev.kind === "show-extra")
    to.paneShowExtra(target, ev.workspaceId, ev.extraId);
  else if (ev.kind === "explorer") {
    if (ev.start) to.requestStartFocus(target, ev.workspaceId);
    else to.focusExplorer(target, ev.workspaceId);
  } else if (ev.kind === "changes") to.focusChanges(target, ev.workspaceId);
  else if (ev.kind === "open-url")
    to.openUrlFor(target, ev.url, ev.workspaceId);
  else if (ev.kind === "update-check")
    void to.checkNow().then((r) => s.reportUpdate(ev.id, r));
  else to.zoomWs(target, ev.workspaceId, true);
}
