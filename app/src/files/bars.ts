// ファイルの欄のタイトル行・状態行・コマンド行（E3）の中身を決める。描くのは FilesView.tsx。
// 並べ方は TUI（ui/tui/lines_draw.go の drawTitle・drawStatus・drawCmdline と、
// gitdiff_draw.go の drawDiffHeader）に合わせ、見た目はモック「案：フラットな一覧」に合わせる。
// 文言は shj が組み立てて送るので、ここでは足さない（記号だけを付ける）。

import type { Cmdline, Line, Overlay, Status, Title } from "../rpc/protocol.ts";
import { runeWidth } from "./width.ts";

/** タイトル行の名前の欄に出すファイル名と、右に出すフォルダを含んだパス。 */
export interface TitleText {
  /** 名前の欄に出すもの（パスの最後の部分） */
  name: string;
  /** 右に出すパス。フォルダを含まないときは空 */
  path: string;
}

/** title.text（ワークスペースからの相対パスか、ファイル名）を、名前とパスに分ける。 */
export function titleText(t: Title): TitleText {
  const text = t.text;
  const i = text.lastIndexOf("/");
  if (i < 0 || i === text.length - 1) return { name: text, path: "" };
  return { name: text.slice(i + 1), path: text };
}

/** 状態行の 1 つの項目。style はテーマ上の名前（無ければ状態行の標準の文字色）。 */
export interface StatusItem {
  text: string;
  style?: string;
}

/**
 * 状態行の左（モードの後ろ）に並べるもの。ブランチ、領域の名前、診断の数、提案、メッセージ。
 * 確認（confirm。E4）が出ていれば、メッセージの代わりにその問いを出す（TUI の drawStatus と同じ）。
 */
export function statusLeft(s: Status, confirm?: Overlay): StatusItem[] {
  const out: StatusItem[] = [];
  if (s.branch) out.push({ text: `⎇ ${s.branch}` });
  if (s.pane) out.push({ text: s.pane });
  const errors = s.errors ?? 0;
  const warnings = s.warnings ?? 0;
  if (errors + warnings > 0) {
    out.push({ text: `● ${errors}`, style: "diag.error" });
    out.push({ text: `▲ ${warnings}`, style: "diag.warn" });
  }
  if (s.suggestions) out.push({ text: s.suggestions });
  const ask = confirm ? confirmText(confirm) : "";
  if (ask) out.push({ text: ask, style: "error" });
  else if (s.msg)
    out.push({ text: s.msg, style: s.msgErr ? "error" : "editor.fg" });
  return out;
}

/**
 * 状態行の右に並べるもの。未送信のコメント、位置、字下げ、言語、shj の版。
 * y/n の確認が出ているときは、問いが切れないよう何も出さない（TUI の drawStatus と同じ）。
 */
export function statusRight(s: Status, confirm?: Overlay): StatusItem[] {
  if (confirm?.items?.length) return [];
  return [s.unsent, s.position, s.indent, s.language, s.version]
    .filter((t): t is string => !!t)
    .map((text) => ({ text }));
}

/** モードの欄の文字（途中まで押されたキーを含む）。モードが無ければ空。 */
export function modeLabel(s: Status): string {
  if (!s.mode) return "";
  return s.pending ? `${s.mode} ${s.pending}` : s.mode;
}

/** コマンド行の入力を、カーソルの前・カーソルの文字・後ろに分けたもの（入る幅だけ）。 */
export interface CmdlineText {
  before: string;
  /** カーソルの下の文字。行の終わりなら空白 1 つ */
  at: string;
  after: string;
}

/**
 * コマンド行の入力のうち、cells マス目に入る分を、カーソルが見えるように切り出す。
 * shj はスクロールせずに全部の文字を送るので、はみ出すときは描く側が切る。
 */
export function cmdlineText(c: Cmdline, cells: number): CmdlineText {
  const chars = Array.from(c.text);
  const cur = Math.max(0, Math.min(c.cursor, chars.length));
  const width = (i: number) => runeWidth(chars[i]!, 0);
  const atWidth = cur < chars.length ? width(cur) : 1;
  // カーソルの文字が入るところまで、前を削る
  let start = cur;
  let used = atWidth;
  while (start > 0 && used + width(start - 1) <= cells) {
    start--;
    used += width(start);
  }
  // 残りの幅に、後ろを入れる
  let end = cur + 1;
  while (end < chars.length && used + width(end) <= cells) {
    used += width(end);
    end++;
  }
  return {
    before: chars.slice(start, cur).join(""),
    at: cur < chars.length ? chars[cur]! : " ",
    after: chars.slice(cur + 1, Math.max(cur + 1, end)).join(""),
  };
}

/** 区間の並びで来た行の文字。 */
export function lineText(line: Line | undefined): string {
  return (line?.spans ?? []).map((s) => s.text).join("");
}

/** 確認の問いの文言。 */
export function confirmText(ov: Overlay): string {
  return ov.title ?? "";
}

/** 文字列の幅（マス目）。 */
export function textCells(s: string): number {
  let n = 0;
  for (const ch of s) n += runeWidth(ch, n);
  return n;
}
