// フォーカスしているワークスペースのターミナルのペイン（F1・F4）の持ち物と操作。
// マシンごと・ワークスペースごとのターミナル（TermGroups。作るのは features/sessions/controller.ts）のうち、フォーカスしているものを出す。
// プライマリ以外のペインを隠す（Ctrl+Shift+M）・shj の頼みでペインを出す・ペインを分けて足す、を受け持つ。
// 画面にも Tauri にも触らない。キーをターミナルに向けるのは、受け取った focusTerminal に頼む。
import { T } from "../../i18n/index.ts";
import { createEffect, createSignal, untrack, type Accessor } from "solid-js";

import type {
  ExtraPane,
  SplitDir,
  Workspace,
  WorkspaceId,
} from "../../infrastructure/rpc/protocol.ts";
import type { Session } from "../sessions/session.ts";
import type { WorkspaceFocus } from "../workspaces/rows.ts";
import type { TermGroup, TermGroups } from "./group.ts";
import type { MediaFetch } from "./media.ts";

/** createTerminals が返す持ち物。 */
export type Terminals = ReturnType<typeof createTerminals>;

/** ターミナルのペインの持ち物を作る。フォーカスしているワークスペースのペインの並びを出し、プライマリ以外を隠す・ペインを分けて足すを受け持つ。 */
export function createTerminals(deps: {
  sessions: Accessor<Record<string, Session>>;
  workspaces: Accessor<Record<string, Workspace[]>>;
  /** マシンごとのターミナル（つないだときに features/sessions/controller.ts が入れる） */
  termGroups: Map<string, TermGroups>;
  /** 画面に出すターミナルのタブ（どのマシンの、どのワークスペースか）。ターミナルのタブを持たないワークスペースに居る間は null */
  focus: Accessor<WorkspaceFocus | null>;
  /** 今使っているペイン（ブラウザのタブを出していればそのページ）にキーを向ける */
  focusTerminal: () => void;
}) {
  const { sessions, workspaces, termGroups, focus, focusTerminal } = deps;
  // 並びが変わったら termVersion を進める（TermGroup は signal ではない）
  const [termVersion, setTermVersion] = createSignal(0);
  const termTarget = () => focus()?.target;
  const termGroup = (): TermGroup | undefined => {
    void termVersion();
    const f = focus();
    return f && sessions()[f.target]
      ? termGroups.get(f.target)?.get(f.id)
      : undefined;
  };
  const termList = () => termGroup()?.list ?? [];
  // プライマリ以外の欄を隠しているワークスペース（マシンとワークスペースの組）。GUI だけで持つ。隠した欄のターミナルは止めない
  const [zoomedWs, setZoomedWs] = createSignal<
    ReadonlyMap<string, { target: string; id: WorkspaceId }>
  >(new Map());
  const wsKey = (target: string, id: WorkspaceId) =>
    JSON.stringify([target, id]);
  /** そのワークスペースのプライマリで shj が動いているか */
  const primaryShjOn = (target: string, id: WorkspaceId) =>
    !!workspaces()[target]?.find((w) => w.id === id)?.primaryShj;
  const zoomed = () => {
    const f = focus();
    return (
      !!f &&
      zoomedWs().has(wsKey(f.target, f.id)) &&
      primaryShjOn(f.target, f.id)
    );
  };
  // プライマリの shj が終わったら（#549 の primaryShj が null）、隠していた欄を出す
  createEffect(() => {
    void workspaces();
    const cur = untrack(zoomedWs);
    const keep = [...cur].filter(([, v]) => primaryShjOn(v.target, v.id));
    if (keep.length !== cur.size) setZoomedWs(new Map(keep));
  });
  /**
   * ワークスペース（target, id）のプライマリ以外の欄を隠す・戻す。プライマリで shj が動いていなければ何もしない。
   * 隠すときはプライマリを使う欄にする。そのワークスペースにフォーカスしているときだけ、キーを向け直す。
   */
  function zoomWs(
    target: string,
    id: WorkspaceId,
    on: boolean | "toggle",
  ): boolean {
    if (!primaryShjOn(target, id)) return false;
    const k = wsKey(target, id);
    const was = zoomedWs().has(k);
    const want = on === "toggle" ? !was : on;
    if (want === was) return want;
    const next = new Map(zoomedWs());
    if (want) {
      next.set(k, { target, id });
      termGroups.get(target)?.get(id)?.setActive(0);
    } else next.delete(k);
    setZoomedWs(next);
    const f = untrack(focus);
    if (f && f.target === target && f.id === id) focusTerminal();
    return want;
  }
  /** フォーカスしているワークスペースで zoomWs する（Ctrl+Shift+M）。 */
  function setZoom(on: boolean | "toggle" = "toggle"): boolean {
    const f = focus();
    return f ? zoomWs(f.target, f.id, on) : false;
  }
  /** shj が端末のコマンドで欄を出した（muxBackend の show・split）。隠していれば戻し、その欄にキーを向ける。 */
  function paneShow(target: string, id: WorkspaceId, termId: string) {
    zoomWs(target, id, false);
    termGroups.get(target)?.get(id)?.activate(termId);
    const f = untrack(focus);
    if (f && f.target === target && f.id === id) focusTerminal();
  }
  const termActive = () => termGroup()?.active;
  const termExtras = () => termGroup()?.extras ?? [];
  const termLayout = () => termGroup()?.layout;
  const termActiveExtra = () => termGroup()?.activeExtra;
  // shj が動画などの欄を出した回数（ツリーで押したファイルの返事で、動画の欄から奪い返さないため）
  let extraShown = 0;
  /** shj が動画の欄を出した（#555）。隠していれば戻し、その欄にキーを向ける。 */
  function paneShowExtra(target: string, id: WorkspaceId, extraId: string) {
    extraShown++;
    zoomWs(target, id, false);
    termGroups.get(target)?.get(id)?.activateExtra(extraId);
    const f = untrack(focus);
    if (!f || f.target !== target || f.id !== id) return;
    focusTerminal();
  }
  // 隠している間（zoomed）はつまみが出ないので、境界も無いものとする
  const termBars = () => (zoomed() ? [] : (termGroup()?.bars ?? []));

  /** フォーカスしているワークスペースの、ターミナルでない欄（動画）の中身を取る関数。 */
  function readExtra(pane: ExtraPane): MediaFetch {
    const f = focus();
    const s = f ? sessions()[f.target] : undefined;
    const workspaceId = f?.id;
    return async (p) => {
      if (!s || workspaceId === undefined)
        throw new Error(T("status.disconnected"));
      return s.request("media.read", { workspaceId, id: pane.id, ...p });
    };
  }

  /** 今の欄を右・下・左・上に分けてターミナルを足し、キーを向ける（Cmd+D・Ctrl+Shift+D など。F4）。フォーカスしているワークスペースに属する。 */
  function newTerminal(dir: SplitDir) {
    // 隠している欄があれば先に戻す（足した欄が見えないままになるため）
    setZoom(false);
    // フォルダは shj が決める（ワークスペースのフォルダ。未定なら start_dir）
    void termGroup()
      ?.add(dir)
      .then((added) => {
        if (added) focusTerminal();
      });
  }

  return {
    /** ターミナルの並びが変わった（描き直す） */
    changed: () => setTermVersion((v) => v + 1),
    termTarget,
    termGroup,
    termList,
    termActive,
    termExtras,
    termLayout,
    termActiveExtra,
    termBars,
    zoomed,
    zoomWs,
    setZoom,
    paneShow,
    paneShowExtra,
    /** shj が動画などのペインを出した回数（ツリーで押したファイルの返事で、動画のペインから奪い返さないため） */
    extraShown: () => extraShown,
    readExtra,
    newTerminal,
  };
}
