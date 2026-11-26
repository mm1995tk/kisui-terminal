import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { browserWindowRows } from "../../../features/browser/window.ts";
import type { KeyLike } from "../../../features/commands/guiKeys.ts";
import {
  COMMON_KEYS,
  placeKeys,
  type FooterRow,
} from "../../../features/commands/placeKeys.ts";
import { NEW_TAB_URL } from "../../../features/browser/newTab.ts";
import type { BrowserTab } from "../../../features/browser/tabs.ts";
import { browserWindowFooter, browserWindowKey } from "./browserWindowKey.ts";

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
    for (const r of placeKeys().browserWindow.rows)
      for (const p of r.probes)
        assert.notEqual(
          browserWindowKey(key(p, { shiftKey: /^[A-Z?]$/.test(p) })),
          null,
          `${r.keys}: ${p}`,
        );
  });
});

describe("browserWindowFooter（窓の下の段の今効く操作。#488）", () => {
  const tab = (over: Partial<BrowserTab> = {}): BrowserTab => ({
    id: "b1",
    target: "@local",
    workspace: "w1",
    url: "https://example.com/",
    title: "",
    ...over,
  });
  const shown = (rows: FooterRow[]) =>
    rows.map((r) => [r.title, r.items.map((i) => i.keys.join(" "))]);
  const footer = (t: BrowserTab) => browserWindowFooter(browserWindowRows(t));
  const full = tab({
    history: { back: true, forward: true },
    loading: { progress: 50 },
  });

  it("全部効くときは、移動の行と、このページの行に、全部の操作を出す", () => {
    assert.deepEqual(shown(footer(full)), [
      ["Navigate", ["h", "l", "r", "c", "u"]],
      ["This page", ["y", "e", "s", "/", "b", "B", "i"]],
    ]);
  });

  it("今できない操作は出さない（履歴が無ければ h l、読み込み中でなければ c、シークレットなら s）", () => {
    assert.deepEqual(shown(footer(tab({ incognito: true }))), [
      ["Navigate", ["r", "u"]],
      ["This page", ["y", "e", "/", "b", "B", "i"]],
    ]);
  });

  it("新しいタブのページは、ページが無いので、URL を打つ u と、ブックマークの一覧 B だけ", () => {
    assert.deepEqual(shown(footer(tab({ url: NEW_TAB_URL }))), [
      ["Navigate", ["u"]],
      ["This page", ["B"]],
    ]);
  });

  it("下の段に出す操作は、どれも判定が受ける（案内と受けるキーがずれない）", () => {
    for (const r of footer(full))
      for (const i of r.items)
        for (const p of i.probes)
          assert.notEqual(
            browserWindowKey(key(p, { shiftKey: /^[A-Z?]$/.test(p) })),
            null,
            `${i.keys}: ${p}`,
          );
  });

  it("`?` の一覧の表の操作は、どこでも同じキー（j k・Enter・Esc・`?`）を除き、どれも下の段に出る。下の段には、どこでも同じキーを出さない", () => {
    const probes = footer(full).flatMap((r) =>
      r.items.flatMap((i) => i.probes),
    );
    for (const r of placeKeys().browserWindow.rows)
      for (const p of r.probes)
        if (!COMMON_KEYS.has(p) || p === "h" || p === "l")
          assert.ok(probes.includes(p), `${r.keys}: ${p}`);
    // h l は、この窓では戻る・進む（列を移るのではない）ので出す。ほかのどこでも同じキーは出さない
    for (const k of footer(full).flatMap((r) => r.items.flatMap((i) => i.keys)))
      assert.ok(!COMMON_KEYS.has(k) || k === "h" || k === "l", k);
  });
});
