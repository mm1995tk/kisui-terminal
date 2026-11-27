import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { KeyLike } from "../../../features/commands/guiKeys.ts";
import { newTabInputKey, newTabKindKey, newTabKinds } from "./newTabKey.ts";
import {
  COMMON_KEYS,
  placeKeys,
  type FooterRow,
} from "../../../features/commands/placeKeys.ts";
import {
  confirmKey,
  holdKey,
  switcherFooter,
  switcherKey,
  type SwitcherState,
} from "./switcherKey.ts";

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("Workspace switcher のキー", () => {
  it("j k と矢印と Ctrl+J / Ctrl+K で、選ぶ行を動かす", () => {
    for (const k of ["j", "ArrowDown"])
      assert.deepEqual(switcherKey(key(k)), { kind: "move", to: "next" });
    for (const k of ["k", "ArrowUp"])
      assert.deepEqual(switcherKey(key(k)), { kind: "move", to: "prev" });
    assert.deepEqual(switcherKey(key("j", { ctrlKey: true })), {
      kind: "move",
      to: "next",
    });
    assert.deepEqual(switcherKey(key("k", { ctrlKey: true })), {
      kind: "move",
      to: "prev",
    });
  });

  it("h l と矢印の左右で、キーが効く列を移る", () => {
    for (const k of ["h", "ArrowLeft"])
      assert.deepEqual(switcherKey(key(k)), { kind: "col", to: "ws" });
    for (const k of ["l", "ArrowRight"])
      assert.deepEqual(switcherKey(key(k)), { kind: "col", to: "tab" });
    assert.equal(switcherKey(key("h", { ctrlKey: true })), null);
    assert.equal(switcherKey(key("l", { metaKey: true })), null);
    assert.equal(switcherKey(key("l", { altKey: true })), null);
    assert.equal(switcherKey(key("h", { isComposing: true })), null);
    assert.equal(switcherKey(key("l", { keyCode: 229 })), null);
  });

  it("Enter で開く。Tab と 1〜9 は受けない（j k で選ぶ）", () => {
    assert.deepEqual(switcherKey(key("Enter")), { kind: "go" });
    assert.equal(switcherKey(key("Tab")), null);
    assert.equal(switcherKey(key("1")), null);
    assert.equal(switcherKey(key("9")), null);
  });

  it("n は作り、r は名前を変え、x は閉じる", () => {
    assert.deepEqual(switcherKey(key("n")), { kind: "new" });
    assert.deepEqual(switcherKey(key("r")), { kind: "rename" });
    assert.deepEqual(switcherKey(key("x")), { kind: "close" });
    assert.equal(switcherKey(key("x", { ctrlKey: true })), null);
    assert.equal(switcherKey(key("n", { metaKey: true })), null);
  });

  it("N（Shift+n）は、どちらの列でもタブを作る（作るタブの種類を選ぶ間にする）。Cmd・Ctrl・Alt を重ねたものと変換中のキーは受けない", () => {
    assert.deepEqual(switcherKey(key("N", { shiftKey: true })), {
      kind: "newTab",
    });
    assert.equal(switcherKey(key("N", { metaKey: true })), null);
    assert.equal(switcherKey(key("N", { ctrlKey: true })), null);
    assert.equal(switcherKey(key("N", { isComposing: true })), null);
    assert.equal(switcherKey(key("N", { keyCode: 229 })), null);
  });

  it("J K（Shift+j・Shift+k）は並べ替える", () => {
    assert.deepEqual(switcherKey(key("J", { shiftKey: true })), {
      kind: "reorder",
      dir: "down",
    });
    assert.deepEqual(switcherKey(key("K", { shiftKey: true })), {
      kind: "reorder",
      dir: "up",
    });
  });

  it("絞り込みの字は受けず、Alt・Cmd を重ねたものと変換中のキーは受けない", () => {
    assert.equal(switcherKey(key("a")), null);
    assert.equal(switcherKey(key("q")), null);
    assert.equal(switcherKey(key("x", { altKey: true })), null);
    assert.equal(switcherKey(key("j", { metaKey: true })), null);
    assert.equal(switcherKey(key("Enter", { shiftKey: true })), null);
    assert.equal(switcherKey(key("j", { isComposing: true })), null);
    // 変換を確定する Enter（compositionend のあとに keyCode 229 で来る）で移らない
    assert.equal(switcherKey(key("Enter", { keyCode: 229 })), null);
    assert.equal(switcherKey(key("Process", { keyCode: 229 })), null);
  });
});

describe("閉じる確認のキー", () => {
  it("y で閉じ、n でやめる。ほかのキーと、Ctrl・Cmd・Alt を重ねたものと、変換中のキーは何もしない", () => {
    assert.equal(confirmKey(key("y")), "yes");
    assert.equal(confirmKey(key("n")), "no");
    assert.equal(confirmKey(key("x")), null);
    assert.equal(confirmKey(key("Enter")), null);
    assert.equal(confirmKey(key("y", { ctrlKey: true })), null);
    assert.equal(confirmKey(key("y", { isComposing: true })), null);
    assert.equal(confirmKey(key("n", { keyCode: 229 })), null);
  });
});

