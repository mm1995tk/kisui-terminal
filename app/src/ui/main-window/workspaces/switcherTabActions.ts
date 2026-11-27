// Workspace switcher（WorkspaceSwitcher.tsx）の右の列のタブの操作：名前を変える入力欄の状態と、閉じるときの選び直し。
import { createEffect, createSignal } from "solid-js";

import type { Row, TabItem } from "../../../features/workspaces/rows.ts";
import type { RowEdit } from "./SwitcherParts.tsx";

/** タブ key を閉じたあとに選ぶタブ（隣のタブ、無ければ前のタブ。ほかにタブが無ければ undefined）。 */
export function nextTabAfterClose(
  items: readonly { key: string }[],
  key: string,
): string | undefined {
  const i = items.findIndex((t) => t.key === key);
  if (i < 0) return undefined;
  return (items[i + 1] ?? items[i - 1])?.key;
}

/**
 * タブの名前を変える入力欄（tabEditing）と、その開け閉め・タブを閉じる操作を持つ。
 * clearRowState は、ワークスペースの行の入力欄と閉じる確認をやめる（タブの操作を始めるとき、ワークスペースの行のものは残さない）。
 */
export function createSwitcherTabActions(args: {
  tabs: () => readonly TabItem[];
  selected: () => Row | undefined;
  selectedTab: () => TabItem | undefined;
  /** タブを選んで、タブの列へ移る */
  pickTab: (key: string) => void;
  clearRowState: () => void;
  focusList: () => void;
  /** 入力欄の初めの値と、空にしたときの名前（タブが無ければ undefined） */
  init: (
    gws: string,
    key: string,
  ) => { current: string; auto: string } | undefined;
  /** 名前を決める。断られたら、その理由を返す */
  rename: (gws: string, key: string, name: string) => string | undefined;
  close: (gws: string, key: string) => void;
}) {
  const [editing, setEditing] = createSignal<
    (RowEdit & { key: string }) | undefined
  >();
  const stop = () => setEditing(undefined);

  // 名前を変えているタブが、Workspace switcher の外の理由（閉じた・移したなど）で右の列から消えたら、やめる
  createEffect(() => {
    const e = editing();
    if (e && !args.tabs().some((t) => t.key === e.key)) stop();
  });

  return {
    /** 名前を変えているタブ（その行の 1 行目が入力欄になる） */
    editing,
    /** 入力欄をやめる */
    stop,
    /** タブの行の鉛筆・r：そのタブを選んで、名前の所を入力欄にする */
    start(gws: string, key: string) {
      const init = args.init(gws, key);
      if (!init) return;
      args.clearRowState();
      args.pickTab(key);
      setEditing({ key, ...init });
    },
    /** 入力欄で名前を決めた。断られたら、入力欄の下に理由を出して開けておく */
    submit(name: string) {
      const e = editing();
      const r = args.selected();
      if (!e || !r) return;
      const bad = args.rename(r.gws, e.key, name);
      if (bad) setEditing({ ...e, error: bad });
      else {
        stop();
        args.focusList();
      }
    },
    /** タブの行の ✕・x：確かめずに閉じる。選んでいるタブを閉じるときは、選びを隣のタブに移す */
    close(gws: string, key: string) {
      args.clearRowState();
      stop();
      if (args.selectedTab()?.key === key) {
        const next = nextTabAfterClose(args.tabs(), key);
        if (next !== undefined) args.pickTab(next);
      }
      args.close(gws, key);
      args.focusList();
    },
  };
}
