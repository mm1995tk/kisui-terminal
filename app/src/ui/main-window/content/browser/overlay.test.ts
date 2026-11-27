import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  floatsOver,
  mayFocusPage,
  OVERLAY_SELECTORS,
  MIN_HEIGHT,
  OVERLAY_GAP,
  pageBounds,
  placeIn,
  samePlace,
  toLogical,
} from "./overlay.ts";

const area = { x: 300, y: 0, w: 900, h: 800 };

describe("内蔵ブラウザのページを置く場所", () => {
  it("何も重ならなければ、グリッドの場所すべて", () => {
    assert.deepEqual(pageBounds(area, [], false), area);
    // 場所に重ならないもの（サイドバーの中のメニュー）は避けない
    assert.deepEqual(
      pageBounds(area, [{ x: 10, y: 600, w: 200, h: 100 }], false),
      area,
    );
  });

  it("上の端の URL バーの分だけ、上の端を下げる（#232）", () => {
    assert.deepEqual(pageBounds(area, [], false, 36), {
      x: 300,
      y: 36,
      w: 900,
      h: 764,
    });
    // 下の端の Notice とも合わせて縮む
    const notice = { x: 784, y: 600, w: 400, h: 184 };
    assert.deepEqual(pageBounds(area, [notice], false, 36), {
      x: 300,
      y: 36,
      w: 900,
      h: 600 - OVERLAY_GAP - 36,
    });
    // 低くなりすぎれば隠す
    assert.equal(pageBounds({ ...area, h: 200 }, [], false, 100), null);
  });

  it("ダイアログが出ている間は隠す", () => {
    assert.equal(pageBounds(area, [], true), null);
  });

  it("右下の Notice・リーダーの案内が重なれば、下の端をその上まで上げる（横は縮めない）", () => {
    const menu = { x: 824, y: 400, w: 360, h: 384 };
    const notice = { x: 784, y: 600, w: 400, h: 184 };
    assert.deepEqual(pageBounds(area, [notice, menu], false), {
      x: 300,
      y: 0,
      w: 900,
      h: 400 - OVERLAY_GAP,
    });
  });

  it("低くなりすぎるなら隠す", () => {
    const tall = { x: 824, y: MIN_HEIGHT - 1, w: 360, h: 700 };
    assert.equal(pageBounds(area, [tall], false), null);
  });

  it("Window の論理ピクセルにする（表示の大きさを掛けて丸める）", () => {
    assert.deepEqual(toLogical({ x: 10.2, y: 0, w: 100.5, h: 50 }, 1), {
      x: 10,
      y: 0,
      w: 101,
      h: 50,
    });
    assert.deepEqual(toLogical({ x: 100, y: 10, w: 200, h: 100 }, 1.25), {
      x: 125,
      y: 13,
      w: 250,
      h: 125,
    });
  });

  it("殻に渡す場所は、四角と viewport の大きさ（どちらも論理ピクセル）", () => {
    assert.deepEqual(placeIn(area, { w: 1200, h: 800 }, 1), {
      ...area,
      vw: 1200,
      vh: 800,
    });
    assert.deepEqual(
      placeIn({ x: 100, y: 10, w: 200, h: 100 }, { w: 960, h: 640 }, 1.25),
      { x: 125, y: 13, w: 250, h: 125, vw: 1200, vh: 800 },
    );
  });

  it("同じ場所か（viewport の大きさが変わっても、違う場所）", () => {
    const place = placeIn(area, { w: 1200, h: 800 }, 1);
    assert.ok(samePlace(null, null));
    assert.ok(!samePlace(place, null));
    assert.ok(samePlace(place, { ...place }));
    assert.ok(!samePlace(place, { ...place, h: 1 }));
    assert.ok(!samePlace(place, { ...place, vh: 828 }));
  });
});

describe("浮かべるものがページに重なっているか", () => {
  it("ページを出す場所に重なっていれば true", () => {
    assert.equal(floatsOver(area, [{ x: 784, y: 600, w: 400, h: 184 }]), true);
  });

  it("重ならないもの・大きさの無いものは false", () => {
    assert.equal(floatsOver(area, []), false);
    assert.equal(floatsOver(area, [{ x: 10, y: 600, w: 200, h: 100 }]), false);
    assert.equal(floatsOver(area, [{ x: 784, y: 600, w: 0, h: 184 }]), false);
  });
});

describe("ページにキーを向けてよいとき", () => {
  it("リーダーに入っている間は、ページに重なっていなくても向けない（#256）", () => {
    assert.equal(mayFocusPage(false, false), true);
    assert.equal(mayFocusPage(false, true), false);
    assert.equal(mayFocusPage(true, false), false);
    assert.equal(mayFocusPage(true, true), false);
  });
});

describe("重なるものの印（#439）", () => {
  const read = (rel: string) =>
    readFileSync(new URL(rel, import.meta.url), "utf8");

  it("避け方は印（属性）だけで選ぶ。物の種類のクラス名では選ばない", () => {
    for (const s of Object.values(OVERLAY_SELECTORS))
      assert.match(s, /^\[data-overlay(-[a-z]+)?\]$/);
  });

  it("Notice・右クリックのメニュー・リーダーの案内・ページ内検索の欄・トーストは、浮かべるもの（data-overlay）の印を付ける", () => {
    for (const rel of [
      "../../notifications/Notices.tsx",
      "../../sidebar/PopupMenu.tsx",
      "../../sidebar/file-tree/TreeMenu.tsx",
      "../../commands/LeaderMenu.tsx",
      "FindBar.tsx",
      "../../notifications/CopiedToast.tsx",
      "../../notifications/ScaleToast.tsx",
    ])
      assert.match(read(rel), /\sdata-overlay=/, rel);
  });
});
