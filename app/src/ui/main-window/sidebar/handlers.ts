// サイドバーの部品が、外（ui/main-window/page.tsx）へ頼むこと。Sidebar が受け取り、帯・タブの行・ツリー・CHANGES に渡す。
import type {
  ChangeRow,
  ChangesBase,
} from "../../../features/changes/model.ts";
import type { TreeMenuAction } from "../../../features/file-tree/menu.ts";
import type { TreeRow } from "../../../features/file-tree/model.ts";
import type { TreeEditView } from "./file-tree/TreeView.tsx";
import type { DbTreeProps } from "./db-tree/DbTree.tsx";
import type { NewTabKind } from "../../../features/workspaces/tabs/controller.ts";
import type {
  ChangesShjKey,
  WorkspaceId,
} from "../../../infrastructure/rpc/protocol.ts";

/** サイドバーの部品が外へ頼む処理と、外から受け取る値。どれも省ける（省いた操作は出さない）。 */
export interface Handlers {
  /** ヘッダーの名前を押した（ワークスペースを切り替えるポップアップを開く） */
  onSwitch?: () => void;
  /** タブの行を押した（gws は GUI のワークスペースの id、key は TabItem.key） */
  onTab?: (gws: string, key: string) => void;
  /** タブの行の ✕（ターミナルのタブもブラウザのタブも） */
  onTabClose?: (gws: string, key: string) => void;
  /** タブの行の鉛筆（名前を変える。呼ぶ側が tabRenaming を渡す） */
  onTabRename?: (gws: string, key: string) => void;
  /** 名前をその場で変えているタブの行（key は TabItem.key。current・auto・error は renaming と同じ）。無ければ undefined か null */
  tabRenaming?: {
    gws: string;
    key: string;
    current: string;
    auto: string;
    error?: string;
  } | null;
  /** タブの行の入力欄で Enter を押した（空なら、つけた名前を外す） */
  onTabRenameSubmit?: (name: string) => void;
  /** タブの行の入力欄で Esc を押した（byKey が true）・フォーカスが外れた */
  onTabRenameCancel?: (byKey?: boolean) => void;
  /** タブの行のつかむ所からドラッグして落とした（同じワークスペースの中だけ。before は、そのすぐ前のタブのキー。一番後ろなら null） */
  onTabMove?: (gws: string, key: string, before: string | null) => void;
  /** ヘッダーの「+」のメニューで選んだ。選んでいないワークスペースなら、呼ぶ側が先にそのワークスペースに移る（features/workspaces/tabs/controller.ts の addWorkspaceTab） */
  onAddTab?: (gws: string, kind: NewTabKind) => void;
  /** 内蔵ブラウザを使えるか。使えなければ「+」のメニューに「ブラウザ」を出さない */
  browser?: boolean;
  /** 「+」を押した（Sidebar が内側に渡す。メニューは Sidebar が出す） */
  onAddMenu?: (gws: string, x: number, y: number) => void;
  /** ツリーの行。まだ取っていなければ undefined */
  treeOf?: (target: string, id: WorkspaceId) => TreeRow[] | undefined;
  onToggle?: (target: string, id: WorkspaceId, path: string) => void;
  /** 帯の [×]（GUI のワークスペースを閉じる）。省くと出さない */
  onClose?: (gws: string) => void;
  /** 帯のメニューの「名前を変える」・帯の鉛筆のボタン（呼ぶ側が renaming を渡す） */
  onRenameWorkspace?: (gws: string) => void;
  /** 名前をその場で変えている帯（current は入力欄の初めの値、auto は空にしたときの名前、error は断られた理由）。無ければ undefined */
  renaming?: {
    /** GUI のワークスペースの id */
    gws: string;
    current: string;
    auto: string;
    error?: string;
  } | null;
  /** その場の入力欄で Enter を押した（空なら、つけた名前を外す） */
  onRenameSubmit?: (name: string) => void;
  /** その場の入力欄で Esc を押した（byKey が true）・フォーカスが外れた */
  onRenameCancel?: (byKey?: boolean) => void;
  /** 帯を右クリックした（Sidebar が内側に渡す。呼ぶ側は onRenameWorkspace を使う） */
  onBandMenu?: (gws: string, x: number, y: number) => void;
  /** ツリーのファイルの行を押した */
  onOpen?: (target: string, id: WorkspaceId, path: string) => void;
  /** プライマリの shj が出しているファイル（ツリーで強調する行の path）。無ければ undefined */
  currentOf?: (target: string, id: WorkspaceId) => string | undefined;
  /** 差分モードの CHANGES の一覧の行。差分モードでなければ undefined */
  changesOf?: (
    target: string,
    id: WorkspaceId,
  ) => { rows: ChangeRow[]; base: ChangesBase } | undefined;
  /** CHANGES の行を押した（path は shj が知らせた絶対パス） */
  onChange?: (target: string, id: WorkspaceId, path: string) => void;
  /** CHANGES で shj のキー（s・r・R・Space・:）を押した（shj に渡す） */
  onChangesKey?: (target: string, id: WorkspaceId, key: ChangesShjKey) => void;
  /** CHANGES で Tab を押した（エクスプローラに移る） */
  onChangesExplorer?: (target: string, id: WorkspaceId) => void;
  /** CHANGES で Esc・q を押した（端末に戻る） */
  onChangesLeave?: (target: string, id: WorkspaceId) => void;
  /** タブの段とファイルツリーの境目をつかんだ（ドラッグは ui/main-window/paneResize.ts が受け持つ） */
  onTabsResize?: (e: PointerEvent) => void;
  /** タブの段とファイルツリーの境目をダブルクリックした（高さを設定の値に戻す） */
  onTabsResizeReset?: () => void;
  /** ファイルツリーと CHANGES の境目をつかんだ（height は画面に出ている一覧の高さ px。ドラッグは ui/main-window/paneResize.ts が受け持つ） */
  onChangesResize?: (e: PointerEvent, height: number) => void;
  /** 境目をダブルクリックした（高さを元に戻す） */
  onChangesResizeReset?: () => void;
  /** ツリーの中のその場の入力欄（新しいファイル・フォルダ・名前の変更）。無ければ undefined */
  treeEditOf?: (target: string, id: WorkspaceId) => TreeEditView | undefined;
  /** ツリーの入力欄で Enter を押した（値はルートからの相対パス） */
  onTreeEditSubmit?: (value: string) => void;
  /** ツリーの入力欄で Esc を押した（byKey）・フォーカスが外れた */
  onTreeEditCancel?: (byKey: boolean) => void;
  /** 今のワークスペースで出している DB のタブの id（#374。出していれば、ファイルツリーの場所にそのタブの接続の木を出す。無ければ undefined） */
  dbTabId?: () => string | undefined;
  /** DB のタブ id の木の値と頼み（dbTabId が返した id で呼ぶ。値は getter で渡す） */
  dbTree?: (id: string) => DbTreeProps;
  /** ツリーの行を右クリックした（Sidebar が内側に渡す。呼ぶ側は onTreeAction を使う） */
  onTreeMenu?: (
    target: string,
    id: WorkspaceId,
    row: TreeRow,
    x: number,
    y: number,
  ) => void;
  /** ツリーの行のメニューで項目を選んだ・行でそのキー（a・d など）を押した。省くとメニューを出さず、そのキーも使わない */
  onTreeAction?: (
    target: string,
    id: WorkspaceId,
    row: TreeRow,
    action: TreeMenuAction,
  ) => void;
}

