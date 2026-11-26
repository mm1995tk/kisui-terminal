// shj が端末のコマンド（kisui pane …・kisui open・kisui update など）で GUI に頼んだこと（Session の onPane）を、受け持つ所へ振り分ける。
import type {
  DbProposeReport,
  DbProposeRequest,
  PaneOpenReport,
  PaneOpenRequest,
  PaneOrigin,
  PaneRunReply,
  PaneRunRequest,
  WorkspaceId,
} from "../../infrastructure/rpc/protocol.ts";
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
  /** マシン target に、ワークスペースのターミナルのタブを開く（`kisui pane open`。投げずに、開けなければ理由を返す） */
  openTab(target: string, rq: PaneOpenRequest): Promise<PaneOpenReport>;
  /**
   * マシン from のペインが頼んだ、別のマシン machine のペインへの頼みを中継する（`kisui pane … --machine`。投げずに、できなければ理由を返す）。
   * from は頼みの通知を送ってきた serve のマシン（中継してよいかを、これで決める）
   */
  relay(
    from: string,
    machine: string,
    rq: PaneRunRequest,
    /** 待ちの id（取り下げで使う）・頼んだペインの id（from の serve でのもの）・open-tab で作るタブに持たせる系譜 */
    by: { id?: string; pane?: string; ancestry?: PaneOrigin[] },
  ): Promise<PaneRunReply>;
  /** マシン from の serve が、頼み id を取り下げた（人に聞いている途中なら、聞くのをやめる） */
  relayCancel(from: string, id: string): void;
  /** マシン target の接続の DB のタブの入力欄に、SQL を書く（`kisui db propose`。投げずに、書けなければ理由を返す） */
  dbPropose(target: string, rq: DbProposeRequest): Promise<DbProposeReport>;
  /** マシン target の `kisui db propose` の取り下げ（人に聞いている途中なら、聞くのをやめる） */
  dbProposeCancel(target: string, id: string): void;
  /** プライマリ以外の欄を隠す・戻す */
  zoomWs(target: string, id: WorkspaceId, on: boolean | "toggle"): boolean;
}

/** マシン target の shj の頼み ev を、to の受け持ちへ渡す。 */
export function routePaneEvent(
  to: PaneEventTargets,
  target: string,
  ev: PaneEvent,
  s: Pick<
    Session,
    | "reportUpdate"
    | "reportPaneOpened"
    | "reportPaneRelayed"
    | "reportDbProposed"
  >,
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
  else if (ev.kind === "open-tab")
    void to.openTab(target, ev).then((r) => s.reportPaneOpened(ev.id, r));
  else if (ev.kind === "relay")
    void to
      .relay(target, ev.machine, ev.request, {
        id: ev.id,
        pane: ev.pane,
        ancestry: ev.ancestry,
      })
      .then((r) => s.reportPaneRelayed(ev.id, r));
  else if (ev.kind === "relay-cancel") to.relayCancel(target, ev.id);
  else if (ev.kind === "db-propose")
    void to.dbPropose(target, ev).then((r) => s.reportDbProposed(ev.id, r));
  else if (ev.kind === "db-propose-cancel") to.dbProposeCancel(target, ev.id);
  else to.zoomWs(target, ev.workspaceId, true);
}
