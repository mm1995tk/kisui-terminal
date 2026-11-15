// 場所のキー（docs/key-design.md の 5 章）の定義。ファイルツリー・変更一覧・動画のペイン・画像のペイン・ダイアログの一覧の
// キーを、リーダーの木（commands.ts）と同じ流儀で、ここ 1 か所に書く。`?` の一覧（KeyListDialog.tsx）はこの表から作る。
// 実際にキーを受ける判定は、場所ごとのファイル（tree/keys.ts・changes/keys.ts・terminal/media.ts・terminal/imageView.ts）にあり、
// placeKeys.test.ts が「表に書いたキーを、その場所の判定が受ける」ことを確かめる。だから案内と受けるキーはずれない。
// 場所のキーはリーダーには載せない（その場所の中だけで効く）。キーを足すときは、判定と、ここの表と、docs/key-design.md を直す。
// DOM には触らない（node --test で確かめられる）。

import type { KeyLike } from "./guiKeys.ts";
import { T } from "./i18n/index.ts";

/** キーがそれぞれに決まっている場所。 */
export type Place =
  "tree" | "changes" | "video" | "image" | "machines" | "list";

/** 表の 1 行。keys は一覧に出す書き方、probes は、判定が受けるはずのキー（KeyboardEvent.key。テストで使う）。 */
export interface PlaceKeyRow {
  keys: string;
  label: string;
  probes: readonly string[];
}

/** 場所ごとの表。title は `?` の一覧の見出し。 */
export interface PlaceKeys {
  title: string;
  lead?: string;
  rows: readonly PlaceKeyRow[];
}

const row = (
  keys: string,
  label: string,
  probes: readonly string[] = [keys],
): PlaceKeyRow => ({ keys, label, probes });

/**
 * 場所ごとの、`?` の一覧に出す行の表。キーを実際に受けるのは各場所の判定（tree/keys.ts など）で、
 * placeKeys.test.ts が、表のキーを判定が受けることを確かめる。
 */
