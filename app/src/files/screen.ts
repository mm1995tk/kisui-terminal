// screen.update（変わった分だけ）を、手元に持っている Screen に当てる。
// 送り方は設計書 docs/design/gui-protocol.md の 3 章「画面（Screen）の送り方」と、Go の
// ui/gui/server/view_diff.go。
//
// - 付いている領域だけが変わった。cmdline は閉じたら null。
// - files.panes には今のペインが全部並ぶ（並びで消えたペインが分かる）。前からあるペインは id と
//   変わった項目だけ、新しいペインは全部の項目を持つ。
// - lines.rows のキーは「ビューポートの中で上から何行目か」、count は見えている行数。
//
// 変わらなかったペインと行は、前のオブジェクトをそのまま使う（描く側が、変わったところだけ描き直せるように）。
// 版（baseRev）の確かめは呼ぶ側（Session）がする。

import type {
  Files,
  Line,
  Pane,
  PaneUpdate,
  Screen,
  ScreenUpdate,
} from "../rpc/protocol.ts";

/** 画面がまだ無いときの土台。 */
function emptyScreen(): Screen {
  return { rev: 0, ackSeq: 0, focus: "", status: null };
}

/** prev に u を当てた新しい画面。prev は変えない。 */
export function applyUpdate(prev: Screen | null, u: ScreenUpdate): Screen {
  const base = prev ?? emptyScreen();
  const next: Screen = { ...base, rev: u.rev, ackSeq: u.ackSeq };
  if (u.focus !== undefined) next.focus = u.focus;
  if (u.status !== undefined) next.status = u.status;
  if ("cmdline" in u) next.cmdline = u.cmdline;
  if ("overlay" in u) next.overlay = u.overlay;
  if (u.files) next.files = applyFiles(base.files, u.files);
  return next;
}

function applyFiles(
  prev: Files | undefined,
  u: NonNullable<ScreenUpdate["files"]>,
): Files {
  const old = new Map((prev?.panes ?? []).map((p) => [p.id, p]));
  return {
    panes: u.panes.map((pu) => applyPane(old.get(pu.id), pu)),
    active: u.active ?? prev?.active ?? 0,
  };
}

/** 新しいペインの土台（新しいペインは全部の項目を持つので、ふつうは全部上書きされる）。 */
function emptyPane(id: string): Pane {
  return {
    id,
    title: { text: "" },
    kind: "text",
    viewport: { top: 0, rows: 0, cols: 0, left: 0, total: 0 },
    curLine: 0,
    lines: [],
  };
}

function applyPane(prev: Pane | undefined, u: PaneUpdate): Pane {
  const keys = Object.keys(u).filter((k) => k !== "id");
  if (prev && keys.length === 0) return prev;
  const next: Pane = { ...(prev ?? emptyPane(u.id)) };
  for (const k of keys) {
    if (k === "lines") continue;
    next[k] = u[k];
  }
  if (u.lines) next.lines = applyLines(prev?.lines ?? [], u.lines);
  return next;
}

/** 空いた行（来るはずの行が来なかったとき）。描くと空の行になる。 */
const BLANK: Line = { no: -1, spans: [] };

function applyLines(
  prev: readonly Line[] | null,
  u: NonNullable<PaneUpdate["lines"]>,
): Line[] {
  const out: Line[] = [];
  for (let i = 0; i < u.count; i++) {
    out.push(u.rows[String(i)] ?? prev?.[i] ?? BLANK);
  }
  return out;
}
