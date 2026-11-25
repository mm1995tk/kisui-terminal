import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { browserWindowRows } from "../../../features/browser/window.ts";
import type { KeyLike } from "../../../features/commands/guiKeys.ts";
import { PLACE_KEYS } from "../../../features/commands/placeKeys.ts";
import { browserWindowHints, browserWindowKey } from "./browserWindowKey.ts";

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("ブラウザのタブの窓のキー（#459）", () => {
  it("j k と ↓ ↑ で選ぶ行を動かし、Enter で行う", () => {
    for (const k of ["j", "ArrowDown"])
      assert.deepEqual(browserWindowKey(key(k)), { kind: "select", step: 1 });
    for (const k of ["k", "ArrowUp"])
      assert.deepEqual(browserWindowKey(key(k)), { kind: "select", step: -1 });
    assert.deepEqual(browserWindowKey(key("Enter")), { kind: "run" });
    assert.equal(browserWindowKey(key("Enter", { shiftKey: true })), null);
    assert.equal(browserWindowKey(key("ArrowDown", { shiftKey: true })), null);
  });

  it("h l と ← → は戻る・進む", () => {
    for (const k of ["h", "ArrowLeft"])
      assert.deepEqual(browserWindowKey(key(k)), { kind: "op", op: "back" });
    for (const k of ["l", "ArrowRight"])
      assert.deepEqual(browserWindowKey(key(k)), { kind: "op", op: "forward" });
    assert.equal(browserWindowKey(key("ArrowLeft", { shiftKey: true })), null);
  });

  it("行の字は、その行の操作を行う（窓の行の字と、判定の字がずれない）", () => {
    for (const r of browserWindowRows({
      id: "b1",
      target: "@local",
      workspace: "w1",
      url: "https://example.com/",
      title: "",
    }))
      assert.deepEqual(
        browserWindowKey(key(r.key, { shiftKey: /^[A-Z]$/.test(r.key) })),
        { kind: "op", op: r.op },
        r.key,
      );
  });

  it("タブを作る・閉じる・名前を変える・移すキーは持たない（ワークスペースの窓がする）", () => {
    for (const k of ["n", "N", "x", "R", "m", "t", "Tab", "1"])
      assert.equal(browserWindowKey(key(k)), null, k);
  });

  it("Ctrl・Alt・Cmd を重ねたものと、変換中のキーは受けない", () => {
    for (const k of ["j", "h", "r", "Enter", "B", "/"]) {
      assert.equal(browserWindowKey(key(k, { ctrlKey: true })), null);
      assert.equal(browserWindowKey(key(k, { altKey: true })), null);
      assert.equal(browserWindowKey(key(k, { metaKey: true })), null);
      assert.equal(browserWindowKey(key(k, { isComposing: true })), null);
    }
    // macOS：変換を確かめる Enter は isComposing が false で keyCode が 229
    assert.equal(browserWindowKey(key("Enter", { keyCode: 229 })), null);
  });

  it("`?` の一覧の表（placeKeys.ts の browserWindow）のキーを、判定が受ける", () => {
    for (const r of PLACE_KEYS.browserWindow.rows)
      for (const p of r.probes)
        assert.notEqual(
          browserWindowKey(key(p, { shiftKey: /^[A-Z?]$/.test(p) })),
          null,
          `${r.keys}: ${p}`,
        );
  });

  it("下の段は、選ぶ → 行う → `?` → 閉じる", () => {
    assert.deepEqual(
      browserWindowHints().map((h) => h.keys.join(" ")),
      ["j k", "Enter", "?", "Esc"],
    );
  });
});
