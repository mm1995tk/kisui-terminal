// マシンのダイアログ（リーダーの m。MachineDialog.tsx）の、画面の仕組み（Solid）に依らない部分。
// 一覧の行の組み立てと、ダイアログの中のキー、操作ができるかの判定。node --test で確かめる。

import type { Health, MachineGroup } from "../sidebar/model.ts";
import type { KeyLike } from "../guiKeys.ts";
import { listStep } from "../placeKeys.ts";
import type { MachineStatus } from "./status.ts";

/** 一覧の 1 行（マシン 1 台）。 */
export interface MachineRow {
  target: string;
  label: string;
  health: Health;
  /** つながりの状態の 1 行（サイドバーの見出しの下と同じ言葉）。つながっていれば「つながっています」 */
  status: string;
  /** 待ち時間の残り（「3 秒後」）。毎秒変わるので、読み上げる status とは分ける */
  countdown?: string;
  /** 状態のツールチップ（理由など） */
  title: string;
  /** ワークスペースの数 */
  workspaces: number;
  /** 名前を変えたり外したり切ったりできるか（「ローカル」はできない） */
  removable: boolean;
  /** 設定ファイルで決めたマシンか。外せず、名前も変えられない */
  fixed: boolean;
  /** 接続（セッション）があるか。切れるのは、あるときだけ */
  hasSession: boolean;
  /** つなぎ直す・今すぐつなぐができるか（無ければ、今は待つだけ） */
  retry?: "now" | "again";
}

const healthText: Record<Health, string> = {
  up: "つながっています",
  pending: "つないでいます",
  down: "つながっていません",
};

/**
 * サイドバーの見出しの材料（groups）から、ダイアログの行を作る。
 * statusOf は見出しの下の 1 行（App の statusLine）。hasSession は、そのマシンの接続があるか。
 */
export function machineRows(
  groups: readonly MachineGroup[],
  statusOf: (target: string) => MachineStatus,
  hasSession: (target: string) => boolean,
): MachineRow[] {
  return groups.map((g) => {
    const st = statusOf(g.target);
    return {
      target: g.target,
      label: g.label,
      health: g.health,
      status: st.text || healthText[g.health],
      countdown: st.countdown,
      title: st.title,
      workspaces: g.bands.length,
      removable: g.removable,
      fixed: g.fixed,
      hasSession: hasSession(g.target),
      retry: st.retry,
    };
  });
}

/** ダイアログの中の操作。 */
export type MachineAction =
  "add" | "rename" | "remove" | "disconnect" | "reconnect";

/** ダイアログの中のキーが表す動き。 */
export type MachineKey =
  | { kind: "move"; to: "next" | "prev" | "first" | "last" }
  | { kind: "action"; action: MachineAction }
  | { kind: "help" };

/**
 * ダイアログの中のキー（入力欄が無いので、字をそのまま使える。Esc は ModalCard が取り消しに使う）。
 * Shift・Alt・Cmd・Ctrl を重ねたものは受けない（Ctrl+J・Ctrl+K は、ほかの一覧と同じく次・前の行）。
 */
export function machineKey(e: KeyLike): MachineKey | null {
  if (e.isComposing) return null;
  const step = listStep(e);
  if (step !== 0) return { kind: "move", to: step === 1 ? "next" : "prev" };
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key) {
    case "j":
    case "ArrowDown":
      return { kind: "move", to: "next" };
    case "k":
    case "ArrowUp":
      return { kind: "move", to: "prev" };
    case "g":
    case "Home":
      return { kind: "move", to: "first" };
    case "G":
    case "End":
      return { kind: "move", to: "last" };
    case "a":
      return { kind: "action", action: "add" };
    case "n":
      return { kind: "action", action: "rename" };
    case "d":
      return { kind: "action", action: "remove" };
    case "x":
      return { kind: "action", action: "disconnect" };
    case "r":
      return { kind: "action", action: "reconnect" };
    case "?":
      return { kind: "help" };
  }
  return null;
}

/** 選ぶ行を動かす。端では止まる（行が無ければ 0）。 */
export function moveRow(
  i: number,
  to: "next" | "prev" | "first" | "last",
  n: number,
): number {
  if (n <= 0) return 0;
  const j =
    to === "next" ? i + 1 : to === "prev" ? i - 1 : to === "first" ? 0 : n - 1;
  return Math.min(n - 1, Math.max(0, j));
}

/** 行を選び直す。同じマシンが残っていればそれ、消えていれば元の位置（端なら 1 つ前）。 */
export function keepRow(
  rows: readonly { target: string }[],
  target: string | undefined,
  index: number,
): number {
  const i = rows.findIndex((r) => r.target === target);
  if (i >= 0) return i;
  return Math.min(Math.max(0, index), Math.max(0, rows.length - 1));
}

/** 選んだマシンに操作ができるか。できなければ、その理由（ダイアログに出す）。 */
export function canDo(
  row: MachineRow,
  action: Exclude<MachineAction, "add">,
): string | null {
  switch (action) {
    case "rename":
    case "remove": {
      const verb = action === "rename" ? "名前を変えられません" : "外せません";
      if (!row.removable) return `${row.label} は${verb}（「ローカル」です）`;
      if (row.fixed)
        return `${row.label} は${verb}（設定ファイルの [[gui.machines]] で決めたマシンです）`;
      return null;
    }
    case "disconnect":
      if (!row.removable)
        return `${row.label} は切れません（「ローカル」です）`;
      if (!row.hasSession) return `${row.label} はつながっていません`;
      return null;
    case "reconnect":
      if (!row.retry)
        return row.health === "up"
          ? `${row.label} はつながっています`
          : `${row.label} は今つないでいる最中です`;
      return null;
  }
}
