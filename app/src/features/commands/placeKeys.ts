// 場所のキー（docs/key-design.md の 5 章）の定義。ファイルツリー・変更一覧・動画のペイン・画像のペイン・窓（ダイアログ）の
// キーを、リーダーの木（commands.ts）と同じ流儀で、ここ 1 か所に書く。`?` の一覧（KeyListDialog.tsx）はこの表から作る。
// 実際にキーを受ける判定は、場所ごとのファイル（features/file-tree/keys.ts・features/changes/keys.ts・features/terminal/media.ts・ui/main-window/content/media/imageView.ts・
// features/sessions/machineList.ts・features/browser/bookmarks.ts・features/clipboard/history.ts・ui/main-window/workspaces/switcherKey.ts・features/db/keys.ts）にあり、
// placeKeys.test.ts（切り替える窓は switcherKey.test.ts）が「表に書いたキーを、その場所の判定が受ける」ことを確かめる。だから案内と受けるキーはずれない。
// 窓の下の段（共通フッタ）に出す基本操作の並びも、ここの basicHints が決める（docs/design/ui-ux-review.md の「ヒントとヘルプ」）。
// 場所のキーはリーダーには載せない（その場所の中だけで効く）。キーを足すときは、判定と、ここの表と、docs/key-design.md を直す。
// DOM には触らない（node --test で確かめられる）。

import { isComposingKey } from "./ime.ts";
import type { KeyLike } from "./guiKeys.ts";
import { T } from "../../i18n/index.ts";

