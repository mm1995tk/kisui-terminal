// サイドバーのファイルツリー（D2）の持ち物と操作。
// マシンごとのツリー（WorkspaceTrees。作るのは features/sessions/controller.ts）のうち、フォーカスしているワークスペースのものだけを動かす（監視と取り直し）。
// 行を押してファイルを開く、右クリックのメニュー（コピー・cd・新規・名前の変更・削除）を受け持つ。
// 画面にも Tauri にも触らない。スクロールの位置を戻す・コピーするのは、受け取った関数に頼む。
import { T } from "../../i18n/index.ts";
import {
  createEffect,
  createMemo,
  createSignal,
  untrack,
  type Accessor,
} from "solid-js";

import { ErrorCode, RpcError } from "../../infrastructure/rpc/message.ts";
import type {
  Workspace,
  WorkspaceId,
} from "../../infrastructure/rpc/protocol.ts";
import type { ReportProblem } from "../problem.ts";
import type { Session } from "../sessions/session.ts";
import type { AskPrimaryShj } from "../workspaces/primaryShj.ts";
import type { WorkspaceFocus } from "../workspaces/rows.ts";
import {
  absolutePath,
  newEntryPath,
  parentPath,
  renamedPath,
  type TreeMenuAction,
} from "./menu.ts";
import {
  openErrorText,
  relativeIn,
  rows as treeRows,
  type TreeRow,
} from "./model.ts";
import type { WorkspaceTrees } from "./trees.ts";

/** createFileTree が返す持ち物。 */
export type FileTree = ReturnType<typeof createFileTree>;

