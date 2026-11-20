import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { changesKey } from "../changes/keys.ts";
import { bookmarkKey } from "../browser/bookmarks.ts";
import { historyKey } from "../clipboard/history.ts";
import { machineKey, pickerKey } from "../sessions/machineList.ts";
import {
  basicHints,
  isHelpKey,
  isWindowPlace,
  listStep,
  PLACE_KEYS,
  placeOf,
  type Place,
} from "./placeKeys.ts";
import { setLang } from "../../i18n/index.ts";
import { imageKey } from "../../ui/main-window/content/media/imageView.ts";
import { videoKey } from "../terminal/media.ts";
import { treeKey } from "../file-tree/keys.ts";
import { dbEditorKey, dbHistoryKey, dbTreeKey } from "../db/keys.ts";

const ev = (key: string, extra: object = {}) => ({
  key,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  ...extra,
});

describe("場所のキーの表は、その場所の判定と合っている", () => {
  it("ファイルツリー：表のキーは、どれも判定が受ける", () => {
    const closedDir = { dir: true, expanded: false };
    for (const r of PLACE_KEYS.tree.rows)
      for (const p of r.probes)
        assert.notEqual(treeKey(closedDir, ev(p)), null, `${r.keys}: ${p}`);
  });

  it("変更一覧：表のキーは、どれも判定が受ける", () => {
    const dir = { kind: "dir", expanded: false } as const;
    for (const r of PLACE_KEYS.changes.rows)
      for (const p of r.probes)
        assert.notEqual(changesKey(dir, ev(p)), null, `${r.keys}: ${p}`);
  });

  it("動画のペイン：表のキーは、どれも判定が受ける", () => {
    for (const r of PLACE_KEYS.video.rows)
      for (const p of r.probes)
        assert.notEqual(videoKey(ev(p)), null, `${r.keys}: ${p}`);
  });

  it("画像のペイン：表のキーは、どれも判定が受ける", () => {
    for (const r of PLACE_KEYS.image.rows)
      for (const p of r.probes)
        assert.notEqual(imageKey(ev(p)), null, `${r.keys}: ${p}`);
  });

  it("マシンのダイアログ：表のキーは、どれも判定が受ける", () => {
    for (const r of PLACE_KEYS.machines.rows)
      for (const p of r.probes)
        assert.notEqual(machineKey(ev(p)), null, `${r.keys}: ${p}`);
  });

  it("一覧から選ぶ窓：表のキーは、どれも判定が受ける", () => {
    for (const r of PLACE_KEYS.picker.rows)
      for (const p of r.probes)
        assert.notEqual(pickerKey(ev(p)), null, `${r.keys}: ${p}`);
  });

  it("ブックマークの一覧・クリップボードの履歴：表のキーは、絞り込みが空のとき、どれも判定が受ける", () => {
    for (const r of PLACE_KEYS.bookmarks.rows)
      for (const p of r.probes)
        assert.notEqual(bookmarkKey(ev(p), true), null, `${r.keys}: ${p}`);
    for (const r of PLACE_KEYS.history.rows)
      for (const p of r.probes)
        assert.notEqual(historyKey(ev(p), true), null, `${r.keys}: ${p}`);
  });

  it("DB のタブ（#347）：表のキーは、どれも判定が受ける（Cmd+Enter / Ctrl+Enter は keys.test.ts）", () => {
    for (const r of PLACE_KEYS.db.rows)
      for (const p of r.probes)
        for (const mac of [true, false])
          assert.notEqual(dbEditorKey(ev(p), mac), null, `${r.keys}: ${p}`);
    assert.equal(dbEditorKey(ev("Enter", { metaKey: true }), true), "run");
    assert.equal(dbEditorKey(ev("Enter", { ctrlKey: true }), false), "run");
  });

  it("DB のタブの左の木（#348）：表のキーは、どれも判定が受ける", () => {
    for (const r of PLACE_KEYS.dbTree.rows)
      for (const p of r.probes)
        assert.notEqual(dbTreeKey(ev(p)), null, `${r.keys}: ${p}`);
  });

  it("DB のタブの履歴の窓（#349）：表のキーは、絞り込みが空のとき、どれも判定が受ける", () => {
    for (const r of PLACE_KEYS.dbHistory.rows)
      for (const p of r.probes)
        assert.notEqual(dbHistoryKey(ev(p), true), null, `${r.keys}: ${p}`);
  });

  it("窓の表には、`?`（キーの一覧）と Esc の行がある", () => {
    for (const [place, t] of Object.entries(PLACE_KEYS))
      if (isWindowPlace(place as Place)) {
        assert.ok(
          t.rows.some((r) => r.keys === "?"),
          `${place}: ?`,
        );
        assert.ok(
          t.rows.some((r) => r.keys.includes("Esc")),
          `${place}: Esc`,
        );
      }
  });

  it("`?` は、ファイルツリー・変更一覧・動画・画像のどれでも一覧を出す", () => {
    const f = ev("?", { shiftKey: true });
    assert.deepEqual(treeKey({ dir: false, expanded: false }, f), {
      kind: "help",
    });
    assert.deepEqual(changesKey({ kind: "file", expanded: false }, f), {
      kind: "help",
    });
    assert.deepEqual(videoKey(f), { kind: "help" });
    assert.deepEqual(imageKey(f), { kind: "help" });
  });
});

