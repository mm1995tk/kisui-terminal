// マシンのダイアログ（リーダーの m。MachineDialog.tsx）の、画面の仕組み（Solid）に依らない部分。
// 一覧の行の組み立てと、ダイアログの中のキー、操作ができるかの判定。node --test で確かめる。

import { isComposingKey } from "../commands/ime.ts";
import { T } from "../../i18n/index.ts";
import type { Health, MachineGroup } from "../workspaces/rows.ts";
import type { KeyLike } from "../commands/guiKeys.ts";
import { listStep } from "../commands/placeKeys.ts";
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
  /** そのマシンのターミナルのタブ（マシンの kisui serve のワークスペース）の数 */
  terminalTabs: number;
  /** 名前を変えたり外したり切ったりできるか（「ローカル」はできない） */
  removable: boolean;
  /** config.toml にだけ書いたマシンか。窓からは外せず、名前も変えられない */
  fixed: boolean;
  /** 接続（セッション）があるか。切れるのは、あるときだけ */
  hasSession: boolean;
  /** つなぎ直す・今すぐつなぐができるか（無ければ、今は待つだけ） */
  retry?: "now" | "again";
}

const healthText = (h: Health): string => T(`health.${h}`);

/**
 * サイドバーの見出しの材料（groups）から、ダイアログの行を作る。
 * statusOf は見出しの下の 1 行（controller.ts の statusOf）。hasSession は、そのマシンの接続があるか。
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
      status: st.text || healthText(g.health),
      countdown: st.countdown,
      title: st.title,
      terminalTabs: g.bands.length,
      removable: g.removable,
      fixed: g.fixed,
      hasSession: hasSession(g.target),
      retry: st.retry,
    };
  });
}

/**
 * ダイアログの中の操作。newTab は、選んだマシンを設定したターミナルのタブ作成を、ワークスペースの窓で始める（Enter。#461）。
 * ここではタブを作らない。名前を打って決めるのは、ワークスペースの窓のタブを作る行（#456 と同じ行）。
 * terminal は、選んだマシンの新しいターミナルが始まるフォルダとシェルを変える窓を出す（t。#485。termDefaults.ts）。
 */
export type MachineAction =
  | "add"
  | "rename"
  | "remove"
  | "disconnect"
  | "reconnect"
  | "newTab"
  | "terminal";

/** ダイアログの中のキーが表す動き。 */
export type MachineKey =
  | { kind: "move"; to: "next" | "prev" | "first" | "last" }
  | { kind: "action"; action: MachineAction }
  | { kind: "help" };

/**
 * ダイアログの中のキー（入力欄が無いので、字をそのまま使える。Esc は ModalCard が取り消しに使う）。
 * Alt・Cmd・Ctrl を重ねたものは受けない（Shift は、G と ? の字が出るので受ける。Ctrl+J・Ctrl+K は、ほかの一覧と同じく次・前の行）。
 * Enter は、修飾キーを何も重ねないときだけ受ける（Shift+Enter も受けない）。変換を確定する Enter は受けない（isComposingKey）。
 */
export function machineKey(e: KeyLike): MachineKey | null {
  if (isComposingKey(e)) return null;
  if (e.key === "Enter")
    return e.ctrlKey || e.metaKey || e.altKey || e.shiftKey
      ? null
      : { kind: "action", action: "newTab" };
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
    case "t":
      return { kind: "action", action: "terminal" };
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

/**
 * 選んだマシンに操作ができるか。できなければ、その理由（ダイアログに出す）。
 * hasWorkspace は、今のワークスペースがあるか（newTab だけが見る。タブは今のワークスペースに作るので、無ければ作れない。
 * 渡し忘れて「ある」側に倒れないよう、既定値は置かない）。
 */
export function canDo(
  row: MachineRow,
  action: Exclude<MachineAction, "add">,
  hasWorkspace: boolean,
): string | null {
  switch (action) {
    case "newTab":
      // つながっていないマシンを、黙ってほかのマシンに替えない（タブを作る行の候補は、つながっているマシンだけ）
      // r でつなぎ直せるときだけ r を案内する（つないでいる最中・待つだけのときは、r も断られる）
      if (row.health !== "up")
        return row.retry
          ? T("machine.cant.newTab.down", { label: row.label })
          : T("machine.cant.newTab.pending", { label: row.label });
      if (!hasWorkspace) return T("machine.cant.newTab.noWorkspace");
      return null;
    case "rename":
    case "remove": {
      if (!row.removable)
        return T(`machine.cant.${action}.local`, { label: row.label });
      if (row.fixed)
        return T(`machine.cant.${action}.fixed`, { label: row.label });
      return null;
    }
    case "terminal":
      // 「ローカル」は [server] に書けるので、変えられる。config.toml にだけあるマシンは、窓からは書けない
      if (row.fixed)
        return T("machine.cant.terminal.fixed", { label: row.label });
      return null;
    case "disconnect":
      if (!row.removable)
        return T("machine.cant.disconnect.local", { label: row.label });
      if (!row.hasSession)
        return T("machine.cant.disconnect.none", { label: row.label });
      return null;
    case "reconnect":
      if (!row.retry)
        return row.health === "up"
          ? T("machine.cant.reconnect.up", { label: row.label })
          : T("machine.cant.reconnect.pending", { label: row.label });
      return null;
  }
}

/** ワークスペースを作るマシンを選ぶ窓（リーダーの `w n`。MachinePicker.tsx）の、行の中のキーが表す動き。 */
export type PickerKey =
  | { kind: "move"; to: "next" | "prev" | "first" | "last" }
  | { kind: "choose" }
  | { kind: "help" };

/**
 * 選ぶ窓の中のキー（入力欄が無いので、字をそのまま使える。Esc は ModalCard が取り消しに使う）。
 * マシンのダイアログの動かし方（j k g G・矢印・Ctrl+J / Ctrl+K）と `?`（キーの一覧）に、決める Enter を足したもの。
 * 足す・名前を変えるなどの操作のキー（a n d x r t）は受けない。
 */
export function pickerKey(e: KeyLike): PickerKey | null {
  if (isComposingKey(e)) return null;
  if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey)
    return { kind: "choose" };
  const k = machineKey(e);
  return k?.kind === "move" || k?.kind === "help" ? k : null;
}

/** ワークスペースを作れるマシン（つながっているもの）。 */
export function creatableRows(rows: readonly MachineRow[]): MachineRow[] {
  return rows.filter((r) => r.health === "up");
}
