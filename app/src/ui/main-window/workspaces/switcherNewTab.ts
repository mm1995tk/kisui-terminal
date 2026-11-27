// Workspace switcher（WorkspaceSwitcher.tsx）の右の列の、タブを作る操作：種類を選んでいる間の状態と、種類ごとの作る操作（ターミナルのタブを作る行・ブラウザのタブ・DB のタブ）。
import { createEffect, createSignal } from "solid-js";

import type { Row } from "../../../features/workspaces/rows.ts";
import { newTabKinds, type NewTabChoice } from "./newTabKey.ts";

/**
 * タブを作る操作（n・N・「＋」・リーダーの n）の状態と、決めたあとの操作を持つ（#456）。
 * まず種類を選ばせ（choosing。種類は Dialog の Key footer のボタンと字で選ぶ。#487）、決めた種類ごとに、今ある作る操作へつなぐ：
 * ターミナルは名前とマシンの行（creating）、ブラウザ・シークレットはすぐ開く、DB は接続を選ぶ Dialog（呼んだ側が出す）。
 * clearOthers は、ほかの入力欄・確認をやめる（この操作を始めるとき、ほかのものは残さない）。
 */
export function createSwitcherNewTab(args: {
  selected: () => Row | undefined;
  /** 選んでいるワークスペースの id */
  sel: () => string | undefined;
  /** その id のワークスペースがあるか（Window の外の理由で消えたら、種類を選ぶのも行もやめる） */
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
  /** ブラウザのタブ（incognito ならシークレットのタブ）を開いて、その key を返す */
  openBrowser: (gws: string, incognito: boolean) => string | undefined;
  /** DB のタブを作る（接続を選ぶ Dialog を出すのは、呼んだ側） */
  openDb: (gws: string) => void;
  /** マシンが 1 つも無い（できないことを、呼んだ側が伝える） */
  noMachine: () => void;
  /** タブを選んで、タブの列へ移る */
  pickTab: (key: string) => void;
  focusList: () => void;
  clearOthers: () => void;
}) {
  // 作るタブの種類を選んでいる間（gws はそのワークスペースの id。種類は Dialog の Key footer のボタンと字で選ぶ）
  const [choosing, setChoosing] = createSignal<{ gws: string } | undefined>();
  // ターミナルのタブを作る行を出している間（gws はそのワークスペースの id、machine は初めに選んでおくマシン（無ければワークスペースのマシン）、error は断られた理由）
  const [creating, setCreating] = createSignal<
    { gws: string; machine?: string; error?: string } | undefined
  >();
  const stop = () => {
    setChoosing(undefined);
    setCreating(undefined);
  };
  /** いま選べる種類（内蔵ブラウザが無効なら、ブラウザとシークレットは無い） */
  const kinds = () => newTabKinds(args.browser());

  createEffect(() => {
    const g = choosing()?.gws ?? creating()?.gws;
    if (g !== undefined && !args.has(g)) stop();
  });

  /** ターミナルのタブを作る行を出す（machine は初めに選んでおくマシン）。マシンが 1 つも無ければ、出さずに伝える（種類を選んでいる間のまま。ほかの種類を選べる） */
  function startTerminal(gws: string, machine?: string) {
    if (args.machineCount() === 0) {
      args.noMachine();
      return;
    }
    stop();
    setCreating(machine === undefined ? { gws } : { gws, machine });
  }

  /** 種類 what に決めた。ワークスペース gws に、その種類のタブを作る操作へ進む */
  function pick(what: NewTabChoice) {
    const c = choosing();
    if (!c || !kinds().includes(what)) return;
    if (what === "terminal") {
      startTerminal(c.gws);
      return;
    }
    stop();
    if (what === "db") {
      args.openDb(c.gws);
      return;
    }
    // ブラウザのタブはすぐ開き、できたタブを右の列で選ぶ（Dialog は閉じない）
    const key = args.openBrowser(c.gws, what === "incognito");
    if (key !== undefined && args.sel() === c.gws) args.pickTab(key);
    args.focusList();
  }

  return {
    choosing,
    creating,
    kinds,
    stop,
    /** 作るタブの種類を選び始める（n・N・「＋」・リーダーの n）。ワークスペースを選んでいなければ何もしない */
    start() {
      const r = args.selected();
      if (!r) return;
      args.clearOthers();
      setChoosing({ gws: r.gws });
    },
    /**
     * 種類を選ぶのを飛ばして、選んでいるワークスペースに、マシン machine を選んでおいたターミナルのタブを作る行を出す
     * （マシンのダイアログの Enter で開いたとき。#461）。ほかの入力欄・確認はやめる。ワークスペースを選んでいなければ何もしない
     */
    startTerminalOn(machine: string) {
      const r = args.selected();
      if (!r) return;
      args.clearOthers();
      startTerminal(r.gws, machine);
    },
    pick,
    /** 種類を選ぶのだけをやめる（Esc。Dialog は閉じない） */
    cancel() {
      setChoosing(undefined);
      args.focusList();
    },
    /** 名前とマシンを決めた。作れそうなら行を閉じ、できたタブを右の列で選ぶ（Dialog は閉じない）。断られたら、理由を出して行は開けたまま */
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
  };
}