/** キーがそれぞれに決まっている場所。 */
export type Place =
  | "tree"
  | "changes"
  | "video"
  | "image"
  | "machines"
  | "list"
  | "bookmarks"
  | "picker"
  | "switcher"
  | "switcherTabs"
  | "history"
  | "db"
  | "dbResult"
  | "dbTree"
  | "dbHistory";

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
 * 場所ごとの、`?` の一覧に出す行の表。キーを実際に受けるのは各場所の判定（features/file-tree/keys.ts など）で、
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
  // 内蔵ブラウザのブックマークの一覧（リーダーの o B。#205）。判定は features/browser/bookmarks.ts の bookmarkKey（修飾キー付きのものは probes に書けないので、
  // bookmarks.test.ts で確かめる）
  bookmarks: {
    title: T("place.bookmarks.title"),
    lead: T("place.bookmarks.lead"),
    rows: [
      row("↓ ↑ / Ctrl+J Ctrl+K", T("place.list.step"), [
        "ArrowDown",
        "ArrowUp",
      ]),
      row("Enter", T("place.bookmarks.open")),
      row("Ctrl+D", T("place.bookmarks.delete"), []),
      row("?", T("place.bookmarks.help")),
      row("Esc", T("place.row.close"), []),
    ],
  },
  // 一覧から 1 つ選ぶ窓（マシン・移す先のワークスペース・ワークスペースの種類・キャラクター）。判定は features/sessions/machineList.ts の pickerKey
  picker: {
    title: T("place.picker.title"),
    lead: T("place.picker.lead"),
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
      row("Ctrl+J / Ctrl+K", T("place.row.nextPrev"), []),
      row("Enter", T("place.picker.choose")),
      row("?", T("place.row.keyList")),
      row("Esc", T("place.picker.cancel"), []),
    ],
  },
  // ワークスペースを切り替える窓（リーダーの w）のワークスペースの列。判定は ui/main-window/workspaces/switcherKey.ts の switcherKey
  // （表のキーを判定が受けることは、switcherKey.test.ts が確かめる）
  switcher: {
    title: T("place.switcher.title"),
    lead: T("place.switcher.lead"),
    rows: [
      row("j k / ↓ ↑", T("place.switcher.nextPrev"), [
        "j",
        "k",
        "ArrowDown",
        "ArrowUp",
      ]),
      row("l / →", T("place.switcher.toTabs"), ["l", "ArrowRight"]),
      row("Enter", T("place.switcher.go")),
      row("n", T("place.switcher.new")),
      row("N", T("place.switcher.newBrowser")),
      row("r", T("place.row.rename")),
      row("x", T("place.switcher.close")),
      row("J K", T("place.switcher.reorder"), ["J", "K"]),
      row("?", T("place.row.keyList")),
      row("Esc", T("place.row.close"), []),
    ],
  },
  // 同じ窓のタブの列
  switcherTabs: {
    title: T("place.switcherTabs.title"),
    lead: T("place.switcherTabs.lead"),
    rows: [
      row("j k / ↓ ↑", T("place.switcherTabs.nextPrev"), [
        "j",
        "k",
        "ArrowDown",
        "ArrowUp",
      ]),
      row("h / ←", T("place.switcherTabs.toWorkspaces"), ["h", "ArrowLeft"]),
      row("Enter", T("place.switcherTabs.show")),
      row("n", T("place.switcherTabs.new")),
      row("N", T("place.switcher.newBrowser")),
      row("r", T("place.row.rename")),
      row("x", T("place.switcherTabs.close")),
      row("J K", T("place.switcherTabs.reorder"), ["J", "K"]),
      row("m", T("place.switcherTabs.hold")),
      row("?", T("place.row.keyList")),
      row("Esc", T("place.row.close"), []),
    ],
  },
  // クリップボードの履歴の窓（リーダーの y）。判定は features/clipboard/history.ts の historyKey（修飾キー付きのものは probes に書けないので、
  // history.test.ts で確かめる）
  history: {
    title: T("place.history.title"),
    lead: T("place.history.lead"),
    rows: [
      row("↓ ↑ / Ctrl+J Ctrl+K", T("place.list.step"), [
        "ArrowDown",
        "ArrowUp",
      ]),
      row("Enter", T("place.history.paste")),
      row("Shift+Enter", T("place.history.putBack"), []),
      row("?", T("place.bookmarks.help")),
      row("Esc", T("place.row.close"), []),
    ],
  },
  // DB のタブの SQL の入力欄（#347）。判定は features/db/keys.ts の dbEditorKey（修飾キー付きのものは probes に書けないので、
  // keys.test.ts で確かめる）。入力欄では `?` は字なので、この一覧はリーダーの `?` で出す
  db: {
    title: T("place.db.title"),
    lead: T("place.db.lead"),
    rows: [
      row("Cmd+Enter / Ctrl+Enter", T("place.db.run"), []),
      row("Esc", T("place.db.cancel"), ["Escape"]),
    ],
  },
  // DB のタブの結果の表（#372）。判定は features/db/keys.ts の dbResultKey（修飾キー付きのものは probes に書けないので、
  // keys.test.ts で確かめる）。表をクリックするかフォーカスを向けたときだけ効く。`[` `]` は文ごとの結果のタブの切り替え
  // （#380。dbResultTabKey）で、結果のタブの列にキーがあるときも効く
  dbResult: {
    title: T("place.dbResult.title"),
    lead: T("place.dbResult.lead"),
    rows: [
      row("Cmd+C / Ctrl+C", T("place.dbResult.copy"), []),
      row("s", T("place.dbResult.sort"), ["s"]),
      row("[ / ]", T("place.dbResult.step"), ["[", "]"]),
    ],
  },
  // DB のタブの履歴の窓（リーダーの d h。#349）。判定は features/db/keys.ts の dbHistoryKey（修飾キー付きのものは probes に書けないので、
  // keys.test.ts で確かめる）
  dbHistory: {
    title: T("place.dbHistory.title"),
    lead: T("place.dbHistory.lead"),
    rows: [
      row("↓ ↑ / Ctrl+J Ctrl+K", T("place.list.step"), [
        "ArrowDown",
        "ArrowUp",
      ]),
      row("Enter", T("place.dbHistory.choose")),
      row("?", T("place.bookmarks.help")),
      row("Esc", T("place.row.close"), []),
    ],
  },
  // サイドバーの DB のタブの木（#348・#374）。判定は features/db/keys.ts の dbTreeKey
  dbTree: {
    title: T("place.dbTree.title"),
    lead: T("place.dbTree.lead"),
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
      row("l / →", T("place.dbTree.expand"), ["l", "ArrowRight"]),
      row("h / ←", T("place.dbTree.collapse"), ["h", "ArrowLeft"]),
      row("Enter", T("place.dbTree.enter")),
      row("/", T("place.dbTree.filter")),
      row("s", T("place.dbTree.schema")),
      row("Esc", T("place.dbTree.back"), ["Escape"]),
    ],
  },
};

