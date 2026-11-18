// ワークスペースのプライマリの shj に、ファイルを開く・差分を出すことを頼む（ツリーと CHANGES の行を押したとき）。
// 画面にも Tauri にも触らない。
import type { Accessor } from "solid-js";

import type {
  PrimaryShj,
  Workspace,
  WorkspaceId,
} from "../../infrastructure/rpc/protocol.ts";
import type { ReportProblem } from "../problem.ts";
import type { Session } from "../sessions/session.ts";
import type { TermGroup } from "../terminal/group.ts";

/** プライマリの shj に頼む関数（createPrimaryShj が返す）。 */
export type AskPrimaryShj = ReturnType<typeof createPrimaryShj>;

/** プライマリの shj に頼む関数を作る。続けて頼んだときは、最後に頼んだものの結果だけを使う。 */
export function createPrimaryShj(deps: {
  sessions: Accessor<Record<string, Session>>;
  workspaces: Accessor<Record<string, Workspace[]>>;
  /** ワークスペースを移している途中か */
  isSwitching: () => boolean;
  /** shj が動画などのペインを出した回数 */
  extraShown: () => number;
  /** フォーカスしているワークスペースのターミナル */
  termGroup: () => TermGroup | undefined;
  focusTerminal: () => void;
  setFocusError: ReportProblem;
}) {
  const { sessions, workspaces, termGroup, focusTerminal, setFocusError } =
    deps;
  let openSeq = 0;
  /**
   * ツリー・CHANGES の行を押した。プライマリの shj に method（shj.open か shj.diff）を送り、通ったらプライマリのターミナルにキーを向ける。
   * ready は、その shj が受けられる状態か（ツリーはプライマリで shj が動いているときだけ、CHANGES は差分モードのときだけ出すので、そうでなければ何もしない）。
   * 断られたら、帯を押して移れなかったときと同じ所に title と errorText の文を出す。
   * ワークスペースを移している途中は送らない（フォーカスを移した先のワークスペースのプライマリで開くため）。
   */
  function askPrimaryShj(
    method: "shj.open" | "shj.diff",
    target: string,
    id: WorkspaceId,
    path: string,
    ready: (shj: PrimaryShj | null | undefined) => boolean,
    title: string,
    errorText: (path: string, e: unknown) => string,
  ) {
    const s = sessions()[target];
    if (!s || deps.isSwitching() || s.focus !== id) return;
    if (!ready(workspaces()[target]?.find((w) => w.id === id)?.primaryShj))
      return;
    const seq = ++openSeq; // 続けて押したら、最後に押したものの失敗だけを出す
    setFocusError(null);
    const shown = deps.extraShown();
    s.request(method, { workspaceId: id, path }).then(
      () => {
        // 返事を待つあいだに別のワークスペースへ移っていたら、そちらのターミナルは動かさない
        if (seq !== openSeq || s.focus !== id) return;
        // 動画だった（shj が動画の欄を出して、そこにキーを向けた）なら、プライマリに奪い返さない
        if (deps.extraShown() !== shown) return;
        termGroup()?.setActive(0); // 0 番目がプライマリ
        focusTerminal();
      },
      (e) => {
        if (seq !== openSeq) return;
        setFocusError({ title, error: errorText(path, e) });
      },
    );
  }

  return askPrimaryShj;
}
