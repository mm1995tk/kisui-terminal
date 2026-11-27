// 場所のキー（docs/key-design.md の 5 章）の定義。ファイルツリー・CHANGES・動画のペイン・画像のペイン・Dialog（ダイアログ）の
// キーを、リーダーの木（commands.ts）と同じ流儀で、ここ 1 か所に書く。`?` の一覧（KeyListDialog.tsx）はこの表から作る。
// 実際にキーを受ける判定は、場所ごとのファイル（features/file-tree/keys.ts・features/changes/keys.ts・features/terminal/media.ts・ui/main-window/content/media/imageView.ts・
// features/sessions/machineList.ts・features/browser/bookmarks.ts・features/clipboard/history.ts・ui/main-window/workspaces/switcherKey.ts・
// ui/main-window/tab-window/terminalWindowKey.ts・ui/main-window/tab-window/dbWindowKey.ts・ui/main-window/tab-window/browserWindowKey.ts・features/db/keys.ts）にあり、
// placeKeys.test.ts（Workspace switcher は switcherKey.test.ts、ターミナルのタブの Dialog は terminalWindowKey.test.ts、DB のタブの Dialog は dbWindowKey.test.ts、ブラウザのタブの Dialog は browserWindowKey.test.ts）が「表に書いたキーを、その場所の判定が受ける」ことを確かめる。だから案内と受けるキーはずれない。
// Dialog の Key footer（共通フッタ）に出す今効く操作も、ここの表の行から作る（placeItem。決まりは docs/design/ui-ux-review.md の「ヒントとヘルプ」）。
// まだ新しい形にしていない Dialog（クリップボードの履歴・DB の履歴・DB の権限を強める Dialog）は、基本操作の並びを basicHints で出す。
// 場所のキーはリーダーには載せない（その場所の中だけで効く）。キーを足すときは、判定と、ここの表と、docs/key-design.md を直す。
// DOM には触らない（node --test で確かめられる）。

