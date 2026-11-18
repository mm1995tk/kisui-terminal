import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clampView,
  dragBy,
  HOME,
  imageKey,
  MAX_SCALE,
  MIN_SCALE,
  KEY_STEP,
  panBy,
  transformOf,
  wheelFactor,
  zoomBy,
} from "./imageView.ts";

const key = (key: string, extra: object = {}) => ({
  key,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  ...extra,
});

describe("imageKey", () => {
  it("+ = で拡大、- で縮小、0 で元に戻す", () => {
    assert.deepEqual(imageKey(key("+", { shiftKey: true })), {
      kind: "zoom",
      dir: "in",
    });
    assert.deepEqual(imageKey(key("=")), { kind: "zoom", dir: "in" });
    assert.deepEqual(imageKey(key("-")), { kind: "zoom", dir: "out" });
    assert.deepEqual(imageKey(key("0")), { kind: "reset" });
  });

  it("矢印と h j k l で動かす", () => {
    assert.deepEqual(imageKey(key("h")), { kind: "pan", dir: "left" });
    assert.deepEqual(imageKey(key("j")), { kind: "pan", dir: "down" });
    assert.deepEqual(imageKey(key("k")), { kind: "pan", dir: "up" });
    assert.deepEqual(imageKey(key("l")), { kind: "pan", dir: "right" });
    assert.deepEqual(imageKey(key("ArrowLeft")), { kind: "pan", dir: "left" });
    assert.deepEqual(imageKey(key("ArrowDown")), { kind: "pan", dir: "down" });
  });

  it("Esc で戻る、? で一覧", () => {
    assert.deepEqual(imageKey(key("Escape")), { kind: "leave" });
    assert.deepEqual(imageKey(key("?", { shiftKey: true })), { kind: "help" });
  });

  it("全体の倍率のキー（Cmd+=・Ctrl+=・Cmd+0）や修飾キー付きは受けない", () => {
    for (const mod of ["ctrlKey", "metaKey", "altKey"]) {
      assert.equal(imageKey(key("=", { [mod]: true })), null);
      assert.equal(imageKey(key("-", { [mod]: true })), null);
      assert.equal(imageKey(key("0", { [mod]: true })), null);
      assert.equal(imageKey(key("h", { [mod]: true })), null);
    }
  });

  it("Shift+矢印・Shift+0・かな漢字変換中・ほかの字は受けない", () => {
    assert.equal(imageKey(key("ArrowLeft", { shiftKey: true })), null);
    assert.equal(imageKey(key("0", { shiftKey: true })), null);
    assert.equal(imageKey(key("h", { isComposing: true })), null);
    assert.equal(imageKey(key("a")), null);
    assert.equal(imageKey(key("H")), null);
  });
});

const base = { w: 400, h: 300 };
const view = { w: 800, h: 600 };

describe("zoomBy", () => {
  it("段階で拡大して同じだけ縮小すると、元に戻る", () => {
    let v = HOME;
    for (let i = 0; i < 3; i++)
      v = zoomBy(v, KEY_STEP, { x: 0, y: 0 }, base, view);
    for (let i = 0; i < 3; i++)
      v = zoomBy(v, 1 / KEY_STEP, { x: 0, y: 0 }, base, view);
    assert.deepEqual(v, HOME);
  });

  it("上限と下限で止まる", () => {
    const big = zoomBy(HOME, 1000, { x: 0, y: 0 }, base, view);
    assert.equal(big.scale, MAX_SCALE);
    const small = zoomBy(HOME, 0.0001, { x: 0, y: 0 }, base, view);
    assert.equal(small.scale, MIN_SCALE);
  });

  it("マウスの下の点は動かない", () => {
    const at = { x: 100, y: 50 };
    const v = zoomBy(HOME, 4, at, { w: 800, h: 600 }, { w: 800, h: 600 });
    // 画像の中心からの距離 q が、倍率で s 倍になる位置にあった点が、同じ場所に残る
    assert.equal(v.scale, 4);
    assert.equal(at.x - v.x, 4 * (at.x - 0));
    assert.equal(at.y - v.y, 4 * (at.y - 0));
  });
});

describe("clampView / panBy / dragBy", () => {
  it("収まっているうちは中央のまま（動かせない）", () => {
    assert.deepEqual(panBy(HOME, "right", base, view), HOME);
    assert.deepEqual(dragBy(HOME, 50, 50, base, view), HOME);
  });

  it("拡大するとはみ出した分だけ動かせる", () => {
    const z = { scale: 4, x: 0, y: 0 }; // 1600x1200 の画像を 800x600 で見る
    const r = panBy(z, "left", base, view);
    assert.equal(r.x, 80); // 見える場所が左へ（画像は右へ）
    const far = dragBy(z, 5000, -5000, base, view);
    assert.deepEqual(far, { scale: 4, x: 400, y: -300 });
    assert.deepEqual(clampView({ scale: 4, x: -9999, y: 9999 }, base, view), {
      scale: 4,
      x: -400,
      y: 300,
    });
  });

  it("縮小して収まると、位置は中央に戻る", () => {
    const v = zoomBy(
      { scale: 4, x: 300, y: 200 },
      1 / 8,
      { x: 0, y: 0 },
      base,
      view,
    );
    assert.equal(v.scale, 0.5);
    assert.equal(v.x, 0);
    assert.equal(v.y, 0);
  });
});

describe("wheelFactor / transformOf", () => {
  it("上へ回すと拡大、下へ回すと縮小。大きな値は頭打ち", () => {
    assert.ok(wheelFactor(-10) > 1);
    assert.ok(wheelFactor(10) < 1);
    assert.equal(wheelFactor(-100000), wheelFactor(-200));
    assert.ok(wheelFactor(-1, 1) > wheelFactor(-1, 0));
  });

  it("transform の文字列", () => {
    assert.equal(
      transformOf({ scale: 2, x: 3, y: -4 }),
      "translate(3px, -4px) scale(2)",
    );
  });
});