/** 子に渡す処理だけを取り出す（getter にして、props の追跡を保つ）。 */
export function handlers(
  props: Handlers,
  onTreeMenu: Handlers["onTreeMenu"] = props.onTreeMenu,
  onBandMenu: Handlers["onBandMenu"] = props.onBandMenu,
  onAddMenu: Handlers["onAddMenu"] = props.onAddMenu,
): Handlers {
  return {
    onTreeMenu,
    onBandMenu,
    onAddMenu,
    get browser() {
      return props.browser;
    },
    get onTabRename() {
      return props.onTabRename;
    },
    get tabRenaming() {
      return props.tabRenaming;
    },
    get onTabRenameSubmit() {
      return props.onTabRenameSubmit;
    },
    get onTabRenameCancel() {
      return props.onTabRenameCancel;
    },
    get onSwitch() {
      return props.onSwitch;
    },
    get onTabMove() {
      return props.onTabMove;
    },
    get onTab() {
      return props.onTab;
    },
    get onTabClose() {
      return props.onTabClose;
    },
    get dbTabId() {
      return props.dbTabId;
    },
    get dbTree() {
      return props.dbTree;
    },
    get treeOf() {
      return props.treeOf;
    },
    get onToggle() {
      return props.onToggle;
    },
    get onClose() {
      return props.onClose;
    },
    get onOpen() {
      return props.onOpen;
    },
    get currentOf() {
      return props.currentOf;
    },
    get changesOf() {
      return props.changesOf;
    },
    get onChange() {
      return props.onChange;
    },
    get onChangesKey() {
      return props.onChangesKey;
    },
    get onChangesExplorer() {
      return props.onChangesExplorer;
    },
    get onChangesLeave() {
      return props.onChangesLeave;
    },
    get onTabsResize() {
      return props.onTabsResize;
    },
    get onTabsResizeReset() {
      return props.onTabsResizeReset;
    },
    get onChangesResize() {
      return props.onChangesResize;
    },
    get onChangesResizeReset() {
      return props.onChangesResizeReset;
    },
    get onTreeAction() {
      return props.onTreeAction;
    },
    get treeEditOf() {
      return props.treeEditOf;
    },
    get onTreeEditSubmit() {
      return props.onTreeEditSubmit;
    },
    get onTreeEditCancel() {
      return props.onTreeEditCancel;
    },
    get renaming() {
      return props.renaming;
    },
    get onRenameSubmit() {
      return props.onRenameSubmit;
    },
    get onRenameCancel() {
      return props.onRenameCancel;
    },
    get onRenameWorkspace() {
      return props.onRenameWorkspace;
    },
  };
}

/**
 * この帯（focused は、フォーカスしているワークスペースの帯か）に、DB の木を出すなら、その DB のタブの id。出さなければ undefined。
 * 出すかの判定は、Sidebar（段に分けるか）・BandItem（段に分けるか・パネルを隠すか）・Panes（木を描く）が同じ関数で決める。
 */
export function dbTreeTabOf(h: Handlers, focused: boolean): string | undefined {
  return focused && h.dbTree ? h.dbTabId?.() : undefined;
}