describe("ファイルツリーの新しいキー", () => {
  const file = { dir: false, expanded: false };
  const dir = { dir: true, expanded: true };

  it("c は名前をコピー（ファイルでもフォルダでも）", () => {
    for (const row of [file, dir])
      assert.deepEqual(treeKey(row, ev("c")), {
        kind: "menu",
        action: "copy-name",
      });
  });

  it("m は「ここへ移動」。フォルダの行だけ", () => {
    assert.deepEqual(treeKey(dir, ev("m")), { kind: "menu", action: "cd" });
    assert.equal(treeKey(file, ev("m")), null);
  });

  it(". と Menu キーは、右クリックのメニューを開く", () => {
    for (const key of [".", "ContextMenu"])
      for (const row of [file, dir])
        assert.deepEqual(treeKey(row, ev(key)), { kind: "contextmenu" });
  });

  it("修飾キーつき・変換中は受けない", () => {
    for (const key of ["c", "m", "."]) {
      assert.equal(treeKey(dir, ev(key, { ctrlKey: true })), null);
      assert.equal(treeKey(dir, ev(key, { metaKey: true })), null);
      assert.equal(treeKey(dir, ev(key, { isComposing: true })), null);
    }
    assert.equal(treeKey(dir, ev("?", { ctrlKey: true })), null);
  });

  it("5000 件より先の行では何もしない", () => {
    assert.equal(treeKey({ ...dir, truncated: true }, ev("?")), null);
  });
});

describe("listStep（ダイアログの一覧の Ctrl+J / Ctrl+K）", () => {
  it("Ctrl+J は次（1）、Ctrl+K は前（-1）", () => {
    assert.equal(listStep(ev("j", { ctrlKey: true })), 1);
    assert.equal(listStep(ev("k", { ctrlKey: true })), -1);
  });

  it("Caps Lock などで大文字でも同じ", () => {
    assert.equal(listStep(ev("J", { ctrlKey: true })), 1);
    assert.equal(listStep(ev("K", { ctrlKey: true })), -1);
  });

  it("Ctrl なしの j k（入力欄に打つ字）は受けない", () => {
    assert.equal(listStep(ev("j")), 0);
    assert.equal(listStep(ev("k")), 0);
  });

  it("Shift・Alt・Cmd を重ねたもの（Ctrl+Shift+K はリーダー）、変換中は受けない", () => {
    for (const extra of [
      { shiftKey: true },
      { altKey: true },
      { metaKey: true },
      { isComposing: true },
    ]) {
      assert.equal(listStep(ev("k", { ctrlKey: true, ...extra })), 0);
      assert.equal(listStep(ev("j", { ctrlKey: true, ...extra })), 0);
    }
  });

  it("ほかの Ctrl+字は受けない", () => {
    assert.equal(listStep(ev("n", { ctrlKey: true })), 0);
    assert.equal(listStep(ev("p", { ctrlKey: true })), 0);
  });
});

