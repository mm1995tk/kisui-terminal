import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Line, Pane, Screen } from "../rpc/protocol.ts";
import { applyUpdate } from "./screen.ts";

const line = (no: number, text: string): Line => ({
  no,
  spans: [{ text }],
});

function pane(id: string, lines: Line[]): Pane {
  return {
    id,
    title: { text: id },
    kind: "text",
    viewport: { top: 0, rows: 3, cols: 40, left: 0, total: 10 },
    curLine: 0,
    cursors: [{ line: 0, col: 0 }],
    selections: [{ start: { line: 0, col: 0 }, end: { line: 0, col: 0 } }],
    lines,
  };
}

function screen(...panes: Pane[]): Screen {
  return {
    rev: 5,
    ackSeq: 1,
    focus: "files",
    status: { mode: "NOR", style: "mode.normal", cursor: { line: 0, col: 0 } },
    files: { panes, active: 0 },
  };
}

describe("applyUpdate", () => {
  it("画面が無ければ、全部を持つ更新から作る", () => {
    const p = pane("a.go", [line(0, "x")]);
    const { lines, ...rest } = p;
    const sc = applyUpdate(null, {
      rev: 1,
      baseRev: 0,
      ackSeq: 0,
      focus: "files",
      files: {
        panes: [{ ...rest, lines: { rows: { "0": lines![0]! }, count: 1 } }],
        active: 0,
      },
    });
    assert.equal(sc.rev, 1);
    assert.equal(sc.focus, "files");
    assert.deepEqual(sc.files, { panes: [p], active: 0 });
  });

  it("変わった行だけを差し替え、ほかの行とペインは前のオブジェクトを使う", () => {
    const l0 = line(0, "a");
    const l1 = line(1, "b");
    const l2 = line(2, "c");
    const other = pane("b.go", [line(0, "z")]);
    const prev = screen(pane("a.go", [l0, l1, l2]), other);
    const next = applyUpdate(prev, {
      rev: 6,
      baseRev: 5,
      ackSeq: 2,
      files: {
        panes: [
          {
            id: "a.go",
            cursors: [{ line: 1, col: 1 }],
            lines: { rows: { "1": line(1, "bb") }, count: 3 },
          },
          { id: "b.go" },
        ],
      },
    });
    assert.equal(next.rev, 6);
    assert.equal(next.ackSeq, 2);
    assert.equal(next.status, prev.status, "付いていない領域はそのまま");
    const a = next.files!.panes[0]!;
    assert.deepEqual(a.cursors, [{ line: 1, col: 1 }]);
    assert.equal(a.lines![0], l0);
    assert.deepEqual(a.lines![1], line(1, "bb"));
    assert.equal(a.lines![2], l2);
    assert.equal(a.title, prev.files!.panes[0]!.title);
    assert.equal(next.files!.panes[1], other);
    assert.equal(next.files!.active, 0);
    // 前の画面は変えない
    assert.deepEqual(prev.files!.panes[0]!.lines![1], l1);
    assert.deepEqual(prev.files!.panes[0]!.cursors, [{ line: 0, col: 0 }]);
  });

  it("見えている行数が減れば後ろを落とし、増えれば来た行を足す", () => {
    const prev = screen(pane("a.go", [line(0, "a"), line(1, "b")]));
    const fewer = applyUpdate(prev, {
      rev: 6,
      baseRev: 5,
      ackSeq: 1,
      files: { panes: [{ id: "a.go", lines: { rows: {}, count: 1 } }] },
    });
    assert.equal(fewer.files!.panes[0]!.lines!.length, 1);
    const more = applyUpdate(fewer, {
      rev: 7,
      baseRev: 6,
      ackSeq: 1,
      files: {
        panes: [
          {
            id: "a.go",
            lines: { rows: { "1": line(1, "b"), "2": line(2, "c") }, count: 3 },
          },
        ],
      },
    });
    assert.deepEqual(
      more.files!.panes[0]!.lines!.map((l) => l.no),
      [0, 1, 2],
    );
  });

  it("並びから消えたペインは落ち、新しいペインは足す", () => {
    const prev = screen(pane("a.go", []), pane("b.go", []));
    const c = pane("c.go", []);
    const { lines: _, ...rest } = c;
    const next = applyUpdate(prev, {
      rev: 6,
      baseRev: 5,
      ackSeq: 1,
      files: {
        panes: [{ id: "b.go" }, { ...rest, lines: { rows: {}, count: 0 } }],
        active: 1,
      },
    });
    assert.deepEqual(
      next.files!.panes.map((p) => p.id),
      ["b.go", "c.go"],
    );
    assert.equal(next.files!.panes[0], prev.files!.panes[1]);
    assert.deepEqual(next.files!.panes[1], c);
    assert.equal(next.files!.active, 1);
  });

  it("cmdline の null は閉じたこと", () => {
    const prev: Screen = {
      ...screen(),
      cmdline: { prefix: ":", text: "w", cursor: 1 },
    };
    const next = applyUpdate(prev, {
      rev: 6,
      baseRev: 5,
      ackSeq: 1,
      cmdline: null,
    });
    assert.equal(next.cmdline, null);
    assert.equal(next.files, prev.files);
  });
});
