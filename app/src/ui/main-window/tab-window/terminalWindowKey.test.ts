import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { KeyLike } from "../../../features/commands/guiKeys.ts";
import {
  COMMON_KEYS,
  placeKeys,
  type FooterRow,
} from "../../../features/commands/placeKeys.ts";
import {
  splitDirKey,
  terminalWindowFooter,
  terminalWindowKey,
  type TerminalWindowState,
} from "./terminalWindowKey.ts";

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

const DIRS = [
  ["h", "ArrowLeft", "left"],
  ["j", "ArrowDown", "down"],
  ["k", "ArrowUp", "up"],
  ["l", "ArrowRight", "right"],
] as const;

describe("ターミナルのタブの窓のキー", () => {
  it("h j k l と矢印で、選ぶペインを隣へ移す", () => {
    for (const [letter, arrow, dir] of DIRS)
      for (const k of [letter, arrow])
        assert.deepEqual(terminalWindowKey(key(k)), { kind: "select", dir });
  });

  it("H J K L（Shift）で、選んでいるペインを隣と入れ替える", () => {
    for (const [letter, , dir] of DIRS)
      assert.deepEqual(
        terminalWindowKey(key(letter.toUpperCase(), { shiftKey: true })),
        { kind: "swap", dir },
      );
    // Shift+矢印は受けない（入れ替えは字だけ）
    assert.equal(terminalWindowKey(key("ArrowLeft", { shiftKey: true })), null);
  });

  it("Enter はフォーカスを移して閉じ、s は分け、x は閉じ、z は隠し、r はリサイズモード、? は一覧", () => {
    assert.deepEqual(terminalWindowKey(key("Enter")), { kind: "focus" });
    assert.deepEqual(terminalWindowKey(key("s")), { kind: "split" });
    assert.deepEqual(terminalWindowKey(key("x")), { kind: "close" });
    assert.deepEqual(terminalWindowKey(key("z")), { kind: "zoom" });
    assert.deepEqual(terminalWindowKey(key("r")), { kind: "resize" });
    assert.deepEqual(terminalWindowKey(key("?", { shiftKey: true })), {
      kind: "help",
    });
  });

  it("タブを作る・閉じる・名前を変える・移すキーは持たない（ワークスペースの窓がする）", () => {
    for (const k of ["n", "N", "R", "m", "Tab", "1"])
      assert.equal(terminalWindowKey(key(k)), null, k);
    assert.equal(terminalWindowKey(key("Enter", { shiftKey: true })), null);
  });

  it("Ctrl・Alt・Cmd を重ねたものと、変換中のキーは受けない", () => {
    for (const k of ["h", "s", "x", "Enter", "H"]) {
      assert.equal(terminalWindowKey(key(k, { ctrlKey: true })), null);
      assert.equal(terminalWindowKey(key(k, { altKey: true })), null);
      assert.equal(terminalWindowKey(key(k, { metaKey: true })), null);
      assert.equal(terminalWindowKey(key(k, { isComposing: true })), null);
    }
    // macOS：変換を確かめる Enter は isComposing が false で keyCode が 229
    assert.equal(terminalWindowKey(key("Enter", { keyCode: 229 })), null);
  });

  it("`?` の一覧の表（placeKeys.ts の termWindow）のキーを、判定が受ける", () => {
    for (const r of placeKeys().termWindow.rows)
      for (const p of r.probes)
        assert.notEqual(
          terminalWindowKey(key(p, { shiftKey: /^[A-Z?]$/.test(p) })),
          null,
          `${r.keys}: ${p}`,
        );
  });
});

describe("分ける向きを待つ間のキー（s のあと）", () => {
  it("h j k l と矢印で、その向きに分ける", () => {
    for (const [letter, arrow, dir] of DIRS)
      for (const k of [letter, arrow])
        assert.deepEqual(splitDirKey(key(k)), { kind: "dir", dir });
  });

  it("Esc でやめる。変換を取り消す Esc ではやめない", () => {
    assert.deepEqual(splitDirKey(key("Escape")), { kind: "cancel" });
    assert.equal(splitDirKey(key("Escape", { isComposing: true })), null);
    assert.equal(splitDirKey(key("Escape", { keyCode: 229 })), null);
  });

  it("ほかのキーと、修飾キーを重ねたものは受けない", () => {
    for (const k of ["s", "x", "Enter", "?", "z"])
      assert.equal(splitDirKey(key(k)), null, k);
    assert.equal(splitDirKey(key("H", { shiftKey: true })), null);
    assert.equal(splitDirKey(key("h", { ctrlKey: true })), null);
  });
});

describe("terminalWindowFooter（窓の下の段の今効く操作。#488）", () => {
  const all: TerminalWindowState = {
    splitting: false,
    empty: false,
    primary: false,
    swappable: true,
    canZoom: true,
  };
  const shown = (rows: FooterRow[]) =>
    rows.map((r) => [r.title, r.items.map((i) => i.keys.join(" "))]);

  it("全部効くときは、選んでいるペインの行と、このターミナルのタブの行に、全部の操作を出す", () => {
    assert.deepEqual(shown(terminalWindowFooter(all)), [
      ["Selected pane", ["s", "H J K L", "x"]],
      ["This terminal tab", ["z", "r"]],
    ]);
  });

  it("プライマリは x を、隣が無ければ H J K L を、隠せなければ z を出さない", () => {
    assert.deepEqual(
      shown(
        terminalWindowFooter({
          ...all,
          primary: true,
          swappable: false,
          canZoom: false,
        }),
      ),
      [
        ["Selected pane", ["s"]],
        ["This terminal tab", ["r"]],
      ],
    );
  });

  it("分ける向きを待つ間は、向きと、やめる Esc だけ", () => {
    assert.deepEqual(shown(terminalWindowFooter({ ...all, splitting: true })), [
      ["Split direction", ["h j k l", "Esc"]],
    ]);
  });

  it("ペインを出せない間は、効く操作が無いので、見出しだけ", () => {
    for (const splitting of [false, true])
      assert.deepEqual(
        shown(terminalWindowFooter({ ...all, empty: true, splitting })),
        [
          ["Selected pane", []],
          ["This terminal tab", []],
        ],
      );
  });

  it("下の段に出す操作は、どれも判定が受ける（案内と受けるキーがずれない）", () => {
    for (const r of terminalWindowFooter(all))
      for (const i of r.items)
        for (const p of i.probes)
          assert.notEqual(
            terminalWindowKey(key(p, { shiftKey: /^[A-Z?]$/.test(p) })),
            null,
            `${i.keys}: ${p}`,
          );
    for (const r of terminalWindowFooter({ ...all, splitting: true }))
      for (const i of r.items)
        for (const p of i.probes)
          assert.notEqual(splitDirKey(key(p)), null, `${i.keys}: ${p}`);
  });

  it("`?` の一覧の表の操作は、どこでも同じキー（h j k l・Enter・Esc・`?`）を除き、どれも下の段に出る。ふだんの下の段には、どこでも同じキーを出さない", () => {
    const probes = terminalWindowFooter(all).flatMap((r) =>
      r.items.flatMap((i) => i.probes),
    );
    for (const r of placeKeys().termWindow.rows)
      for (const p of r.probes)
        if (!COMMON_KEYS.has(p))
          assert.ok(probes.includes(p), `${r.keys}: ${p}`);
    for (const p of probes) assert.ok(!COMMON_KEYS.has(p), p);
  });
});