import { isComposingKey } from "./ime.ts";
import type { KeyLike } from "./guiKeys.ts";
import { lang, T, type Lang } from "../../i18n/index.ts";

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
  | "dbPicker"
  | "switcher"
  | "switcherTabs"
  | "termWindow"
  | "dbWindow"
  | "browserWindow"
  | "history"
  | "db"
  | "dbResult"
  | "dbTree"
  | "dbHistory"
  | "proxy"
  | "proxyEdit";

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
const buildPlaceKeys = (): Record<Place, PlaceKeys> => ({
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
      row("x", T("place.changes.sides"), ["x"]),
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
      row("Enter", T("place.machines.newTab")),
      row("a", T("place.machines.add"), ["a"]),
      row("n", T("place.machines.rename"), ["n"]),
      row("d", T("place.machines.remove"), ["d"]),
      row("x", T("place.machines.disconnect"), ["x"]),
      row("r", T("place.machines.reconnect"), ["r"]),
      row("t", T("place.machines.terminal"), ["t"]),
      row("p", T("place.machines.grant"), ["p"]),
      row("P", T("place.machines.grantEnd"), ["P"]),
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
  // 内蔵ブラウザのブックマークの一覧（ブラウザのタブの Dialog の B。#205）。判定は features/browser/bookmarks.ts の bookmarkKey（修飾キー付きのものは probes に書けないので、
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
  // 一覧から 1 つ選ぶ Dialog（マシン・移す先のワークスペース・ワークスペースの種類・キャラクター）。判定は features/sessions/machineList.ts の pickerKey
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
  // DB の接続を選ぶ Dialog（#347。足す・直す・消すは #486）。判定は features/db/pickerKeys.ts の dbPickerKey
  dbPicker: {
    title: T("place.dbPicker.title"),
    lead: T("place.dbPicker.lead"),
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
      row("Enter", T("place.dbPicker.open")),
      row("a", T("place.dbPicker.add")),
      row("e", T("place.dbPicker.edit")),
      row("d", T("place.dbPicker.remove")),
      row("?", T("place.row.keyList")),
      row("Esc", T("place.picker.cancel"), []),
    ],
  },
  // Workspace switcher（リーダーの w）のワークスペースの列。判定は ui/main-window/workspaces/switcherKey.ts の switcherKey
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
      row("N", T("place.switcher.newTab")),
      row("r", T("place.row.rename")),
      row("x", T("place.switcher.close")),
      row("J K", T("place.switcher.reorder"), ["J", "K"]),
      row("?", T("place.row.keyList")),
      row("Esc", T("place.row.close"), []),
    ],
  },
  // 同じ Dialog のタブの列
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
      row("r", T("place.row.rename")),
      row("x", T("place.switcherTabs.close")),
      row("J K", T("place.switcherTabs.reorder"), ["J", "K"]),
      row("m", T("place.switcherTabs.hold")),
      row("?", T("place.row.keyList")),
      row("Esc", T("place.row.close"), []),
    ],
  },
  // ターミナルのタブの Dialog（リーダーの a。#457）。判定は ui/main-window/tab-window/terminalWindowKey.ts の terminalWindowKey
  // （表のキーを判定が受けることは、terminalWindowKey.test.ts が確かめる）
  termWindow: {
    title: T("place.termWindow.title"),
    lead: T("place.termWindow.lead"),
    rows: [
      row("h j k l / ← ↓ ↑ →", T("place.termWindow.select"), [
        "h",
        "j",
        "k",
        "l",
        "ArrowLeft",
        "ArrowDown",
        "ArrowUp",
        "ArrowRight",
      ]),
      row("Enter", T("place.termWindow.focus")),
      row("s", T("place.termWindow.split")),
      row("H J K L", T("place.termWindow.swap"), ["H", "J", "K", "L"]),
      row("x", T("place.termWindow.close")),
      row("z", T("place.termWindow.zoom")),
      row("r", T("place.termWindow.resize")),
      row("?", T("place.row.keyList")),
      row("Esc", T("place.row.close"), []),
    ],
  },
  // DB のタブの Dialog（リーダーの a。#458）。判定は ui/main-window/tab-window/dbWindowKey.ts の dbWindowKey
  // （表のキーを判定が受けることは、dbWindowKey.test.ts が確かめる）
  dbWindow: {
    title: T("place.dbWindow.title"),
    lead: T("place.dbWindow.lead"),
    rows: [
      row("j k / ↓ ↑", T("place.dbWindow.select"), [
        "j",
        "k",
        "ArrowDown",
        "ArrowUp",
      ]),
      row("Enter", T("place.dbWindow.show")),
      row("x", T("place.dbWindow.close")),
      row("s", T("place.dbWindow.view")),
      row("f b", T("place.dbWindow.page"), ["f", "b"]),
      row("c", T("place.dbWindow.cancel")),
      row("e", T("place.dbWindow.export")),
      row("t", T("place.dbWindow.tree")),
      row("r", T("place.dbWindow.refresh")),
      row("h", T("place.dbWindow.history")),
      row("p", T("place.dbWindow.elevate")),
      row("P", T("place.dbWindow.elevateEnd")),
      row("?", T("place.row.keyList")),
      row("Esc", T("place.row.close"), []),
    ],
  },
  // ブラウザのタブの Dialog（リーダーの a。#459）。判定は ui/main-window/tab-window/browserWindowKey.ts の browserWindowKey
  // （表のキーを判定が受けることは、browserWindowKey.test.ts が確かめる）。字ごとの操作の名前は、Dialog の行と同じ（features/browser/window.ts）
  browserWindow: {
    title: T("place.browserWindow.title"),
    lead: T("place.browserWindow.lead"),
    rows: [
      row("j k / ↓ ↑", T("place.browserWindow.select"), [
        "j",
        "k",
        "ArrowDown",
        "ArrowUp",
      ]),
      row("Enter", T("place.browserWindow.run")),
      row("h / ←", T("leader.browser.back"), ["h", "ArrowLeft"]),
      row("l / →", T("leader.browser.forward"), ["l", "ArrowRight"]),
      row("r", T("leader.browser.reload")),
      row("c", T("leader.browser.stop")),
      row("u", T("leader.browser.url")),
      row("y", T("leader.browser.copyUrl")),
      row("e", T("leader.browser.external")),
      row("s", T("leader.browser.login")),
      row("/", T("leader.browser.find")),
      row("b", T("leader.browser.bookmark")),
      row("B", T("leader.browser.bookmarks")),
      row("i", T("leader.browser.devtools")),
      row("?", T("place.row.keyList")),
      row("Esc", T("place.row.close"), []),
    ],
  },
  // クリップボードの履歴の Dialog（リーダーの y）。判定は features/clipboard/history.ts の historyKey（修飾キー付きのものは probes に書けないので、
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
      row("Cmd+Option+Enter / Ctrl+Shift+Enter", T("place.db.runNew"), []),
      row("Esc", T("place.db.cancel"), ["Escape"]),
    ],
  },
  // DB のタブの結果の表（#372）。判定は features/db/keys.ts の dbResultKey（修飾キー付きのものは probes に書けないので、
  // keys.test.ts で確かめる）。表をクリックするかフォーカスを向けたときだけ効く。`[` `]` は結果のタブの切り替え
  // （#404。dbResultTabKey）で、結果のタブの列にキーがあるときも効く
  dbResult: {
    title: T("place.dbResult.title"),
    lead: T("place.dbResult.lead"),
    rows: [
      row("Cmd+C / Ctrl+C", T("place.dbResult.copy"), []),
      row("s", T("place.dbResult.sort"), ["s"]),
      row("[ / ]", T("place.dbResult.step"), ["[", "]"]),
    ],
  },
  // DB のタブの履歴の Dialog（DB のタブの Dialog の h。#349・#458）。判定は features/db/keys.ts の dbHistoryKey（修飾キー付きのものは probes に書けないので、
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
  // プロキシのパネル（#409）。判定は features/proxy/keys.ts の proxyPanelKey
  proxy: {
    title: T("place.proxy.title"),
    lead: T("place.proxy.lead"),
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
      row("Tab / h l / ← →", T("place.proxy.side"), [
        "Tab",
        "h",
        "l",
        "ArrowLeft",
        "ArrowRight",
      ]),
      row("e", T("place.proxy.edit")),
      row("i", T("place.proxy.hold")),
      row("f", T("place.proxy.forward")),
      row("d", T("place.proxy.drop")),
      row("Esc", T("place.proxy.back"), ["Escape"]),
      row("q", T("place.proxy.close")),
    ],
  },
  // プロキシのパネルの、要求を書き換える欄（#410。パネルの e）。判定は features/proxy/keys.ts の proxyEditKey（修飾キー付きのものは
  // probes に書けないので、keys.test.ts で確かめる）
  proxyEdit: {
    title: T("place.proxyEdit.title"),
    lead: T("place.proxyEdit.lead"),
    rows: [
      row("Cmd+Enter / Ctrl+Enter", T("place.proxyEdit.send"), []),
      row("Esc", T("place.proxyEdit.cancel"), ["Escape"]),
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
});