/** ファイルツリーの持ち物を作る。フォーカスしているワークスペースのツリーだけを動かし、行を開く・メニューの操作（コピー・cd・新規・名前の変更・削除）を受け持つ。 */
export function createFileTree(deps: {
  sessions: Accessor<Record<string, Session>>;
  workspaces: Accessor<Record<string, Workspace[]>>;
  /** マシンごとのツリー（つないだときに features/sessions/controller.ts が入れる） */
  trees: Map<string, WorkspaceTrees>;
  focus: Accessor<WorkspaceFocus | null>;
  /** ワークスペースのフォルダ。フォルダ未定なら null、ワークスペースが分からなければ undefined */
  folderOf: (target: string, id: WorkspaceId) => string | null | undefined;
  /** ワークスペースのフォルダ（未定・分からなければ undefined） */
  rootOf: (target: string, id: WorkspaceId) => string | undefined;
  /** workspace.step で続けて移っている間か（この間はツリーを出さない） */
  walking: Accessor<boolean>;
  askPrimaryShj: AskPrimaryShj;
  /** OS のクリップボードに入れる */
  copyToClipboard: (text: string) => Promise<void>;
  /** ツリーの描き直しのあとで、スクロールの位置を top に戻す */
  restoreScroll: (top: number) => void;
  setFocusError: ReportProblem;
}) {
  const {
    sessions,
    workspaces,
    trees,
    focus,
    folderOf,
    rootOf,
    walking,
    askPrimaryShj,
    copyToClipboard,
    setFocusError,
  } = deps;
  // ツリーの中身は WorkspaceTrees が持ち、変わったら treeVersion を進めて描き直す
  const [treeVersion, setTreeVersion] = createSignal(0);

  // フォーカスしているワークスペースのツリーだけを動かし（監視と取り直し）、
  // 前にそのワークスペースで覚えたスクロールの位置に戻す（D2）
  // フォルダ未定のワークスペースにはツリーが無いので、監視も取り直しもしない
  const treeFocus = createMemo(
    () => {
      const f = focus();
      return f && folderOf(f.target, f.id) !== null ? f : null;
    },
    null,
    { equals: (a, b) => a?.target === b?.target && a?.id === b?.id },
  );
  createEffect(() => {
    const f = treeFocus();
    Object.keys(sessions()); // つないだマシンが増えたら、その WorkspaceTrees にも伝える
    untrack(() => {
      let restore: number | undefined;
      for (const [t, tr] of trees) {
        const id = f?.target === t ? f.id : null;
        if (id !== null && id !== tr.activeId) restore = tr.get(id)?.scrollTop;
        tr.activate(id);
      }
      // 描き直し（ツリーの入れ替え）のあとで戻す。初めてのワークスペースは今の位置のまま
      if (restore !== undefined) deps.restoreScroll(restore);
    });
  });

  function treeOf(target: string, id: WorkspaceId) {
    if (walking()) return undefined;
    treeVersion();
    const s = trees.get(target)?.get(id);
    return s && s.listings[""] ? treeRows(s) : undefined;
  }

  /** ツリーのファイルの行を押した（shj.open）。 */
  const openFile = (target: string, id: WorkspaceId, path: string) =>
    askPrimaryShj(
      "shj.open",
      target,
      id,
      path,
      (shj) => !!shj,
      T("err.file.open"),
      openErrorText,
    );

  // ツリーの右クリックのメニューから開いた窓（名前を入れる・削除の確認）
  const [treeDialog, setTreeDialog] = createSignal<{
    kind: "new-file" | "new-dir" | "rename" | "delete";
    target: string;
    id: WorkspaceId;
    /** 新規は入れるフォルダ、名前の変更と削除は対象（ルートからの相対パス。ルートは ""） */
    path: string;
    dir: boolean;
  } | null>(null);

  /** ツリーの行のメニューで項目を選んだ。コピーと cd はすぐ、新規・名前の変更・削除は窓を出す。 */
  function treeAction(
    target: string,
    id: WorkspaceId,
    row: TreeRow,
    action: TreeMenuAction,
  ) {
    const root = rootOf(target, id);
    if (root === undefined) return;
    switch (action) {
      case "copy-name":
        void copyToClipboard(row.name);
        break;
      case "copy-relative":
        void copyToClipboard(row.path);
        break;
      case "copy-absolute":
        void copyToClipboard(absolutePath(root, row.path));
        break;
      case "cd":
        void sendCd(target, id, absolutePath(root, row.path));
        break;
      case "new-file":
      case "new-dir":
        // メニューはフォルダの行にだけ出す。キー（a・A）はファイルの行でも使え、そのファイルのフォルダに作る（shj のツリーと同じ）
        setTreeDialog({
          kind: action,
          target,
          id,
          path: row.dir ? row.path : parentPath(row.path),
          dir: true,
        });
        break;
      case "rename":
      case "delete":
        setTreeDialog({
          kind: action,
          target,
          id,
          path: row.path,
          dir: row.dir,
        });
        break;
    }
  }

  /**
   * ワークスペースのプライマリターミナルに cd を送る。フォルダ（ワークスペースの root）は
   * そのシェルの cwd で決まるので、シェルが cd すればツリーも切り替わる。
   */
  async function sendCd(target: string, id: WorkspaceId, path: string) {
    const s = sessions()[target];
    const term = workspaces()[target]?.find((w) => w.id === id)?.primary;
    if (!s || !term) return;
    setFocusError(null);
    try {
      await s.request("term.cd", { termId: term, path });
    } catch (e) {
      const running =
        e instanceof RpcError &&
        e.code === ErrorCode.Busy &&
        (e.data as { reason?: string } | undefined)?.reason === "running";
      setFocusError({
        title: T("err.cd.send"),
        error: running
          ? T("err.cd.running")
          : e instanceof Error
            ? e.message
            : String(e),
      });
    }
  }

  /** 名前を入れる窓で決めた。断られたら例外を投げる（窓が理由を出す）。 */
  async function submitTreeName(value: string) {
    const d = treeDialog();
    const s = d && sessions()[d.target];
    if (!d || !s) return;
    if (d.kind === "rename") {
      const to = renamedPath(d.path, value);
      if (to !== null) {
        await s.request("tree.rename", {
          workspaceId: d.id,
          from: d.path,
          to,
        });
      }
    } else {
      const path = newEntryPath(value, d.kind === "new-file" ? "file" : "dir");
      if (path !== null) {
        const kind = d.kind === "new-file" ? "file" : "dir";
        await s.request("tree.create", { workspaceId: d.id, path, kind });
        // 閉じているフォルダに作ったら開いて、できたものが見えるようにする
        const t = trees.get(d.target);
        const ws = t?.get(d.id);
        const parent = parentPath(path);
        if (parent !== "" && ws && !ws.expanded[parent])
          t?.toggle(d.id, parent);
        // TUI のツリーの a と同じく、作ったファイルはそのまま開く
        if (kind === "file") openFile(d.target, d.id, path);
      }
    }
    setTreeDialog(null);
  }

  /** 削除の確認で「削除する」を押した。断られたら例外を投げる。 */
  async function submitTreeDelete() {
    const d = treeDialog();
    const s = d && sessions()[d.target];
    if (!d || !s) return;
    await s.request("tree.delete", { workspaceId: d.id, path: d.path });
    setTreeDialog(null);
  }

  /** プライマリの shj が出しているファイル（ツリーで強調する行）。 */
  function currentOf(target: string, id: WorkspaceId) {
    const f = focus();
    if (f?.target !== target || f.id !== id) return undefined;
    const w = workspaces()[target]?.find((x) => x.id === id);
    return relativeIn(w?.primaryShj?.file, rootOf(target, id));
  }

  return {
    /** ツリーの中身が変わった（描き直す） */
    changed: () => setTreeVersion((v) => v + 1),
    /** ツリーの中身が変わるたびに進む数（描き直しを待つ側が読む） */
    treeVersion,
    treeOf,
    /** フォルダの行を開く・閉じる */
    toggle: (target: string, id: WorkspaceId, path: string) =>
      trees.get(target)?.toggle(id, path),
    openFile,
    /** ツリーの右クリックのメニューから開いた窓（名前を入れる・削除の確認）。無ければ null */
    treeDialog,
    closeTreeDialog: () => setTreeDialog(null),
    treeAction,
    submitTreeName,
    submitTreeDelete,
    currentOf,
    /** フォーカスしているワークスペースのツリーで覚えているスクロールの位置（覚えていなければ undefined） */
    scrollTop() {
      const f = untrack(focus);
      return f ? trees.get(f.target)?.get(f.id)?.scrollTop : undefined;
    },
    /** フォーカスしているワークスペースのツリーのスクロールの位置を覚える */
    rememberScroll(top: number) {
      const f = focus();
      if (f) trees.get(f.target)?.setScroll(f.id, top);
    },
  };
}
