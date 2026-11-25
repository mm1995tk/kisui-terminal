// ワークスペースを切り替える窓（WorkspaceSwitcher.tsx）の右の列の、タブを作る操作：種類を選ぶ一覧の状態と、種類ごとの作る操作（ターミナルのタブを作る行・ブラウザのタブ・DB のタブ）。
import { createEffect, createSignal } from "solid-js";

import { moveRow } from "../../../features/sessions/machineList.ts";
import type { Row } from "../../../features/workspaces/rows.ts";
import { newTabKinds, type NewTabChoice } from "./newTabKey.ts";

/**
 * タブを作る操作（n・N・「＋」・リーダーの n）の状態と、決めたあとの操作を持つ（#456）。
 * まず種類を選ぶ一覧（choosing）を出し、決めた種類ごとに、今ある作る操作へつなぐ：
 * ターミナルは名前とマシンの行（creating）、ブラウザ・シークレットはすぐ開く、DB は接続を選ぶ窓（呼んだ側が出す）。
 * clearOthers は、ほかの入力欄・確認をやめる（この操作を始めるとき、ほかのものは残さない）。
 */
export function createSwitcherNewTab(args: {
  selected: () => Row | undefined;
  /** 選んでいるワークスペースの id */
  sel: () => string | undefined;
  /** その id のワークスペースがあるか（窓の外の理由で消えたら、一覧も行もやめる） */
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
  /** DB のタブを作る（接続を選ぶ窓を出すのは、呼んだ側） */
  openDb: (gws: string) => void;
  /** マシンが 1 つも無い（できないことを、呼んだ側が伝える） */
  noMachine: () => void;
  /** タブを選んで、タブの列へ移る */
  pickTab: (key: string) => void;
  focusList: () => void;
  clearOthers: () => void;
}) {
  // 種類を選ぶ一覧を出している間（gws はそのワークスペースの id、kind は選んでいる行の種類）
  const [choosing, setChoosing] = createSignal<
    { gws: string; kind: NewTabChoice } | undefined
  >();
  // ターミナルのタブを作る行を出している間（gws はそのワークスペースの id、error は断られた理由）
  const [creating, setCreating] = createSignal<
    { gws: string; error?: string } | undefined
  >();
  const stop = () => {
    setChoosing(undefined);
    setCreating(undefined);
  };
  /** いま一覧に出す種類（内蔵ブラウザが無効なら、ブラウザとシークレットは無い） */
  const kinds = () => newTabKinds(args.browser());

  createEffect(() => {
    const g = choosing()?.gws ?? creating()?.gws;
    if (g !== undefined && !args.has(g)) stop();
  });

  /** ターミナルのタブを作る行を出す。マシンが 1 つも無ければ、出さずに伝える（一覧は開けたまま。ほかの種類を選べる） */
  function startTerminal(gws: string) {
    if (args.machineCount() === 0) {
      args.noMachine();
      return;
    }
    stop();
    setCreating({ gws });
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
    // ブラウザのタブはすぐ開き、できたタブを右の列で選ぶ（窓は閉じない）
    const key = args.openBrowser(c.gws, what === "incognito");
    if (key !== undefined && args.sel() === c.gws) args.pickTab(key);
    args.focusList();
  }

  return {
    choosing,
    creating,
    kinds,
    stop,
    /** 種類を選ぶ一覧を出す（n・N・「＋」・リーダーの n）。一番上の種類（ターミナル）を選んでおく。ワークスペースを選んでいなければ何もしない */
    start() {
      const r = args.selected();
      if (!r) return;
      args.clearOthers();
      setChoosing({ gws: r.gws, kind: kinds()[0] });
    },
    /** 一覧で、選ぶ行を動かす（端では止まる） */
    move(to: "next" | "prev") {
      const c = choosing();
      if (!c) return;
      const list = kinds();
      // 選んでいた種類が一覧から消えていたら（内蔵ブラウザの設定は起動中に変わらないが、念のため）、一番上から数える
      const at = Math.max(0, list.indexOf(c.kind));
      setChoosing({ ...c, kind: list[moveRow(at, to, list.length)] });
    },
    /** 一覧の行にポインタが乗った（その行を選ぶ） */
    hover(kind: NewTabChoice) {
      const c = choosing();
      if (c && c.kind !== kind) setChoosing({ ...c, kind });
    },
    /** 選んでいる行の種類に決める（Enter） */
    choose() {
      const c = choosing();
      if (c) pick(c.kind);
    },
    pick,
    /** 一覧だけを閉じる（Esc。窓は閉じない） */
    cancel() {
      setChoosing(undefined);
      args.focusList();
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
  };
}