let built: { lang: Lang; keys: Record<Place, PlaceKeys> } | undefined;

/**
 * 場所ごとの表を、今の言語で作る（呼ぶたびに引き直す。言語が変わらなければ同じものを返す）。言語を決める前に、この表を読み込む import（index.tsx の履歴の Dialog の
 * 部品からの import など）が通っても英語に固まらないよう、読み込んだときには作らず、使うときに作る（言語が変われば作り直す）。
 */
export function placeKeys(): Record<Place, PlaceKeys> {
  const l = lang();
  if (built?.lang !== l) built = { lang: l, keys: buildPlaceKeys() };
  return built.keys;
}

/**
 * 真ん中に出す Dialog（ModalCard）の場所。Dialog が出ている間はリーダーに入れないので、
 * `?` の一覧は、リーダーの木を出さずに、その Dialog のキーだけを出す（KeyListDialog.tsx）。
 */
const WINDOW_PLACES = new Set<Place>([
  "machines",
  "bookmarks",
  "picker",
  "dbPicker",
  "switcher",
  "switcherTabs",
  "termWindow",
  "dbWindow",
  "browserWindow",
  "history",
  "dbHistory",
]);

/** Dialog（ModalCard）の場所か。 */
export function isWindowPlace(p: Place): boolean {
  return WINDOW_PLACES.has(p);
}

