import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  acrossBorder,
  applyMove,
  clampBorder,
  loadSizes,
  litBorders,
  resizeAction,
  resizeKeyName,
  saveSizes,
  sizeOf,
  splitPct,
  withoutSize,
  withSize,
} from "./panes.ts";

function memory(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

const key = (k: string, o: Record<string, unknown> = {}) => ({
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...o,
});

describe("覚えておく大きさ", () => {
  it("保存したものを読み戻す。壊れた値と範囲外は捨てる", () => {
    const s = memory();
    saveSizes(s, { sidebar: 280, term: 200, diff: 30, preview: 60 });
    assert.deepEqual(loadSizes(s), {
      sidebar: 280,
      term: 200,
      diff: 30,
      preview: 60,
    });
    assert.deepEqual(
      loadSizes(memory({ "shijimi.paneSizes": "not json" })),
      {},
    );
    assert.deepEqual(
      loadSizes(
        memory({
          "shijimi.paneSizes": JSON.stringify({
            sidebar: 10,
            term: "x",
            diff: 50,
          }),
        }),
      ),
      { diff: 50 },
    );
  });

  it("保存できなくても例外にしない", () => {
    const s = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    assert.deepEqual(loadSizes(s), {});
    assert.doesNotThrow(() => saveSizes(s, {}));
  });

  it("範囲に収め、元の大きさに戻せる", () => {
    assert.equal(clampBorder("sidebar", 10), 200);
    assert.equal(clampBorder("sidebar", 9999), 640);
    assert.equal(clampBorder("diff", 0), 1);
    assert.equal(clampBorder("preview", 99), 90);
    const s = withSize({}, "term", 250.4);
    assert.equal(sizeOf(s, "term"), 250);
    assert.equal(sizeOf({}, "sidebar"), 300);
    assert.deepEqual(withoutSize(s, "term"), {});
    assert.deepEqual(withoutSize(s), {});
  });
});

describe("リサイズモードのキー", () => {
  const file = { inTerm: false, split: null } as const;
  const diff = { inTerm: false, split: "diff" } as const;

  it("←→ はフォーカスのあるブロックの縦の境界", () => {
    assert.equal(acrossBorder(file), "sidebar");
    assert.equal(acrossBorder(diff), "diff");
    assert.equal(acrossBorder({ inTerm: true, split: "diff" }), "sidebar");
    assert.deepEqual(resizeAction("right", diff), {
      kind: "move",
      border: "diff",
      step: 2,
    });
    assert.deepEqual(resizeAction("h", file), {
      kind: "move",
      border: "sidebar",
      step: -20,
    });
  });

  it("↑↓ はファイルの欄とターミナルの境界、< > はプレビューの境界", () => {
    assert.deepEqual(resizeAction("k", diff), {
      kind: "move",
      border: "term",
      step: -20,
    });
    assert.deepEqual(resizeAction("down", file), {
      kind: "move",
      border: "term",
      step: 20,
    });
    assert.deepEqual(resizeAction(">", { inTerm: false, split: "preview" }), {
      kind: "move",
      border: "preview",
      step: 5,
    });
    assert.deepEqual(resizeAction(".", file), { kind: "none" });
  });

  it("= は全部戻し、Esc Enter q Alt+R は出る", () => {
    assert.deepEqual(resizeAction("=", file), { kind: "reset" });
    for (const k of ["esc", "enter", "q", "alt+r"])
      assert.deepEqual(resizeAction(k, file), { kind: "exit" });
    assert.deepEqual(resizeAction("x", file), { kind: "none" });
  });

  it("光らせるのは ←→ の境界と ↑↓ の境界", () => {
    assert.deepEqual(litBorders(diff), ["diff", "term"]);
    assert.deepEqual(litBorders({ inTerm: true, split: "diff" }), [
      "sidebar",
      "term",
    ]);
  });

  it("KeyboardEvent をキーの名前にする", () => {
    assert.equal(resizeKeyName(key("ArrowLeft")), "left");
    assert.equal(resizeKeyName(key("Escape")), "esc");
    assert.equal(resizeKeyName(key("<", { shiftKey: true })), "<");
    assert.equal(
      resizeKeyName(key("r", { altKey: true, code: "KeyR" })),
      "alt+r",
    );
    assert.equal(
      resizeKeyName(key("®", { altKey: true, code: "KeyR" })),
      "alt+r",
    );
    assert.equal(resizeKeyName(key("c", { ctrlKey: true })), null);
    assert.equal(resizeKeyName(key("Shift")), null);
  });
});

describe("動かす", () => {
  it("端を超えない。ターミナルは上へ動かすと高さが増える", () => {
    assert.equal(sizeOf(applyMove({}, "sidebar", 20), "sidebar"), 320);
    assert.equal(
      sizeOf(applyMove({ sidebar: 205 }, "sidebar", -20), "sidebar"),
      200,
    );
    assert.equal(sizeOf(applyMove({}, "term", -20), "term"), 320);
    assert.equal(sizeOf(applyMove({}, "diff", 2), "diff"), 52); // 半分から
    assert.equal(
      sizeOf(applyMove({ preview: 88 }, "preview", 5), "preview"),
      90,
    );
  });

  it("ポインタの位置を % にする", () => {
    // 左右の幅が 81 マス（1 マス 10px）：境界を除いた 80 マスの半分
    assert.equal(splitPct("diff", 400, 810, 10), 50);
    assert.equal(splitPct("diff", 0, 810, 10), 1);
    assert.equal(splitPct("preview", 790, 810, 10), 90);
    assert.equal(splitPct("preview", 100, 10, 10), 0);
  });
});

describe("今の画面で効く上限", () => {
  it("上限を超えて溜めず、超えた値からも動き出せる", () => {
    assert.equal(
      sizeOf(applyMove({ term: 300 }, "term", -20, 350), "term"),
      320,
    );
    assert.equal(
      sizeOf(applyMove({ term: 340 }, "term", -20, 350), "term"),
      350,
    );
    // 上限を超えて保存されていても、上限から動かす
    assert.equal(
      sizeOf(applyMove({ term: 900 }, "term", 20, 350), "term"),
      330,
    );
    assert.equal(clampBorder("sidebar", 900, 500), 500);
  });
});
