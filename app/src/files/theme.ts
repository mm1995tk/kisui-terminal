// テーマ（theme.get・theme.changed）で、意味の名前を色にする。
// shj は色を fg にだけ入れる（同じ名前を文字にも背景にも使うため。設計書 3 章の B9 の細部）。

import type { Theme } from "../rpc/protocol.ts";
import type { Run } from "./layout.ts";

/** テーマがまだ無いときの色（モックの色）。 */
const FALLBACK: Record<string, string> = {
  "editor.bg": "#121418",
  "editor.fg": "#e6e8ec",
  lineno: "#7d8696",
  "lineno.current": "#e6e8ec",
  curline: "#1a1d23",
  selection: "#2c3a55",
  cursor: "#e6e8ec",
  "cursor.fg": "#121418",
  // タイトル行・状態行（E3）
  "tab.bg": "#181b21",
  "tab.inactive.fg": "#9aa3b2",
  dim: "#9aa3b2",
  border: "#2a2f39",
  accent: "#8fb4ff",
  dirty: "#e2c08d",
  "mode.normal": "#7cc4b0",
  "status.fg": "#0f1114",
  // ポップアップ（E4）
  "palette.bg": "#181b21",
  "palette.hi": "#8fb4ff",
  "list.selected": "#2c3a55",
  strong: "#ffffff",
  error: "#f07178",
  "hover.code.bg": "#1f232b",
  "hover.rule": "#2a2f39",
  // 診断・インデントガイド（E5）
  "diag.error": "#f07178",
  "diag.warn": "#e2c08d",
  "diag.info": "#8fb4ff",
  "diag.hint": "#8fb4ff",
  "indent.guide": "#3a414e",
  // 差分（E6）。色の組は shj の既定のテーマ（dark-plus）と同じ
  "side.bg": "#181b21",
  "diff.add.bg": "#203a27",
  "diff.del.bg": "#3d2125",
  "diff.add.word.bg": "#2f6b3c",
  "diff.del.word.bg": "#7a2e35",
  "diff.add.sign": "#3fb950",
  "diff.del.sign": "#f85149",
  "diff.mod.sign": "#3794ff",
  "diff.bar.view": "#2a2f39",
};

/** name の色。テーマに無ければ控えの色、それも無ければ undefined。 */
export function colorOf(
  theme: Theme | null | undefined,
  name: string | undefined,
): string | undefined {
  if (!name) return undefined;
  return theme?.tokens[name]?.fg || FALLBACK[name];
}

/** 区間の CSS（文字の色・背景・太字など）。行の背景と標準の文字色は親が持つので、違うときだけ付ける。 */
export function runStyle(
  theme: Theme | null | undefined,
  r: Run,
): Record<string, string> {
  const st: Record<string, string> = { width: `${r.cells}ch` };
  if (r.cursor) {
    st.color = colorOf(theme, "cursor.fg") ?? "";
    st.background = colorOf(theme, "cursor") ?? "";
  } else {
    const fg = colorOf(theme, r.fg);
    const bg = colorOf(theme, r.bg);
    if (fg) st.color = fg;
    if (bg) st.background = bg;
  }
  if (r.bold) st["font-weight"] = "bold";
  if (r.italic) st["font-style"] = "italic";
  const deco = [
    (r.underline || r.diag) && "underline",
    r.strike && "line-through",
  ]
    .filter(Boolean)
    .join(" ");
  if (deco) st["text-decoration-line"] = deco;
  // 診断は重さの色の波線（文字の色はスタイルのまま）
  const diag = colorOf(theme, r.diag);
  if (diag) {
    st["text-decoration-style"] = "wavy";
    st["text-decoration-color"] = diag;
    st["text-underline-offset"] = "3px";
  }
  // インデントガイドはマス目の左端の 1px の線（カーソルの上には引かない）
  const guide = r.guide && !r.cursor && colorOf(theme, "indent.guide");
  if (guide) st["box-shadow"] = `inset 1px 0 0 ${guide}`;
  if (r.faint) st.opacity = "0.6";
  return st;
}

/** ファイルの欄の CSS の変数（files.css の --files-*）。 */
export function filesVars(
  theme: Theme | null | undefined,
): Record<string, string | undefined> {
  const c = (name: string) => colorOf(theme, name);
  return {
    "--files-bg": c("editor.bg"),
    "--files-fg": c("editor.fg"),
    "--files-lineno": c("lineno"),
    "--files-lineno-current": c("lineno.current"),
    // タイトル行・状態行（E3）
    "--files-bar-bg": c("tab.bg"),
    "--files-bar-fg": c("dim"),
    "--files-border": c("border"),
    "--files-accent": c("accent"),
    "--files-inactive-fg": c("tab.inactive.fg"),
    // ポップアップ（E4）
    "--files-pop-bg": c("palette.bg"),
    "--files-pop-hi": c("palette.hi"),
    "--files-pop-sel": c("list.selected"),
    "--files-pop-sel-fg": c("strong"),
    "--files-pop-rule": c("hover.rule"),
  };
}