/**
 * Dialog の Key footer（共通フッタ）の 1 項目（今効く操作 1 つ）。keys は出すキー、label は操作の名前（日本語の Dialog でも英語。
 * i18n のキーは `<Dialog>.keys.<名前>`）。probes は、その操作で Dialog の判定が受けるはずのキー（KeyboardEvent.key。テストで使う）。
 * act は、押せるボタンにする項目の印（呼んだ側が、押したときの動きに結ぶ。作るタブの種類など）。A は act の型（押せる項目が無ければ never）。
 */
export interface FooterItem<A extends string = never> {
  keys: string[];
  label: string;
  probes: readonly string[];
  act?: A;
}

/**
 * Dialog の Key footer の 1 行。title は、その行の操作が何に効くか（「選んでいるタブ」など。説明の文なので、日本語の Dialog では日本語）。
 * items が空でも行は出す（見出しだけ。Key footer が出たり消えたりしないように）。決まりは docs/design/ui-ux-review.md の「ヒントとヘルプ」。
 */
export interface FooterRow<A extends string = never> {
  title: string;
  items: FooterItem<A>[];
}

/**
 * どの Dialog でも同じ意味のキー（選ぶ j k・列を移る h l・矢印・決める Enter・やめる／閉じる Esc・`?` の一覧・Ctrl+J / Ctrl+K）。
 * Dialog の Key footer には出さない（意味が変わる間を除く）。`?` の一覧（placeKeys()）には出す。
 */
export const COMMON_KEYS: ReadonlySet<string> = new Set([
  "j",
  "k",
  "h",
  "l",
  "ArrowDown",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
  "Enter",
  "Escape",
  "?",
]);

/**
 * 場所 place の `?` の一覧の表から、keys の行（書き方が同じ行）を引いて、Dialog の Key footer の 1 項目にする。
 * 出すキーと、テストで判定に通すキー（probes）は表の行のものを使うので（行が「h / ←」のように 1 つの操作に複数の書き方を持つときは、show で出すキーを選ぶ）、Key footer・`?` の一覧・判定がずれない。表に無ければ投げる（書き間違い）。
 */
export function placeItem(
  place: Place,
  keys: string,
  label: string,
  show?: string[],
): FooterItem {
  const r = placeKeys()[place].rows.find((x) => x.keys === keys);
  if (!r) throw new Error(`placeKeys().${place} has no row "${keys}"`);
  return { keys: show ?? keys.split(" "), label, probes: r.probes };
}

/**
 * 選ぶだけの小さな Dialog（一覧から 1 つ選ぶ Dialog）の Key footer。Dialog だけの操作は無い（選ぶ・決める・やめるは、どの Dialog でも同じキー）ので、
 * 何を選ぶかの見出しだけの 1 行を出す（Key footer はいつも出す。決まりは docs/design/ui-ux-review.md の「ヒントとヘルプ」の 11）。
 */
export function pickOnlyRows(title: string): FooterRow[] {
  return [{ title, items: [] }];
}

/** Dialog の Key footer（共通フッタ）に出すヒントの 1 項目（ui/components/KeyHints.tsx の KeyHint と同じ形）。 */
export interface BasicHint {
  keys: string[];
  label: string;
}

/**
 * Dialog の Key footer（共通フッタ）に出す基本操作（まだ今効く操作の行の形（FooterRow）にしていない Dialog が使う。使う Dialog が無くなったら消す）。どの Dialog でも「選ぶ → 移る → 決める → `?` → やめる・閉じる」の順に並べ、
 * 同じ役割には同じ字を使う。これより詳しい操作（作る・名前を変える・並べ替えるなど）は、`?` の一覧（placeKeys()）にだけ出す。
 * - select：選ぶ行を動かすキー。省くと j k（入力欄に字を打つ Dialog は ↓ ↑ を渡す）
 * - move：選ぶ以外の移るキー（Workspace switcher の列を移る h・l）
 * - decide：Enter で決める操作の字。省くと Enter を出さない（Enter で決めるものが無い Dialog）
 * - help：`?` が今効くか。省くと効く。効かない間（絞り込みに字を打っている間・`?` の一覧を出せない Dialog）は false を渡し、出さない
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
  "proxy",
  "proxyEdit",
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
