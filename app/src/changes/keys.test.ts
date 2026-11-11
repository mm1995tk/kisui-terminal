import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  changesKey,
  domKey,
  moveIndex,
  PR_CHANGES_KEYS,
  PR_SPACE_FOLLOWUPS,
  TUI_CHANGES_KEYS,
  type ChangesAction,
} from "./keys.ts";

const file = { kind: "file", expanded: false } as const;
const open = { kind: "dir", expanded: true } as const;
const closed = { kind: "dir", expanded: false } as const;
const k = (key: string, more: object = {}) => ({ key, ...more });

describe("changesKey: TUI の CHANGES と同じキー（Issue #45 の表）", () => {
  it("k/↑・j/↓ で上下、g/Home・G/End で最初と最後", () => {
    for (const [key, to] of [
      ["k", "prev"],
      ["ArrowUp", "prev"],
      ["j", "next"],
      ["ArrowDown", "next"],
      ["g", "first"],
      ["Home", "first"],
      ["G", "last"],
      ["End", "last"],
    ] as const) {
      assert.deepEqual(changesKey(file, k(key)), { kind: "move", to }, key);
    }
  });

  it("h/←：開いたフォルダは閉じる。ほかは親へ動く", () => {
    for (const key of ["h", "ArrowLeft"]) {
      assert.deepEqual(changesKey(open, k(key)), {
        kind: "folder",
        op: "close",
      });
      assert.deepEqual(changesKey(closed, k(key)), {
        kind: "move",
        to: "parent",
      });
      assert.deepEqual(changesKey(file, k(key)), {
        kind: "move",
        to: "parent",
      });
    }
  });

  it("l/→：フォルダは開く、変更は開く", () => {
    for (const key of ["l", "ArrowRight"]) {
      assert.deepEqual(changesKey(closed, k(key)), {
        kind: "folder",
        op: "open",
      });
      assert.deepEqual(changesKey(file, k(key)), { kind: "open" });
    }
  });

  it("Enter・o：フォルダは開け閉め、変更は開く", () => {
    for (const key of ["Enter", "o"]) {
      assert.deepEqual(changesKey(open, k(key)), {
        kind: "folder",
        op: "toggle",
      });
      assert.deepEqual(changesKey(file, k(key)), { kind: "open" });
    }
  });

  it("s・r・R は shj に渡す", () => {
    for (const key of ["s", "r", "R"] as const) {
      assert.deepEqual(changesKey(file, k(key)), { kind: "shj", key });
    }
  });

  it("Space と : も shj に渡す（続きのキーは端末から shj に届く）", () => {
    assert.deepEqual(changesKey(file, k(" ")), { kind: "shj", key: "space" });
    assert.deepEqual(changesKey(file, k(":")), { kind: "shj", key: ":" });
  });

  it("Tab はエクスプローラへ。Shift+Tab は既定の動きに任せる", () => {
    assert.deepEqual(changesKey(file, k("Tab")), { kind: "explorer" });
    assert.equal(changesKey(file, k("Tab", { shiftKey: true })), null);
  });

  it("Esc・q は端末へ戻る", () => {
    assert.deepEqual(changesKey(file, k("Escape")), { kind: "leave" });
    assert.deepEqual(changesKey(file, k("q")), { kind: "leave" });
  });

  it("Ctrl+E はエディタ（端末）へ戻る（#77）。ほかの修飾キーが加わると使わない", () => {
    assert.deepEqual(changesKey(file, k("e", { ctrlKey: true })), {
      kind: "leave",
    });
    assert.equal(changesKey(file, k("e")), null);
    for (const m of ["metaKey", "altKey", "shiftKey", "isComposing"]) {
      assert.equal(
        changesKey(file, k("e", { ctrlKey: true, [m]: true })),
        null,
        m,
      );
    }
  });

  it("Ctrl・Cmd・Alt を押したキーと、かな漢字変換中のキーは使わない", () => {
    for (const m of ["ctrlKey", "metaKey", "altKey", "isComposing"]) {
      assert.equal(changesKey(file, k("j", { [m]: true })), null, m);
      assert.equal(changesKey(file, k("Escape", { [m]: true })), null, m);
    }
    assert.equal(changesKey(file, k("x")), null);
  });

  // TUI の handleChangesKey に case が増えたら TUI_CHANGES_KEYS に足す。足すとここで、サイドバーの割り当てが無いと分かる。
  it("TUI の CHANGES のキーは、すべてサイドバーの行に割り当てがある", () => {
    const rows = [file, open, closed];
    for (const tui of TUI_CHANGES_KEYS) {
      for (const row of rows) {
        const key = domKey(tui);
        // G・R・: は Shift を押して出す文字だが、key の値はもう大文字・記号になっている
        assert.notEqual(
          changesKey(row, k(key)),
          null,
          `TUI のキー ${tui} がサイドバーの CHANGES に無い`,
        );
      }
    }
  });

  it("操作の種類は TUI の表のとおり揃っている", () => {
    const kinds = new Set<ChangesAction["kind"]>();
    for (const tui of TUI_CHANGES_KEYS) {
      for (const row of [file, open, closed]) {
        const a = changesKey(row, k(domKey(tui)));
        if (a) kinds.add(a.kind);
      }
    }
    assert.deepEqual([...kinds].sort(), [
      "explorer",
      "folder",
      "leave",
      "move",
      "open",
      "shj",
    ]);
  });
});

describe("PR モードの CHANGES のキー（Issue #46）", () => {
  it("PR モードでも HEAD のときと同じ判定で、r・R・Space を shj に渡す（PR_CHANGES_KEYS は TUI_CHANGES_KEYS に含まれる）", () => {
    for (const tui of PR_CHANGES_KEYS) {
      assert.ok(TUI_CHANGES_KEYS.includes(tui), tui);
    }
    for (const tui of PR_CHANGES_KEYS) {
      for (const row of [file, open, closed]) {
        const a = changesKey(row, k(domKey(tui)));
        assert.equal(a?.kind, "shj", tui);
      }
    }
  });

  it("space v・space g：space を shj に渡し、続きの v・g は端末から届く（一覧は割り当てない）", () => {
    assert.deepEqual(changesKey(file, k(" ")), { kind: "shj", key: "space" });
    for (const key of PR_SPACE_FOLLOWUPS) {
      assert.equal(changesKey(file, k(key))?.kind === "shj", false, key);
    }
  });
});

describe("moveIndex", () => {
  const es = [
    { key: "a", parent: undefined },
    { key: "a/b", parent: "a" },
    { key: "a/b/x.go", parent: "a/b" },
    { key: "a/y.go", parent: "a" },
  ];
  it("上下・最初・最後。端で動けなければ -1", () => {
    assert.equal(moveIndex(es, 1, "next"), 2);
    assert.equal(moveIndex(es, 1, "prev"), 0);
    assert.equal(moveIndex(es, 2, "first"), 0);
    assert.equal(moveIndex(es, 1, "last"), 3);
    assert.equal(moveIndex(es, 3, "next"), -1);
    assert.equal(moveIndex(es, 0, "prev"), -1);
    assert.equal(moveIndex(es, 0, "first"), -1);
    assert.equal(moveIndex([], 0, "next"), -1);
  });
  it("親へ。一番上の行は動かない", () => {
    assert.equal(moveIndex(es, 2, "parent"), 1);
    assert.equal(moveIndex(es, 3, "parent"), 0);
    assert.equal(moveIndex(es, 0, "parent"), -1);
  });
});
