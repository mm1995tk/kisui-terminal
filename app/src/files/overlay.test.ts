import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Files, Overlay, Pane } from "../rpc/protocol.ts";
import { statusLeft, statusRight } from "./bars.ts";
import {
  anchorCell,
  completionWidth,
  composeRows,
  confirmOf,
  labelParts,
  menuLayout,
  overlayBox,
  paletteLabel,
  paneLeft,
  placeAbove,
  placeBelow,
  scrollIndicator,
  searchColumns,
  searchGutterCells,
  searchMarker,
} from "./overlay.ts";

function pane(over: Partial<Pane>): Pane {
  return {
    id: "a.go",
    title: { text: "a.go" },
    kind: "text",
    viewport: { top: 10, rows: 20, cols: 80, left: 0, total: 120 },
    curLine: 10,
    lines: [],
    ...over,
  };
}

const area = { cols: 100, rows: 20 };

describe("anchorCell", () => {
  it("見えている行の文字の幅で桁を数え、行番号の欄を足す", () => {
    // 全行数 120 → 行番号の欄は 3 + 4 = 7 桁。「日本」は 4 桁、タブは 4 桁の位置まで
    const files: Files = {
      panes: [
        pane({
          lines: [
            { no: 10, spans: [{ text: "x" }] },
            { no: 11, spans: [{ text: "日本\tab" }] },
          ],
        }),
      ],
      active: 0,
    };
    assert.deepEqual(anchorCell(files, "a.go", { line: 11, col: 2 }), {
      x: 11,
      y: 1,
      shown: true,
    });
    assert.deepEqual(anchorCell(files, "a.go", { line: 11, col: 3 }), {
      x: 15,
      y: 1,
      shown: true,
    });
  });

  it("横スクロールを引き、見えていない行はビューポートの先頭からの差で数える", () => {
    const files: Files = {
      panes: [
        pane({ viewport: { top: 10, rows: 20, cols: 80, left: 4, total: 9 } }),
      ],
      active: 0,
    };
    // 行番号の欄は 1 + 4 = 5 桁
    assert.deepEqual(anchorCell(files, "a.go", { line: 15, col: 6 }), {
      x: 7,
      y: 5,
      shown: false,
    });
  });

  it("右のペインは、左のペインの幅と間の 1 桁だけずれる", () => {
    const files: Files = {
      panes: [
        pane({
          id: "l",
          kind: "preview",
          viewport: { top: 0, rows: 5, cols: 30, left: 0, total: 5 },
        }),
        pane({
          id: "r",
          viewport: { top: 0, rows: 5, cols: 30, left: 0, total: 5 },
          lines: [{ no: 0, spans: [] }],
        }),
      ],
      active: 1,
    };
    assert.equal(paneLeft(files, "r"), 31);
    assert.deepEqual(anchorCell(files, "r", { line: 0, col: 0 }), {
      x: 36,
      y: 0,
      shown: true,
    });
    assert.equal(anchorCell(files, "x", { line: 0, col: 0 }), undefined);
    assert.equal(anchorCell(files, "r", undefined), undefined);
  });

  it("1 列の差分では、同じ番号の消した行を飛ばす", () => {
    const files: Files = {
      panes: [
        pane({
          kind: "diff",
          viewport: { top: 0, rows: 5, cols: 30, left: 0, total: 5 },
          lines: [
            { no: 3, spans: [], marks: [{ kind: "deleted" }] },
            { no: 3, spans: [] },
          ],
        }),
      ],
      active: 0,
    };
    assert.equal(anchorCell(files, "a.go", { line: 3, col: 0 })?.y, 1);
  });
});

