// サイドバーの CHANGES（差分モードの変更の一覧）の操作。
// 一覧を出す・行を押して差分を出す・shj の CHANGES のキー（s・r・R・Space・:）を渡す、を受け持つ。
// 画面にも Tauri にも触らない。
import { T } from "../../i18n/index.ts";
import type { Accessor } from "solid-js";

import type {
  ChangesShjKey,
  Workspace,
  WorkspaceId,
} from "../../infrastructure/rpc/protocol.ts";
import type { ReportProblem } from "../problem.ts";
import type { Session } from "../sessions/session.ts";
import type { TermGroup } from "../terminal/group.ts";
import type { AskPrimaryShj } from "../workspaces/primaryShj.ts";
import type { WorkspaceFocus } from "../workspaces/rows.ts";
import { afterChangesKey } from "./handover.ts";
import { changeErrorText, changeRows, changesBaseOf } from "./model.ts";

export type Changes = ReturnType<typeof createChanges>;

export function createChanges(deps: {
  sessions: Accessor<Record<string, Session>>;
  workspaces: Accessor<Record<string, Workspace[]>>;
  focus: Accessor<WorkspaceFocus | null>;
  /** ワークスペースのフォルダ（未定・分からなければ undefined） */
  rootOf: (target: string, id: WorkspaceId) => string | undefined;
  /** workspace.step で続けて移っている間か（この間は CHANGES を出さない） */
  walking: Accessor<boolean>;
  /** ワークスペースを移している途中か */
  isSwitching: () => boolean;
  askPrimaryShj: AskPrimaryShj;
  /** フォーカスしているワークスペースのターミナル */
  termGroup: () => TermGroup | undefined;
  focusTerminal: () => void;
  setFocusError: ReportProblem;
}) {
  const {
    sessions,
    workspaces,
    focus,
    rootOf,
    walking,
    askPrimaryShj,
    termGroup,
    focusTerminal,
    setFocusError,
  } = deps;
  /** CHANGES の行を押した（shj.diff。path は shj が知らせた絶対パス）。 */
  const openChange = (target: string, id: WorkspaceId, path: string) =>
    askPrimaryShj(
      "shj.diff",
      target,
      id,
      path,
      (shj) => !!shj?.diff,
      T("err.diff.show"),
      changeErrorText,
    );

  /**
   * CHANGES で押した shj のキー（s・r・R・Space・:）を、shj に「CHANGES で押した」ものとして渡す。
   * s・r・R は一覧にフォーカスを残す。Space と : は、通ってからプライマリのターミナルにキーを向ける（handover.ts。先に向けると続きのキーが先に届く）。
   */
  function changesShjKey(target: string, id: WorkspaceId, key: ChangesShjKey) {
    const s = sessions()[target];
    if (!s || deps.isSwitching() || s.focus !== id) return;
    setFocusError(null);
    afterChangesKey(
      key,
      s.request("shj.changesKey", { workspaceId: id, key }),
      {
        toTerminal: () => {
          if (s.focus !== id) return;
          termGroup()?.setActive(0); // 0 番目がプライマリ
          focusTerminal();
        },
        fail: (e) =>
          setFocusError({
            title: T("err.changes.op"),
            error: e instanceof Error ? e.message : String(e),
          }),
      },
    );
  }

  /** 差分モードの CHANGES の一覧。フォーカスしているワークスペースの、差分モードのプライマリの shj のものだけ。 */
  function changesOf(target: string, id: WorkspaceId) {
    if (walking()) return undefined;
    const f = focus();
    if (f?.target !== target || f.id !== id) return undefined;
    const diff = workspaces()[target]?.find((x) => x.id === id)?.primaryShj
      ?.diff;
    return diff
      ? {
          rows: changeRows(diff, rootOf(target, id)),
          base: changesBaseOf(diff),
        }
      : undefined;
  }

  return { openChange, changesShjKey, changesOf };
}
