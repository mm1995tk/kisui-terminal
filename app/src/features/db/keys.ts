// DB のタブ（#347）の場所のキー（docs/key-design.md の 5 章）。SQL の入力欄にキーがあるときだけ効く。
// `?` の一覧の表は features/commands/placeKeys.ts の db。DOM には触らない（node --test で確かめられる）。
// ターミナルにキーが無い場所なので、シェルや shj のキーとはぶつからない。

import type { KeyLike } from "../commands/guiKeys.ts";
import { isComposingKey } from "../commands/ime.ts";
import type { DbTreeAction } from "./tree.ts";

/** SQL の入力欄のキーで行うこと。run：入力欄の SQL を実行する、cancel：実行している SQL を取り消す。 */
export type DbEditorAction = "run" | "cancel";

/**
 * SQL の入力欄で押したキー e の動き（無ければ null。入力欄にそのまま字が入る）。
 * - Cmd+Enter（macOS）・Ctrl+Enter（ほか）：実行する（ほかのクライアントと同じ。Enter だけは改行）
 * - Esc：実行している SQL を取り消す（実行していなければ何もしない。呼ぶ側が決める）
 * かな漢字変換の確定・取り消しのキーは受けない。
 */
export function dbEditorKey(e: KeyLike, mac: boolean): DbEditorAction | null {
  if (isComposingKey(e)) return null;
  if (e.key === "Enter") {
    const mod = mac ? e.metaKey : e.ctrlKey;
    const other = mac ? e.ctrlKey : e.metaKey;
    return mod && !other && !e.altKey && !e.shiftKey ? "run" : null;
  }
  if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey)
    return "cancel";
  return null;
}

/**
 * 木のペインで押したキー e の動き（無ければ null）。
 * - j k / ↓ ↑：行を動く、g G / Home End：先頭・末尾
 * - l / →：開ける（開いていれば中へ）、h / ←：閉じる（閉じていれば上へ）
 * - Enter：スキーマは開け閉め、テーブルはその中身を見る
 * - Esc：SQL の入力欄に戻る
 * 修飾キーを重ねたものは受けない（リーダーなど、ほかのキーに残す）。かな漢字変換のキーは受けない。
 */
export function dbTreeKey(e: KeyLike): DbTreeAction | null {
  if (isComposingKey(e)) return null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key) {
    case "j":
    case "ArrowDown":
      return e.shiftKey ? null : "next";
    case "k":
    case "ArrowUp":
      return e.shiftKey ? null : "prev";
    case "l":
    case "ArrowRight":
      return e.shiftKey ? null : "expand";
    case "h":
    case "ArrowLeft":
      return e.shiftKey ? null : "collapse";
    case "g":
    case "Home":
      return e.shiftKey ? null : "first";
    case "G":
    case "End":
      return "last";
    case "Enter":
      return e.shiftKey ? null : "enter";
    case "Escape":
      return "back";
  }
  return null;
}