describe("置き場所", () => {
  it("下に置き、入らなければ上に置く。右にはみ出さない", () => {
    assert.deepEqual(placeBelow({ x: 5, y: 3 }, 10, 4, area), {
      x: 5,
      y: 4,
      w: 10,
      h: 4,
    });
    assert.deepEqual(placeBelow({ x: 95, y: 17 }, 10, 4, area), {
      x: 90,
      y: 13,
      w: 10,
      h: 4,
    });
  });

  it("シグネチャは上に置き、1 行目なら下に置く", () => {
    assert.equal(placeAbove({ x: 0, y: 3 }, 10, 1, area).y, 2);
    assert.equal(placeAbove({ x: 0, y: 0 }, 10, 1, area).y, 1);
  });
});

describe("overlayBox", () => {
  const files: Files = {
    panes: [pane({ lines: [{ no: 10, spans: [{ text: "fmt." }] }] })],
    active: 0,
  };

  it("補完はカーソルの下に、候補の数だけの高さで出す", () => {
    const ov: Overlay = {
      kind: "completion",
      pane: "a.go",
      at: { line: 10, col: 4 },
      active: 0,
      items: [{ label: "Println", kind: "func" }, { label: "Sprintf" }],
    };
    assert.deepEqual(overlayBox(ov, files, area), { x: 11, y: 1, w: 20, h: 2 });
    assert.equal(overlayBox({ ...ov, items: [] }, files, area), undefined);
  });

  it("パレットは上の真ん中に、メニューは右下に出す", () => {
    const pal: Overlay = {
      kind: "palette",
      active: 0,
      items: [{ label: "a" }],
      hint: "なし",
      field: { prefix: ">", text: "", cursor: 0 },
    };
    assert.deepEqual(overlayBox(pal, files, area), {
      x: 20,
      y: 0,
      w: 60,
      h: 3,
    });
    const menu: Overlay = {
      kind: "menu",
      title: " Space",
      active: 0,
      items: [{ label: "開く", detail: "f" }],
    };
    assert.deepEqual(overlayBox(menu, files, area), {
      x: 92,
      y: 18,
      w: 8,
      h: 2,
    });
  });

  it("シグネチャはカーソルが見えていなければ出さない", () => {
    const sig = (line: number, col = 0): Overlay => ({
      kind: "signature",
      pane: "a.go",
      at: { line, col },
      active: 0,
      lines: [{ no: 0, spans: [{ text: "f(a int)" }] }],
    });
    assert.deepEqual(overlayBox(sig(10), files, area), {
      x: 7,
      y: 1,
      w: 10,
      h: 1,
    });
    // 上と下にはみ出した行（ホイールでカーソルの行が外れた）
    assert.equal(overlayBox(sig(9), files, area), undefined);
    assert.equal(overlayBox(sig(40), files, area), undefined);
    // 横にスクロールして外れた桁
    assert.equal(overlayBox(sig(10, 200), files, area), undefined);
  });

  it("確認は箱にしない（状態行に出す）", () => {
    const ov: Overlay = {
      kind: "confirm",
      active: 0,
      title: "捨てますか (y/n)",
      items: [{ label: "y" }, { label: "n" }],
    };
    assert.equal(overlayBox(ov, files, area), undefined);
    const s = {
      mode: "NOR",
      style: "mode.normal",
      cursor: { line: 0, col: 0 },
      msg: "前の",
      position: "1:1",
    };
    assert.deepEqual(statusLeft(s, confirmOf([ov])), [
      { text: "捨てますか (y/n)", style: "error" },
    ]);
    assert.deepEqual(statusRight(s, confirmOf([ov])), []);
    assert.deepEqual(statusRight(s, undefined), [{ text: "1:1" }]);
  });

  it("ホバーは上下の行を足した高さ、行の幅に左右の空きを足した幅", () => {
    const ov: Overlay = {
      kind: "hover",
      pane: "a.go",
      at: { line: 10, col: 0 },
      active: 0,
      view: { top: 0, rows: 3, cols: 30, left: 0, total: 3 },
      lines: [
        { no: 0, spans: [] },
        { no: 1, spans: [] },
        { no: 2, spans: [] },
      ],
    };
    assert.deepEqual(overlayBox(ov, files, area), { x: 7, y: 1, w: 32, h: 5 });
  });

  it("コメントの入力欄は下の真ん中に出す", () => {
    const ov: Overlay = {
      kind: "reviewCard",
      active: 0,
      view: { top: 0, rows: 0, cols: 40, left: 0, total: 0 },
      compose: { text: "", cursor: { line: 0, col: 0 } },
    };
    assert.deepEqual(overlayBox(ov, files, area), {
      x: 29,
      y: 12,
      w: 42,
      h: 8,
    });
  });
});