describe("Dialog の Key footer（共通フッタ）の今効く操作（#487）", () => {
  const all = newTabKinds(true);
  const states: SwitcherState[] = [
    { mode: "hold" },
    { mode: "kinds", kinds: all },
    { mode: "kinds", kinds: newTabKinds(false) },
    { mode: "typing", newTab: true },
    { mode: "typing", newTab: false },
    { mode: "confirm" },
    { mode: "tab" },
    { mode: "ws", hasWs: true },
    { mode: "ws", hasWs: false },
  ];
  /** その状態でキーを受ける判定 */
  const judge = (s: SwitcherState) => (k: KeyLike) => {
    switch (s.mode) {
      case "hold":
        return holdKey(k);
      case "kinds":
        return newTabKindKey(k, s.kinds);
      case "typing":
        return newTabInputKey(k);
      case "confirm":
        return confirmKey(k);
      default:
        return switcherKey(k);
    }
  };
  const shown = (rows: FooterRow<string>[]) =>
    rows.map((r) => [r.title, r.items.map((i) => i.keys.join(" "))]);

  it("Key footer に出す操作は、どの状態でも、その状態の判定が受ける（案内と受けるキーがずれない）", () => {
    for (const s of states)
      for (const r of switcherFooter(s))
        for (const i of r.items) {
          assert.ok(i.probes.length > 0, `${s.mode}: ${i.keys}`);
          for (const p of i.probes)
            assert.notEqual(
              judge(s)(key(p, { shiftKey: /^[A-Z?]$/.test(p) })),
              null,
              `${s.mode}: ${i.keys} ${p}`,
            );
        }
  });

  it("`?` の一覧の表の操作は、どれも、ワークスペースの列かタブの列の Key footer に出る（`?` を開かなくても分かる）。どこでも同じキーは除く", () => {
    const onFooter = new Set(
      (
        [{ mode: "tab" }, { mode: "ws", hasWs: true }] as SwitcherState[]
      ).flatMap((s) =>
        switcherFooter(s).flatMap((r) => r.items.flatMap((i) => i.probes)),
      ),
    );
    for (const place of ["switcher", "switcherTabs"] as const)
      for (const r of placeKeys()[place].rows)
        for (const p of r.probes)
          if (!COMMON_KEYS.has(p)) assert.ok(onFooter.has(p), `${place}: ${p}`);
  });

  it("ふだんは、どこでも同じキー（Enter・Esc・h j k l・矢印・`?`）を出さない（意味が変わる間：つかんでいる間・種類を選ぶ間・マシンの一覧を開く ↓ を除く）", () => {
    for (const s of states.filter(
      (s) =>
        s.mode !== "hold" &&
        s.mode !== "kinds" &&
        !(s.mode === "typing" && s.newTab),
    ))
      for (const r of switcherFooter(s))
        for (const i of r.items)
          for (const p of i.probes)
            assert.ok(!COMMON_KEYS.has(p), `${s.mode}: ${p}`);
  });

  it("ワークスペースの列：ワークスペースへの操作と、この Dialog の操作（ワークスペースを作る）の 2 行。ワークスペースが無ければ、1 行目は見出しだけ", () => {
    assert.deepEqual(shown(switcherFooter({ mode: "ws", hasWs: true })), [
      ["Workspace", ["N", "r", "x", "J K"]],
      ["Dialog", ["n"]],
    ]);
    assert.deepEqual(shown(switcherFooter({ mode: "ws", hasWs: false })), [
      ["Workspace", []],
      ["Dialog", ["n"]],
    ]);
  });

  it("タブの列：選んでいるタブへの操作の 1 行", () => {
    assert.deepEqual(shown(switcherFooter({ mode: "tab" })), [
      ["Tab", ["r", "x", "J K", "m", "n"]],
    ]);
  });

  it("つかんでいる間は、意味が変わるので j k・h l・Enter・Esc を出す（`?` は出さない）", () => {
    assert.deepEqual(shown(switcherFooter({ mode: "hold" })), [
      ["Moving a tab", ["j k", "h l", "Enter", "Esc"]],
    ]);
    assert.equal(holdKey(key("?", { shiftKey: true })), null);
  });

  it("作るタブの種類を選ぶ間は、選べる種類を押せるボタン（act に種類）にし、選ぶのをやめる Esc を出す", () => {
    const [r] = switcherFooter({ mode: "kinds", kinds: all });
    assert.deepEqual(
      r.items.map((i) => [i.keys.join(" "), i.act]),
      [
        ["t", "terminal"],
        ["b", "browser"],
        ["B", "incognito"],
        ["d", "db"],
        ["Esc", undefined],
      ],
    );
    const [off] = switcherFooter({ mode: "kinds", kinds: newTabKinds(false) });
    assert.deepEqual(
      off.items.map((i) => i.keys.join(" ")),
      ["t", "d", "Esc"],
    );
  });

  it("名前を打っている間は見出しだけ。ターミナルのタブを作る欄では、マシンを替える Tab・↓ を出す", () => {
    assert.deepEqual(shown(switcherFooter({ mode: "typing", newTab: false })), [
      ["Typing a name", []],
    ]);
    assert.deepEqual(shown(switcherFooter({ mode: "typing", newTab: true })), [
      ["Typing a name", ["Tab", "↓"]],
    ]);
  });

  it("どの状態でも、少なくとも 1 行を出す（Key footer は出たり消えたりしない）", () => {
    for (const s of states) assert.ok(switcherFooter(s).length > 0, s.mode);
  });
});

