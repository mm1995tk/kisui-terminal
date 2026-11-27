// ターミナルのタブの Dialog（リーダーの `a`。#457）に出す、ペインの地図。
// 今のターミナルのタブのペイン（分けたターミナルと、動画・画像・PDF のペイン）を、画面と同じ配置（grid.ts の layoutRects）で並べる。
// Dialog は、この並びから 1 つを選んで操作する（選ぶだけでは、キーを向けているペインは変わらない）。
// DOM を使わないので node --test で確かめられる。

import type {
  ExtraPane,
  PaneLayout,
} from "../../infrastructure/rpc/protocol.ts";
import { layoutRects, type Rect } from "./grid.ts";

/** 地図の 1 つのペイン。 */
export interface PaneCell {
  id: string;
  /** ターミナルか、ターミナルでないペインの種類 */
  kind: "terminal" | ExtraPane["kind"];
  /** プライマリターミナル（閉じられない） */
  primary: boolean;
  /** ペインの名前（kisui pane title）。付けていなければ undefined */
  title?: string;
  /** ターミナルでないペインが出しているファイルの名前（パスの最後の部分） */
  file?: string;
  /** 位置。タブの場所の左上を原点にした割合（0〜1） */
  rect: Rect;
  /** キーを向けているペイン */
  active: boolean;
  /** プライマリ以外を隠している間の、隠れているペイン */
  hidden: boolean;
}

/** 地図の元になる、ターミナルのタブのペインの並び（TermGroup が満たす）。 */
export interface PaneSource {
  readonly list: readonly { id: string; primary: boolean }[];
  readonly extras: readonly ExtraPane[];
  readonly layout: PaneLayout | undefined;
  readonly titles: Readonly<Record<string, string>>;
  readonly activeId: string | undefined;
}

/** パスの最後の部分（ファイルの名前）。 */
function baseName(path: string): string {
  return (
    path
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() || path
  );
}

/**
 * ペインの地図。並びはターミナル、ターミナルでないペインの順（TermGroup の paneIds と同じ）。
 * zoomed（プライマリ以外を隠している）なら、プライマリ以外に hidden が付く（隠していても、地図には全部出す）。
 * ペインを出せない（つながっていない）ときは []。
 */
export function paneCells(
  g: PaneSource | undefined,
  zoomed: boolean,
): PaneCell[] {
  if (!g) return [];
  const rects = layoutRects(g.layout);
  const out: PaneCell[] = [];
  const push = (
    cell: Omit<PaneCell, "rect" | "active" | "hidden" | "title">,
  ) => {
    const rect = rects.get(cell.id);
    if (!rect) return;
    out.push({
      ...cell,
      title: g.titles[cell.id] || undefined,
      rect,
      active: cell.id === g.activeId,
      hidden: zoomed && !cell.primary,
    });
  };
  for (const l of g.list)
    push({ id: l.id, kind: "terminal", primary: l.primary });
  for (const x of g.extras)
    push({ id: x.id, kind: x.kind, primary: false, file: baseName(x.path) });
  return out;
}

/**
 * Dialog で選んでいるペインの id。選んでいたペイン（want）がもう無ければ、キーを向けているペイン、それも無ければ最初のペイン。
 * ペインが無ければ undefined。
 */
export function selectedPane(
  cells: readonly PaneCell[],
  want: string | undefined,
): string | undefined {
  if (want !== undefined && cells.some((c) => c.id === want)) return want;
  return (cells.find((c) => c.active) ?? cells[0])?.id;
}
