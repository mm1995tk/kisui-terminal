// ワークスペースを切り替える窓（WorkspaceSwitcher.tsx）の右の列の、タブを作る操作：ターミナルのタブを作る行の状態と、ブラウザのタブを開く操作。
import { createEffect, createSignal } from "solid-js";

import type { Row } from "../../../features/workspaces/rows.ts";

/**
 * タブを作る行（n・「＋」）の状態と、決めたあとの操作を持つ。
 * clearOthers は、ほかの入力欄・確認をやめる（この操作を始めるとき、ほかのものは残さない）。
 */
export function createSwitcherNewTab(args: {
  selected: () => Row | undefined;
  /** 選んでいるワークスペースの id */
  sel: () => string | undefined;
  /** その id のワークスペースがあるか（窓の外の理由で消えたら、行をやめる） */
  has: (gws: string) => boolean;
  /** タブを作れるマシン（つながっているマシン）の数 */
  machineCount: () => number;
  browser: () => boolean;
  /** 名前とマシンを決めた。断られたら理由、作れそうなら作ったタブの key を待てる形で返す */
  create: (
    gws: string,
    machine: string,
    name: string,
  ) => { error: string } | { key: Promise<string | undefined> };
  /** ブラウザのタブを開いて、その key を返す */
  openBrowser: (gws: string) => string | undefined;
  /** マシンが 1 つも無い（できないことを、呼んだ側が伝える） */
  noMachine: () => void;
  /** タブを選んで、タブの列へ移る */
  pickTab: (key: string) => void;
  focusList: () => void;
  clearOthers: () => void;
}) {
  // 行を出している間（gws はそのワークスペースの id、error は断られた理由）
  const [creating, setCreating] = createSignal<
    { gws: string; error?: string } | undefined
  >();
  const stop = () => setCreating(undefined);

  createEffect(() => {
    const c = creating();
    if (c && !args.has(c.gws)) stop();
  });

  return {
    creating,
    stop,
    /** 行を出す（n・「＋」）。マシンが 1 つも無ければ、出さずに伝える */
    start() {
      const r = args.selected();
      if (!r) return;
      if (args.machineCount() === 0) {
        args.noMachine();
        return;
      }
      args.clearOthers();
      setCreating({ gws: r.gws });
    },
    /** 名前とマシンを決めた。作れそうなら行を閉じ、できたタブを右の列で選ぶ（窓は閉じない）。断られたら、理由を出して行は開けたまま */
    submit(name: string, machine: string) {
      const c = creating();
      if (!c) return;
      const res = args.create(c.gws, machine, name);
      if ("error" in res) {
        setCreating({ ...c, error: res.error });
        return;
      }
      stop();
      args.focusList();
      void res.key.then((key) => {
        if (key !== undefined && args.sel() === c.gws) args.pickTab(key);
      });
    },
    /** ブラウザのタブを開き（N・地球儀）、できたタブを右の列で選ぶ（窓は閉じない）。内蔵ブラウザが無効なら何もしない */
    openBrowser() {
      const r = args.selected();
      if (!args.browser() || !r) return;
      args.clearOthers();
      const key = args.openBrowser(r.gws);
      if (key !== undefined) args.pickTab(key);
      args.focusList();
    },
  };
}