describe("isWindowPlace（`?` の一覧に、その窓のキーだけを出す場所）", () => {
  it("真ん中に出す窓は窓の場所、ペインの場所（リーダーが効く）は違う", () => {
    for (const p of [
      "machines",
      "bookmarks",
      "picker",
      "switcher",
      "switcherTabs",
      "history",
      "dbHistory",
    ] as const)
      assert.equal(isWindowPlace(p), true, p);
    for (const p of ["tree", "changes", "video", "image", "list"] as const)
      assert.equal(isWindowPlace(p), false, p);
  });
});

describe("basicHints（窓の下の段の基本操作）", () => {
  const keys = (o: Parameters<typeof basicHints>[0]) =>
    basicHints(o).map((h) => h.keys.join(" "));

  it("選ぶ → 移る → 決める → `?` → やめる・閉じる の順に並べる", () => {
    assert.deepEqual(
      keys({
        move: [{ keys: ["l"], label: "タブへ" }],
        decide: "移る",
        end: "close",
      }),
      ["j k", "l", "Enter", "?", "Esc"],
    );
  });

  it("決めるものが無い窓は Enter を出さず、`?` が効かない間は `?` を出さない", () => {
    assert.deepEqual(keys({ end: "close" }), ["j k", "?", "Esc"]);
    assert.deepEqual(keys({ decide: "開く", help: false, end: "close" }), [
      "j k",
      "Enter",
      "Esc",
    ]);
  });

  it("入力欄に字を打つ窓は、選ぶキーに ↓ ↑ を渡す", () => {
    assert.deepEqual(keys({ select: ["↓", "↑"], end: "close" })[0], "↓ ↑");
  });

  it("同じ役割には同じ字を使う（Esc は、やめるか閉じるか）", () => {
    setLang("ja");
    const label = (o: Parameters<typeof basicHints>[0], key: string) =>
      basicHints(o).find((h) => h.keys[0] === key)?.label;
    assert.equal(label({ end: "cancel" }, "j"), "選ぶ");
    assert.equal(label({ end: "cancel" }, "?"), "キーの一覧");
    assert.equal(label({ end: "cancel" }, "Esc"), "やめる");
    assert.equal(label({ end: "close" }, "Esc"), "閉じる");
    setLang("en");
  });
});

describe("isHelpKey", () => {
  it("? を受ける。Ctrl・Alt・Cmd つき、変換中は受けない", () => {
    assert.equal(isHelpKey(ev("?", { shiftKey: true })), true);
    assert.equal(isHelpKey(ev("?", { ctrlKey: true })), false);
    assert.equal(isHelpKey(ev("?", { isComposing: true })), false);
    assert.equal(isHelpKey(ev("/")), false);
  });
});

describe("placeOf", () => {
  const el = (place?: string) => ({
    closest: (s: string) =>
      s === "[data-place]" && place !== undefined
        ? { dataset: { place } }
        : null,
  });

  it("フォーカスがある要素の場所を返す", () => {
    for (const p of [
      "tree",
      "changes",
      "video",
      "image",
      "machines",
      "db",
      "dbTree",
    ] as const)
      assert.equal(placeOf(el(p)), p);
  });

  it("場所が無い・知らない場所・要素が無いときは undefined", () => {
    assert.equal(placeOf(el()), undefined);
    assert.equal(placeOf(el("other")), undefined);
    assert.equal(placeOf(el("list")), undefined);
    assert.equal(placeOf(null), undefined);
  });
});
