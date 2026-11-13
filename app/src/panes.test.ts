import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyMove,
  CHANGES_BORDER,
  clampBorder,
  loadSidebarOpen,
  loadSizes,
  resizeAction,
  resizeKeyName,
  saveSidebarOpen,
  saveSizes,
  sizeOf,
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
  it("保存したものを読み戻す。壊れた値と範囲外と前の版の境界は捨てる", () => {
    const s = memory();
    saveSizes(s, { sidebar: 280 });
    assert.deepEqual(loadSizes(s), { sidebar: 280 });
    assert.deepEqual(
      loadSizes(memory({ "shijimi.paneSizes": "not json" })),
      {},
    );
    assert.deepEqual(
      loadSizes(
        memory({
          "shijimi.paneSizes": JSON.stringify({ sidebar: 10, term: 200 }),
        }),
      ),
      {},
    );
    assert.deepEqual(
      loadSizes(
        memory({
          "shijimi.paneSizes": JSON.stringify({
            sidebar: 400,
            term: 200,
            diff: 30,
          }),
        }),
      ),
      { sidebar: 400 },
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
    const s = withSize({}, "sidebar", 250.4);
    assert.equal(sizeOf(s, "sidebar"), 250);
    assert.equal(sizeOf({}, "sidebar"), 300);
    assert.deepEqual(withoutSize(s, "sidebar"), {});
    assert.deepEqual(withoutSize(s), {});
  });
});

describe("リサイズモードのキー", () => {
  it("←→↑↓（h l k j）は選んでいる境界を動かす", () => {
    assert.deepEqual(resizeAction("right"), {
      kind: "nudge",
      axis: "x",
      sign: 1,
    });
    assert.deepEqual(resizeAction("h"), { kind: "nudge", axis: "x", sign: -1 });
    assert.deepEqual(resizeAction("up"), {
      kind: "nudge",
      axis: "y",
      sign: -1,
    });
    assert.deepEqual(resizeAction("j"), { kind: "nudge", axis: "y", sign: 1 });
    assert.deepEqual(resizeAction(">"), { kind: "none" });
  });

  it("Tab・Shift+Tab は動かす境界を替える", () => {
    assert.deepEqual(resizeAction("tab"), { kind: "select", step: 1 });
    assert.deepEqual(resizeAction("shift+tab"), { kind: "select", step: -1 });
  });

  it("= は選んでいる境界を戻し、Esc Enter q Cmd+R は出る", () => {
    assert.deepEqual(resizeAction("="), { kind: "reset" });
    for (const k of ["esc", "enter", "q", "mod+r"])
      assert.deepEqual(resizeAction(k), { kind: "exit" });
    assert.deepEqual(resizeAction("x"), { kind: "none" });
  });

  it("Tab をキーの名前にする", () => {
    assert.equal(resizeKeyName(key("Tab")), "tab");
    assert.equal(resizeKeyName(key("Tab", { shiftKey: true })), "shift+tab");
    assert.equal(resizeKeyName(key("Tab", { ctrlKey: true })), null);
  });

  it("KeyboardEvent をキーの名前にする", () => {
    assert.equal(resizeKeyName(key("ArrowLeft")), "left");
    assert.equal(resizeKeyName(key("Escape")), "esc");
    assert.equal(resizeKeyName(key("<", { shiftKey: true })), "<");
    // Mac は Cmd+R、Linux は Ctrl+Shift+R で入る。Alt+R は端末に渡すので名前にしない
    assert.equal(
      resizeKeyName(key("r", { metaKey: true, code: "KeyR" }), true),
      "mod+r",
    );
    assert.equal(
      resizeKeyName(key("R", { ctrlKey: true, shiftKey: true, code: "KeyR" })),
      "mod+r",
    );
    assert.equal(
      resizeKeyName(key("r", { metaKey: true, code: "KeyR" })),
      null,
    );
    assert.equal(
      resizeKeyName(key("r", { ctrlKey: true, shiftKey: true }), true),
      null,
    );
    assert.equal(resizeKeyName(key("r", { altKey: true, code: "KeyR" })), null);
    assert.equal(
      resizeKeyName(key("®", { altKey: true, code: "KeyR" }), true),
      null,
    );
    assert.equal(resizeKeyName(key("c", { ctrlKey: true })), null);
    assert.equal(resizeKeyName(key("Shift")), null);
  });
});

describe("動かす", () => {
  it("端を超えない", () => {
    assert.equal(sizeOf(applyMove({}, "sidebar", 20), "sidebar"), 320);
    assert.equal(
      sizeOf(applyMove({ sidebar: 205 }, "sidebar", -20), "sidebar"),
      200,
    );
  });
});

describe("今の画面で効く上限", () => {
  it("上限を超えて溜めず、超えた値からも動き出せる", () => {
    assert.equal(
      sizeOf(applyMove({ sidebar: 300 }, "sidebar", 20, 350), "sidebar"),
      320,
    );
    assert.equal(
      sizeOf(applyMove({ sidebar: 340 }, "sidebar", 20, 350), "sidebar"),
      350,
    );
    // 上限を超えて保存されていても、上限から動かす
    assert.equal(
      sizeOf(applyMove({ sidebar: 600 }, "sidebar", -20, 350), "sidebar"),
      330,
    );
    assert.equal(clampBorder("sidebar", 900, 500), 500);
  });
});

describe("サイドバーの開け閉め", () => {
  it("覚えていなければ開いている。閉じたことと開いたことを読み戻す", () => {
    const s = memory();
    assert.equal(loadSidebarOpen(s), true);
    saveSidebarOpen(s, false);
    assert.equal(loadSidebarOpen(s), false);
    saveSidebarOpen(s, true);
    assert.equal(loadSidebarOpen(s), true);
    assert.equal(loadSidebarOpen(memory({ "kisui.sidebarOpen": "x" })), true);
    assert.equal(loadSidebarOpen(undefined), true);
  });
});

describe("ファイルツリーと CHANGES の境目（#152）", () => {
  it("CHANGES の高さは 44〜640px に収め、決めていなければ 143px", () => {
    assert.equal(sizeOf({}, "changes"), 143);
    assert.equal(clampBorder("changes", 10), 44);
    assert.equal(clampBorder("changes", 9999), 640);
    assert.equal(clampBorder("changes", 9999, 300), 300);
  });

  it("1 回のキーで 1 行（22px）動き、端を超えない。戻すと元の高さ", () => {
    assert.equal(sizeOf(applyMove({}, "changes", 22), "changes"), 165);
    assert.equal(
      sizeOf(applyMove({ changes: 50 }, "changes", -22), "changes"),
      44,
    );
    const s = withSize({ sidebar: 280 }, "changes", 200);
    assert.deepEqual(withoutSize(s, "changes"), { sidebar: 280 });
  });

  it("覚えて読み戻す。範囲外の値は捨てる", () => {
    const s = memory();
    saveSizes(s, { sidebar: 280, changes: 200 });
    assert.deepEqual(loadSizes(s), { sidebar: 280, changes: 200 });
    assert.deepEqual(
      loadSizes(memory({ "shijimi.paneSizes": '{"changes":5}' })),
      {},
    );
  });

  it("Tab で回る境界の名前は、ペインどうしの境界のキーと混ざらない", () => {
    assert.equal(CHANGES_BORDER, "@changes");
  });
});
