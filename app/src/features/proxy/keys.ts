// プロキシのパネル（#409）にキーがあるときのキーの判定（場所のキー。docs/key-design.md の 5 章）。
// `?` の一覧に出す表は features/commands/placeKeys.ts の proxy。DOM には触らない（node --test で確かめられる）。
import { isComposingKey } from "../commands/ime.ts";
import type { KeyLike } from "../commands/guiKeys.ts";

/**
 * パネルのキーの動き。next・prev・first・last：一覧で選ぶ通信を動かす。side：中身の「要求」と「応答」を切り替える。
 * back：キーをタブ（ターミナル・ページ）に戻す（パネルは出したまま）。close：パネルを閉じる。
 * edit：選んでいる通信の要求を書き換える欄を開く（#410。止めている要求なら、書き換えて流す）。
 * hold：要求を行き先に送る前に止めるのを切り替える（#411）。forward・drop：選んでいる、止めている要求を、そのまま流す・捨てる。
 */
export type ProxyPanelKey =
  | "next"
  | "prev"
  | "first"
  | "last"
  | "side"
  | "back"
  | "close"
  | "edit"
  | "hold"
  | "forward"
  | "drop";

/** パネルで押したキー e の動き（当たらなければ null）。修飾キー（Shift 以外）を押していれば受けない。 */
export function proxyPanelKey(e: KeyLike): ProxyPanelKey | null {
  if (e.ctrlKey || e.metaKey || e.altKey || isComposingKey(e)) return null;
  switch (e.key) {
    case "j":
    case "ArrowDown":
      return e.shiftKey ? null : "next";
    case "k":
    case "ArrowUp":
      return e.shiftKey ? null : "prev";
    case "g":
    case "Home":
      return e.shiftKey ? null : "first";
    case "G":
    case "End":
      return "last";
    case "Tab":
    case "h":
    case "l":
    case "ArrowLeft":
    case "ArrowRight":
      return e.shiftKey && e.key !== "Tab" ? null : "side";
    case "Escape":
      return "back";
    case "q":
      return e.shiftKey ? null : "close";
    case "e":
      return e.shiftKey ? null : "edit";
    case "i":
      return e.shiftKey ? null : "hold";
    case "f":
      return e.shiftKey ? null : "forward";
    case "d":
      return e.shiftKey ? null : "drop";
  }
  return null;
}

/** 要求を書き換える欄（#410）のキーの動き。send：送り直す。cancel：書き換えをやめて、中身に戻る。 */
export type ProxyEditKey = "send" | "cancel";

/**
 * 要求を書き換える欄で押したキー e の動き（当たらなければ null。欄にそのまま字が入る）。
 * - Cmd+Enter（macOS）・Ctrl+Enter（ほか）：送り直す（DB のタブの SQL の実行と同じ。Enter だけは改行）
 * - Esc：書き換えをやめる
 * かな漢字変換の確定・取り消しのキーは受けない。
 */
export function proxyEditKey(e: KeyLike, mac: boolean): ProxyEditKey | null {
  if (isComposingKey(e)) return null;
  if (e.key === "Enter") {
    const mod = mac ? e.metaKey : e.ctrlKey;
    const other = mac ? e.ctrlKey : e.metaKey;
    return mod && !other && !e.altKey && !e.shiftKey ? "send" : null;
  }
  if (
    e.key === "Escape" &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    !e.shiftKey
  )
    return "cancel";
  return null;
}