export const PLACE_KEYS: Record<Place, PlaceKeys> = {
  tree: {
    title: T("place.tree.title"),
    lead: T("place.tree.lead"),
    rows: [
      row("j k / ↓ ↑", T("place.row.nextPrev"), [
        "j",
        "k",
        "ArrowDown",
        "ArrowUp",
      ]),
      row("g G / Home End", T("place.row.firstLast"), [
        "g",
        "G",
        "Home",
        "End",
      ]),
      row("l / →", T("place.row.open"), ["l", "ArrowRight"]),
      row("h / ←", T("place.row.closeParent"), ["h", "ArrowLeft"]),
      row("Enter Space", T("place.row.openToggle"), ["Enter", " "]),
      row("a n", T("place.tree.newFile"), ["a", "n"]),
      row("A N", T("place.tree.newFolder"), ["A", "N"]),
      row("r", T("place.row.rename"), ["r"]),
      row("d Delete", T("place.tree.delete"), ["d", "Delete"]),
      row("y", T("place.tree.copyRel"), ["y"]),
      row("Y", T("place.tree.copyAbs"), ["Y"]),
      row("c", T("place.tree.copyName"), ["c"]),
      row("m", T("place.tree.cd"), ["m"]),
      row(". / Menu", T("place.tree.menu"), [".", "ContextMenu"]),
      row("Esc / Ctrl+E", T("place.row.backEditor"), []),
      row("?", T("place.row.keyList"), ["?"]),
    ],
  },
  changes: {
    title: "CHANGES",
    lead: T("place.changes.lead"),
    rows: [
      row("j k / ↓ ↑", T("place.row.nextPrev"), [
        "j",
        "k",
        "ArrowDown",
        "ArrowUp",
      ]),
      row("g G / Home End", T("place.row.firstLast"), [
        "g",
        "G",
        "Home",
        "End",
      ]),
      row("l / →", T("place.row.open"), ["l", "ArrowRight"]),
      row("h / ←", T("place.row.closeParent"), ["h", "ArrowLeft"]),
      row("Enter o", T("place.row.openToggle"), ["Enter", "o"]),
      row("s", T("place.changes.layout"), ["s"]),
      row("r R", T("place.changes.reload"), ["r", "R"]),
      row("Tab", T("place.changes.toTree"), ["Tab"]),
      row("Esc q", T("place.row.backEditor"), ["Escape", "q"]),
      row("?", T("place.row.keyList"), ["?"]),
    ],
  },
  video: {
    title: T("place.video.title"),
    lead: T("place.video.lead"),
    rows: [
      row("Space k", T("place.video.play"), [" ", "k"]),
      row("← →", T("place.video.seek5"), ["ArrowLeft", "ArrowRight"]),
      row("j l", T("place.video.seek10"), ["j", "l"]),
      row("m", T("place.video.mute"), ["m"]),
      row("?", T("place.row.keyList"), ["?"]),
    ],
  },
  image: {
    title: T("place.image.title"),
    lead: T("place.image.lead"),
    rows: [
      row("+ =", T("place.image.zoomIn"), ["+", "="]),
      row("-", T("place.image.zoomOut")),
      row("0", T("place.image.reset")),
      row("h j k l / ← ↓ ↑ →", T("place.image.pan"), [
        "h",
        "j",
        "k",
        "l",
        "ArrowLeft",
        "ArrowDown",
        "ArrowUp",
        "ArrowRight",
      ]),
      row("Esc", T("place.image.backTerminal"), ["Escape"]),
      row("?", T("place.row.keyList"), ["?"]),
    ],
  },
  machines: {
    title: T("place.machines.title"),
    lead: T("place.machines.lead"),
    rows: [
      row("j k / ↓ ↑", T("place.machines.nextPrev"), [
        "j",
        "k",
        "ArrowDown",
        "ArrowUp",
      ]),
      row("g G / Home End", T("place.machines.firstLast"), [
        "g",
        "G",
        "Home",
        "End",
      ]),
      row("a", T("place.machines.add"), ["a"]),
      row("n", T("place.machines.rename"), ["n"]),
      row("d", T("place.machines.remove"), ["d"]),
      row("x", T("place.machines.disconnect"), ["x"]),
      row("r", T("place.machines.reconnect"), ["r"]),
      row("Esc", T("place.row.close"), []),
      row("?", T("place.row.keyList"), ["?"]),
    ],
  },
  list: {
    title: T("place.list.title"),
    lead: T("place.list.lead"),
    rows: [
      row("Ctrl+J / Ctrl+K", T("place.list.step"), []),
      row("↓ ↑", T("place.list.step"), []),
    ],
  },
};

/** `?`（Shift+/ など、`?` の字が出るキー）か。修飾キー（Shift 以外）を押していれば違う。 */
export function isHelpKey(e: KeyLike): boolean {
  return (
    e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing
  );
}

/**
 * ダイアログの一覧で、Ctrl+J は次の行（1）、Ctrl+K は前の行（-1）。ほかは 0。
 * Shift・Alt・Cmd を重ねたものは受けない（Ctrl+Shift+K はリーダーなど、ほかのキーに残す）。
 */
export function listStep(e: KeyLike): 1 | -1 | 0 {
  if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing)
    return 0;
  const k = e.key.toLowerCase();
  if (k === "j") return 1;
  if (k === "k") return -1;
  return 0;
}

const PLACES = new Set<string>([
  "tree",
  "changes",
  "video",
  "image",
  "machines",
]);

/**
 * 今フォーカスがある場所（要素か、その祖先に data-place を付けたもの）。一覧を出す場所のキー（`list` は出さない）。
 * リーダーの `?` が、その場所のキーも出すために使う。
 */
export function placeOf(
  el: { closest?: (s: string) => { dataset: DOMStringMap } | null } | null,
): Place | undefined {
  const p = el?.closest?.("[data-place]")?.dataset.place;
  return p && PLACES.has(p) ? (p as Place) : undefined;
}
