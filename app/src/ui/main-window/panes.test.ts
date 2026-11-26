import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyMove,
  changesMax,
  clampBorder,
  loadSidebarOpen,
  loadSizes,
  resizeAction,
  resizeKeyName,
  saveSidebarOpen,
  saveSizes,
  rightMinWidth,
  sidebarMax,
  sizeOf,
  termMinWidth,
  TREE_RESERVE_HEIGHT,
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
    assert.equal(clampBorder("sidebar", 9999), 9999);
    assert.equal(clampBorder("sidebar", 9999, 700), 700);
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
  it("CHANGES の高さは 44px 以上（上限は窓の高さで決まる）で、決めていなければ 143px", () => {
    assert.equal(sizeOf({}, "changes"), 143);
    assert.equal(clampBorder("changes", 10), 44);
    assert.equal(clampBorder("changes", 9999), 9999);
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
});

describe("タブの段とファイルツリーの境目（#284）", () => {
  it("高さの上限は 10〜90% に収め、決めていなければ 40%。設定の値があればそれが元の大きさ", () => {
    assert.equal(sizeOf({}, "tabs"), 40);
    assert.equal(sizeOf({}, "tabs", 25), 25);
    assert.equal(sizeOf({ tabs: 60 }, "tabs", 25), 60);
    assert.equal(clampBorder("tabs", 3), 10);
    assert.equal(clampBorder("tabs", 99), 90);
    assert.equal(clampBorder("tabs", 33.4), 33);
  });

  it("1 回のキーで 5% 動き、端を超えない。戻すと元の大きさ（設定の値）", () => {
    assert.equal(sizeOf(applyMove({}, "tabs", 5), "tabs"), 45);
    assert.equal(sizeOf(applyMove({ tabs: 12 }, "tabs", -5), "tabs"), 10);
    assert.equal(sizeOf(applyMove({ tabs: 88 }, "tabs", 5), "tabs"), 90);
    const s = withSize({ changes: 200 }, "tabs", 70);
    assert.deepEqual(withoutSize(s, "tabs"), { changes: 200 });
    assert.equal(sizeOf(withoutSize(s, "tabs"), "tabs", 25), 25);
  });

  it("覚えて読み戻す。範囲外の値は捨てる", () => {
    const s = memory();
    saveSizes(s, { tabs: 55 });
    assert.deepEqual(loadSizes(s), { tabs: 55 });
    assert.deepEqual(
      loadSizes(memory({ "shijimi.paneSizes": '{"tabs":95}' })),
      {},
    );
  });
});

describe("窓の大きさで決まる上限（#501）", () => {
  it("サイドバーの幅は、右のターミナルが 20 列残るところまで広げられる（640px で止まらない）", () => {
    // 字の幅 7px：20 列は 140px に、余白とスクロールバーの 12px を足した 152px
    assert.equal(termMinWidth(7), 152);
    assert.equal(sidebarMax(2000, 7), 2000 - 152);
    assert.ok(sidebarMax(2000, 7) > 640);
    // 字が広ければ、残す幅も広がる
    assert.equal(sidebarMax(2000, 8), 2000 - termMinWidth(8));
    // 窓の幅の半分の制限は無い
    assert.ok(sidebarMax(1000, 7) > 500);
  });

  it("プロキシのパネルを開いている間は、パネルを引いたあとのターミナルが 20 列残る", () => {
    // 20 列 152px。パネルは右の欄の 45%（いちばん狭くて 280px）
    assert.equal(rightMinWidth(7, false), 152);
    assert.equal(rightMinWidth(7, true), 432);
    assert.equal(sidebarMax(2000, 7, true), 2000 - 432);
    // 広い欄では 45% のほうが効き、残る 55% が 20 列以上になる
    assert.ok(rightMinWidth(30, true) * 0.55 >= termMinWidth(30));
    assert.equal(sidebarMax(300, 7, true), 200);
  });

  it("右の欄を左右に分けているときは、ペイン 1 つずつに 20 列残す", () => {
    // 1 列は 152px。2 列は 152 × 2 に、ペインの間の隙間（6px）を足す
    assert.equal(termMinWidth(7, 1), 152);
    assert.equal(termMinWidth(7, 2), 152 * 2 + 6);
    assert.equal(termMinWidth(7, 3), 152 * 3 + 12);
    assert.equal(sidebarMax(2000, 7, false, 2), 2000 - (152 * 2 + 6));
    assert.ok(sidebarMax(2000, 7, false, 3) < sidebarMax(2000, 7, false, 2));
    // プロキシのパネルの分は、今の決まりのまま足す（パネルは 280px 以上で、残るのは右の欄の 55% 以下）
    assert.equal(rightMinWidth(7, true, 2), 152 * 2 + 6 + 280);
    assert.equal(rightMinWidth(7, true, 4), Math.ceil((152 * 4 + 18) / 0.55));
    assert.equal(rightMinWidth(7, true, 1), 432);
  });

  it("窓が狭くても、下限（200px）より狭くならない", () => {
    assert.equal(sidebarMax(300, 7), 200);
    assert.equal(sidebarMax(0, 7), 200);
  });

  it("CHANGES の高さは、ファイルツリーなどに最低の高さが残るところまで（窓の高さの半分で止まらない）", () => {
    assert.equal(changesMax(1000), 1000 - TREE_RESERVE_HEIGHT);
    assert.ok(changesMax(1000) > 500);
    assert.equal(changesMax(100), 44);
  });

  it("窓を小さくしたとき、覚えた幅・高さはその窓の上限に収まる", () => {
    const wide = withSize({}, "sidebar", 1200, sidebarMax(2000, 7));
    assert.equal(sizeOf(wide, "sidebar"), 1200);
    // 窓が狭くなった後に動かすと、その窓の上限から動く
    const max = sidebarMax(800, 7);
    assert.equal(sizeOf(applyMove(wide, "sidebar", 20, max), "sidebar"), max);
    const tall = withSize({}, "changes", 700, changesMax(1000));
    assert.equal(
      sizeOf(applyMove(tall, "changes", 22, changesMax(600)), "changes"),
      changesMax(600),
    );
  });

  it("覚えておいた大きな値は捨てない", () => {
    const s = memory({
      "shijimi.paneSizes": JSON.stringify({ sidebar: 1200, changes: 700 }),
    });
    assert.deepEqual(loadSizes(s), { sidebar: 1200, changes: 700 });
  });
});