describe("`?` の一覧の表（placeKeys.ts の switcher・switcherTabs）", () => {
  it("`?` で、キーの一覧を出す（Ctrl・Cmd・Alt を重ねたものと変換中は受けない）", () => {
    assert.deepEqual(switcherKey(key("?", { shiftKey: true })), {
      kind: "help",
    });
    assert.equal(switcherKey(key("?", { ctrlKey: true })), null);
    assert.equal(switcherKey(key("?", { isComposing: true })), null);
  });

  it("表のキーは、どれも判定が受ける", () => {
    for (const place of ["switcher", "switcherTabs"] as const)
      for (const r of placeKeys()[place].rows)
        for (const p of r.probes)
          assert.notEqual(
            switcherKey(key(p)),
            null,
            `${place} ${r.keys}: ${p}`,
          );
  });

  it("判定が受ける字のキーは、どちらかの列の表にある（表から漏れた操作が無い）", () => {
    const listed = new Set(
      (["switcher", "switcherTabs"] as const).flatMap((place) =>
        placeKeys()[place].rows.flatMap((r) => r.probes),
      ),
    );
    for (const k of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ?")
      if (switcherKey(key(k)) !== null) assert.ok(listed.has(k), k);
  });
});

describe("タブをつかむ（m）", () => {
  it("m は、つかむ（Cmd・Ctrl・Alt を重ねたものと変換中は受けない）", () => {
    assert.deepEqual(switcherKey(key("m")), { kind: "hold" });
    assert.equal(switcherKey(key("m", { ctrlKey: true })), null);
    assert.equal(switcherKey(key("m", { metaKey: true })), null);
    assert.equal(switcherKey(key("m", { isComposing: true })), null);
  });
});

describe("タブをつかんでいる間のキー", () => {
  it("j k・矢印・Ctrl+J / Ctrl+K で動かす", () => {
    for (const k of ["j", "ArrowDown"])
      assert.deepEqual(holdKey(key(k)), { kind: "move", to: "next" });
    for (const k of ["k", "ArrowUp"])
      assert.deepEqual(holdKey(key(k)), { kind: "move", to: "prev" });
    assert.deepEqual(holdKey(key("j", { ctrlKey: true })), {
      kind: "move",
      to: "next",
    });
    assert.deepEqual(holdKey(key("k", { ctrlKey: true })), {
      kind: "move",
      to: "prev",
    });
  });

  it("h l と矢印の左右で、列を移る", () => {
    for (const k of ["h", "ArrowLeft"])
      assert.deepEqual(holdKey(key(k)), { kind: "col", to: "ws" });
    for (const k of ["l", "ArrowRight"])
      assert.deepEqual(holdKey(key(k)), { kind: "col", to: "tab" });
  });

  it("Enter と m で落とし、Esc でやめる", () => {
    assert.deepEqual(holdKey(key("Enter")), { kind: "drop" });
    assert.deepEqual(holdKey(key("m")), { kind: "drop" });
    assert.deepEqual(holdKey(key("Escape")), { kind: "cancel" });
    assert.equal(holdKey(key("Enter", { shiftKey: true })), null);
  });

  it("ほかのキーは受けない（並べ替え・作る・名前を変える・閉じる・Tab）", () => {
    for (const k of ["J", "K", "n", "N", "r", "x", "y", "Tab", "1"])
      assert.equal(holdKey(key(k)), null, k);
  });

  it("Cmd・Alt を重ねたものと、変換中のキーは受けない", () => {
    assert.equal(holdKey(key("j", { metaKey: true })), null);
    assert.equal(holdKey(key("h", { altKey: true })), null);
    assert.equal(holdKey(key("Escape", { ctrlKey: true })), null);
    assert.equal(holdKey(key("Escape", { isComposing: true })), null);
    assert.equal(holdKey(key("Enter", { keyCode: 229 })), null);
    assert.equal(holdKey(key("j", { isComposing: true })), null);
  });
});