/**
 * 真ん中に出す窓（ModalCard）の場所。窓が出ている間はリーダーに入れないので、
 * `?` の一覧は、リーダーの木を出さずに、その窓のキーだけを出す（KeyListDialog.tsx）。
 */
const WINDOW_PLACES = new Set<Place>([
  "machines",
  "bookmarks",
  "picker",
  "switcher",
  "switcherTabs",
  "history",
  "dbHistory",
]);

/** 窓（ModalCard）の場所か。 */
export function isWindowPlace(p: Place): boolean {
  return WINDOW_PLACES.has(p);
}

/** 窓の下の段（共通フッタ）に出すヒントの 1 項目（ui/components/KeyHints.tsx の KeyHint と同じ形）。 */
export interface BasicHint {
  keys: string[];
  label: string;
}

/**
 * 窓の下の段（共通フッタ）に出す基本操作。どの窓でも「選ぶ → 移る → 決める → `?` → やめる・閉じる」の順に並べ、
 * 同じ役割には同じ字を使う。これより詳しい操作（作る・名前を変える・並べ替えるなど）は、`?` の一覧（PLACE_KEYS）にだけ出す。
 * - select：選ぶ行を動かすキー。省くと j k（入力欄に字を打つ窓は ↓ ↑ を渡す）
 * - move：選ぶ以外の移るキー（切り替える窓の列を移る h・l）
 * - decide：Enter で決める操作の字。省くと Enter を出さない（Enter で決めるものが無い窓）
 * - help：`?` が今効くか。省くと効く。効かない間（絞り込みに字を打っている間・`?` の一覧を出せない窓）は false を渡し、出さない
 * - end：Esc が、決めずにやめる（cancel）のか、見終えて閉じる（close）のか
 */
export function basicHints(o: {
  select?: string[];
  move?: readonly BasicHint[];
  decide?: string;
  help?: boolean;
  end: "cancel" | "close";
}): BasicHint[] {
  return [
    { keys: o.select ?? ["j", "k"], label: T("basic.select") },
    ...(o.move ?? []),
    ...(o.decide === undefined ? [] : [{ keys: ["Enter"], label: o.decide }]),
    ...(o.help === false ? [] : [{ keys: ["?"], label: T("basic.help") }]),
    {
      keys: ["Esc"],
      label: o.end === "cancel" ? T("basic.cancel") : T("basic.close"),
    },
  ];
}

/** `?`（Shift+/ など、`?` の字が出るキー）か。修飾キー（Shift 以外）を押していれば違う。 */
export function isHelpKey(e: KeyLike): boolean {
  return (
    e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey && !isComposingKey(e)
  );
}

/**
 * ダイアログの一覧で、Ctrl+J は次の行（1）、Ctrl+K は前の行（-1）。ほかは 0。
 * Shift・Alt・Cmd を重ねたものは受けない（Ctrl+Shift+K はリーダーなど、ほかのキーに残す）。
 */
export function listStep(e: KeyLike): 1 | -1 | 0 {
  if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || isComposingKey(e))
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
  "db",
  "dbResult",
  "dbTree",
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