describe("中身", () => {
  it("補完の幅は 20〜60", () => {
    assert.equal(completionWidth([{ label: "a" }]), 20);
    assert.equal(completionWidth([{ label: "x".repeat(30) }]), 40);
    assert.equal(completionWidth([{ label: "x".repeat(80) }]), 60);
  });

  it("メニューは 6 項目以上で幅があれば 2 列", () => {
    const items = Array.from({ length: 6 }, (_, i) => ({
      label: "ab",
      detail: String(i),
    }));
    assert.deepEqual(menuLayout(items, 100), {
      cols: 2,
      per: 3,
      cellW: 4,
      w: 12,
    });
    assert.equal(menuLayout(items, 50).cols, 1);
  });

  it("検索に合った文字を分ける", () => {
    assert.deepEqual(labelParts({ label: "open", matched: [0, 1] }), [
      { text: "op", hi: true },
      { text: "en", hi: false },
    ]);
  });

  it("パレットの見出し", () => {
    assert.equal(paletteLabel("名前", ":"), " 名前: ");
    assert.equal(paletteLabel("テーマ", ">"), " テーマ > ");
    assert.equal(paletteLabel("", ">"), " > ");
  });

  it("位置の表示", () => {
    const ov: Overlay = {
      kind: "hover",
      active: 0,
      view: { top: 2, rows: 2, cols: 1, left: 0, total: 10 },
      lines: [
        { no: 2, spans: [] },
        { no: 3, spans: [] },
      ],
    };
    assert.equal(scrollIndicator(ov), "↑ 4/10 ↓");
    assert.equal(
      scrollIndicator({
        ...ov,
        view: { top: 0, rows: 2, cols: 1, left: 0, total: 2 },
      }),
      "",
    );
  });

  it("コメントの入力欄はカーソルの行が見えるようにずらす", () => {
    const text = Array.from({ length: 10 }, (_, i) => String(i)).join("\n");
    assert.deepEqual(composeRows(text, 2), {
      first: 0,
      rows: ["0", "1", "2", "3", "4", "5"],
    });
    assert.deepEqual(composeRows(text, 8).first, 3);
  });
});

describe("検索の窓", () => {
  const search: Overlay = {
    kind: "search",
    active: 0,
    search: {
      fields: [],
      field: 0,
      options: [],
      status: "",
      bodyRows: 10,
      scroll: 0,
      cursor: 0,
      total: 0,
    },
  };

  it("欄いっぱい（周りに 1 マス）に広げ、高さは固定の行と一覧の高さ", () => {
    assert.deepEqual(overlayBox(search, undefined, { cols: 100, rows: 30 }), {
      x: 1,
      y: 1,
      w: 98,
      h: 21,
    });
  });

  it("狭いときは幅 30 を下限にし、欄より大きくしない", () => {
    assert.deepEqual(overlayBox(search, undefined, { cols: 20, rows: 8 }), {
      x: 0,
      y: 0,
      w: 20,
      h: 8,
    });
  });

  it("一覧とプレビューの幅は、仕切りの 1 桁を除いて半分に分ける", () => {
    assert.deepEqual(searchColumns(98), { left: 47, right: 48 });
  });

  it("行番号の桁数は 3 以上、印は外した行が x・選んだ行が >", () => {
    assert.equal(searchGutterCells(5), 3);
    assert.equal(searchGutterCells(12345), 5);
    assert.equal(searchMarker(true, true), "x ");
    assert.equal(searchMarker(false, true), "> ");
    assert.equal(searchMarker(false, false), "  ");
  });
});
