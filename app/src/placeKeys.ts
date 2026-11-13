// 場所のキー（docs/key-design.md の 5 章）の定義。ファイルツリー・変更一覧・動画のペイン・画像のペイン・ダイアログの一覧の
// キーを、リーダーの木（commands.ts）と同じ流儀で、ここ 1 か所に書く。`?` の一覧（KeyListDialog.tsx）はこの表から作る。
// 実際にキーを受ける判定は、場所ごとのファイル（tree/keys.ts・changes/keys.ts・terminal/media.ts・terminal/imageView.ts）にあり、
// placeKeys.test.ts が「表に書いたキーを、その場所の判定が受ける」ことを確かめる。だから案内と受けるキーはずれない。
// 場所のキーはリーダーには載せない（その場所の中だけで効く）。キーを足すときは、判定と、ここの表と、docs/key-design.md を直す。
// DOM には触らない（node --test で確かめられる）。

import type { KeyLike } from "./guiKeys.ts";

/** キーがそれぞれに決まっている場所。 */
export type Place = "tree" | "changes" | "video" | "image" | "list";

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
    title: "ファイルツリー",
    lead: "ファイルツリーの中だけで効くキーです。",
    rows: [
      row("j k / ↓ ↑", "次・前の行へ", ["j", "k", "ArrowDown", "ArrowUp"]),
      row("g G / Home End", "最初・最後の行へ", ["g", "G", "Home", "End"]),
      row("l / →", "開く", ["l", "ArrowRight"]),
      row("h / ←", "閉じる・親のフォルダへ", ["h", "ArrowLeft"]),
      row("Enter Space", "開く・開け閉め", ["Enter", " "]),
      row("a n", "ファイルを作る", ["a", "n"]),
      row("A N", "フォルダを作る", ["A", "N"]),
      row("r", "名前を変える", ["r"]),
      row("d Delete", "削除する", ["d", "Delete"]),
      row("y", "相対パスをコピー", ["y"]),
      row("Y", "絶対パスをコピー", ["Y"]),
      row("c", "名前をコピー", ["c"]),
      row("m", "ターミナルで cd する", ["m"]),
      row(". / Menu", "メニューを開く", [".", "ContextMenu"]),
      row("Esc / Ctrl+E", "エディタへ戻る", []),
      row("?", "キーの一覧", ["?"]),
    ],
  },
  changes: {
    title: "CHANGES",
    lead: "CHANGES の中だけで効くキーです。",
    rows: [
      row("j k / ↓ ↑", "次・前の行へ", ["j", "k", "ArrowDown", "ArrowUp"]),
      row("g G / Home End", "最初・最後の行へ", ["g", "G", "Home", "End"]),
      row("l / →", "開く", ["l", "ArrowRight"]),
      row("h / ←", "閉じる・親のフォルダへ", ["h", "ArrowLeft"]),
      row("Enter o", "開く・開け閉め", ["Enter", "o"]),
      row("s", "左右に並べる・1 列にするを切り替える", ["s"]),
      row("r R", "読み直す", ["r", "R"]),
      row("Tab", "ファイルツリーへ移る", ["Tab"]),
      row("Esc q", "エディタへ戻る", ["Escape", "q"]),
      row("?", "キーの一覧", ["?"]),
    ],
  },
  video: {
    title: "動画",
    lead: "動画の中だけで効くキーです。",
    rows: [
      row("Space k", "再生・一時停止", [" ", "k"]),
      row("← →", "5 秒戻る・進む", ["ArrowLeft", "ArrowRight"]),
      row("j l", "10 秒戻る・進む", ["j", "l"]),
      row("m", "消音する・戻す", ["m"]),
      row("?", "キーの一覧", ["?"]),
    ],
  },
  image: {
    title: "画像",
    lead: "画像の中だけで効くキーです。",
    rows: [
      row("+ =", "拡大する", ["+", "="]),
      row("-", "縮小する"),
      row("0", "元の大きさに戻す"),
      row("h j k l / ← ↓ ↑ →", "見える場所を動かす", [
        "h",
        "j",
        "k",
        "l",
        "ArrowLeft",
        "ArrowDown",
        "ArrowUp",
        "ArrowRight",
      ]),
      row("Esc", "ターミナルへ戻る", ["Escape"]),
      row("?", "キーの一覧", ["?"]),
    ],
  },
  list: {
    title: "候補・履歴の一覧",
    lead: "候補・履歴の一覧の中だけで効くキーです。",
    rows: [
      row("Ctrl+J / Ctrl+K", "次・前の行を選ぶ", []),
      row("↓ ↑", "次・前の行を選ぶ", []),
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

const PLACES = new Set<string>(["tree", "changes", "video", "image"]);

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
