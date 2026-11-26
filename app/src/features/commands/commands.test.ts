import { T } from "../../i18n/index.ts";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  afterKeyUp,
  childrenAt,
  helpRows,
  interceptKeys,
  IDLE,
  LEADER,
  leaderKeyName,
  menuRows,
  outsideLeaves,
  route,
  setBrowserEnabled,
  setUserShortcuts,
  shortcutCommand,
  type Command,
  type Env,
  type Node,
  type RouterState,
} from "./commands.ts";
import type { KeyLike } from "./guiKeys.ts";
import { matchSpec, parseSpec } from "./keyspec.ts";

const MAC = true;
const LINUX = false;

function key(k: string, mods = "", code?: string): KeyLike {
  return {
    key: k,
    code:
      code ??
      (k.length === 1 && /[a-z]/i.test(k) ? `Key${k.toUpperCase()}` : ""),
    ctrlKey: mods.includes("c"),
    shiftKey: mods.includes("s"),
    altKey: mods.includes("a"),
    metaKey: mods.includes("m"),
  };
}

const env = (mac: boolean, over: Partial<Env> = {}): Env => ({
  mac,
  dialogOpen: false,
  resizeMode: false,
  inPane: true,
  ...over,
});

/** リーダーを押す（この OS のキー）。 */
const LEADER_KEY = (mac: boolean) =>
  mac ? key("k", "m", "KeyK") : key("K", "cs", "KeyK");

/** キーを順に押して、動かしたコマンドと、受けなかった（ターミナルに届く）キーの数を返す。 */
function press(mac: boolean, keys: KeyLike[], e: Partial<Env> = {}) {
  let state: RouterState = IDLE;
  const runs: Command[] = [];
  const passed: KeyLike[] = [];
  for (const k of keys) {
    const r = route(state, k, env(mac, e));
    state = r.state;
    if (!r.consume) passed.push(k);
    else if (r.run) runs.push(r.run);
  }
  return { state, runs, passed };
}

function treeLeaves(
  list: Node[],
  path: string[] = [],
): { path: string[]; node: Node }[] {
  return list.flatMap((n) => [
    { path: [...path, n.type === "group" ? n.key : n.keys[0]], node: n },
    ...(n.type === "group" ? treeLeaves(n.children, [...path, n.key]) : []),
  ]);
}

/** 今使う木の葉とグループと、木の外の葉（近道だけの操作。path は ["(近道だけ)"]）。 */
function leaves(): { path: string[]; node: Node }[] {
  return [
    ...treeLeaves(LEADER),
    ...outsideLeaves().map((node) => ({ path: ["(近道だけ)"], node })),
  ];
}

/** ノードの既定の近道（この OS のもの）。近道を持つのは葉だけ。 */
const shortcutOn = (node: Node, mac: boolean): string | undefined =>
  node.type === "leaf"
    ? mac
      ? node.shortcut?.mac
      : node.shortcut?.other
    : undefined;

describe("コマンドの表", () => {
  it("同じ一覧の中で、キーが重ならない", () => {
    const check = (list: Node[], where: string) => {
      const seen = new Set<string>();
      for (const n of list) {
        for (const k of n.type === "group" ? [n.key] : n.keys) {
          assert.equal(seen.has(k), false, `${where} で ${k} が重なっている`);
          seen.add(k);
        }
        if (n.type === "group") {
          assert.ok(n.children.length > 0, `${n.label} が空`);
          check(n.children, `${where} ${n.key}`);
        }
      }
    };
    check(LEADER, "1 段目");
  });

  it("近道は OS ごとに重ならず、リーダーのキーとも重ならない", () => {
    for (const mac of [MAC, LINUX]) {
      const seen = new Map<string, string>();
      seen.set(leaderKeyName(mac), "リーダー");
      for (const { path, node } of leaves()) {
        const s = shortcutOn(node, mac);
        if (!s) continue;
        assert.equal(
          seen.has(s),
          false,
          `${s}（${path.join(" ")}）が ${seen.get(s)} と重なっている`,
        );
        seen.set(s, path.join(" "));
      }
    }
  });

  it("Linux の近道は Ctrl+Shift+字か、何も奪わない Ctrl+= と Ctrl+0 だけ（Super・Ctrl 単独・Alt は使わない）", () => {
    for (const { node } of leaves()) {
      const s = shortcutOn(node, LINUX);
      if (!s) continue;
      assert.ok(
        /^Ctrl\+Shift\+[A-Z]$/.test(s) || s === "Ctrl+=" || s === "Ctrl+0",
        s,
      );
    }
    assert.match(leaderKeyName(LINUX), /^Ctrl\+Shift\+K$/);
    assert.equal(leaderKeyName(MAC), "Cmd+K");
  });

  it("キーの定義の、docs/key-design.md の表のとおりの並び（#51 のキーはまだ無い。#93 は場所のキーで、ここには足さない）", () => {
    const rows = helpRows(MAC).map((r) => r.path.join(" "));
    assert.deepEqual(rows, [
      "h|j|k|l",
      "Tab",
      "w",
      "t",
      "n",
      "m",
      "a",
      "x",
      "x p",
      "x c",
      "x s",
      "x i",
      "b",
      "y",
      "v",
      "v + =",
      "v -",
      "v 0",
      "i",
      "i u",
      "i d",
      "i g",
      "i o",
      "i f",
      "c",
      "c s",
      "c r",
      "?",
      // 木の外の、近道だけの操作（見出しの行と、Mac で既定の近道がある 5 つ）。リーダーのあとに押すキーは無い
      "",
      "",
      "",
      "",
      "",
      "",
    ]);
  });

  it("旧 d のグループ（DB のタブの操作）は木に無い（#458）。d は何も動かさずリーダーを出る。DB のタブの操作のコマンドは木の外に残り、設定の近道で使える", () => {
    for (const mac of [MAC, LINUX]) {
      for (const k of ["t", "r", "e", "h", "s", "j", "]", "x", "p"]) {
        const r = press(mac, [LEADER_KEY(mac), key("d"), key(k)]);
        assert.deepEqual(r.runs, [], k);
        assert.equal(r.state.leader, null);
      }
    }
    const ids = (list: Node[]): string[] =>
      list.flatMap((n) => (n.type === "leaf" ? [n.run.id] : ids(n.children)));
    const tree = ids(LEADER);
    const outside = outsideLeaves().map((l) => l.run.id);
    for (const id of [
      "db.tree",
      "db.refresh",
      "db.export",
      "db.history",
      "db.view",
      "db.page",
      "db.result",
      "db.closeResult",
      "db.elevate",
      "db.elevateEnd",
    ] as const) {
      assert.equal(tree.includes(id), false, id);
      assert.equal(outside.includes(id), true, id);
    }
    // 既定の近道は無いので、`?` の一覧にも出ない
    assert.equal(
      helpRows(MAC).some((r) => r.label === T("leader.db.history")),
      false,
    );
  });

  it("a は、今出しているタブの種類の窓を開く 1 つの葉（#457）。既定の近道は無く、その下にほかの操作は無い", () => {
    const a = LEADER.find((n) => n.type === "leaf" && n.keys.includes("a"));
    assert.ok(a && a.type === "leaf");
    assert.deepEqual(a.run, { id: "tab.window" });
    assert.equal(a.shortcut, undefined);
    assert.equal(childrenAt(["a"]), undefined);
    for (const mac of [MAC, LINUX]) {
      const r = press(mac, [LEADER_KEY(mac), key("a")]);
      assert.deepEqual(r.runs, [{ id: "tab.window" }]);
      assert.equal(r.state.leader, null);
    }
  });

  it("ペインの操作のグループ（旧 p）は木に無い（#457。ターミナルのタブの窓がする）。ペインを移る h j k l と Tab は 1 段目に残る", () => {
    assert.equal(childrenAt(["p"]), undefined);
    for (const mac of [MAC, LINUX]) {
      const r = press(mac, [LEADER_KEY(mac), key("p"), key("x")]);
      assert.deepEqual(r.runs, []);
      assert.equal(r.state.leader, null);
      // 旧い入口の近道（Cmd+Shift+P / Ctrl+Shift+P）も無く、ターミナルに届く
      const P = mac ? key("P", "ms", "KeyP") : key("P", "cs", "KeyP");
      assert.equal(press(mac, [P]).passed.length, 1);
    }
    const ids = (list: Node[]): string[] =>
      list.flatMap((n) => (n.type === "leaf" ? [n.run.id] : ids(n.children)));
    const inTree = new Set(ids(LEADER));
    for (const id of [
      "pane.split",
      "pane.swap",
      "pane.close",
      "pane.zoom",
      "pane.resize",
    ])
      assert.equal(inTree.has(id as Command["id"]), false, id);
    assert.ok(inTree.has("pane.focus") && inTree.has("pane.last"));
  });

  it("木の外の操作のうち近道があるものは、`?` の一覧の最後に、見出しの行を付けて並ぶ", () => {
    const tail = (mac: boolean) => {
      const rows = helpRows(mac);
      const at = rows.findIndex((r) => r.path.length === 0);
      return rows.slice(at).map((r) => [r.label, r.shortcut ?? "", r.group]);
    };
    assert.deepEqual(tail(MAC), [
      [T("leader.direct.group"), "", true],
      [T("leader.pane.split.right"), "Cmd+D", false],
      [T("leader.pane.split.down"), "Cmd+Shift+D", false],
      [T("leader.pane.close"), "Cmd+W", false],
      [T("leader.pane.zoom"), "Cmd+Shift+Enter", false],
      [T("leader.pane.resize"), "Cmd+R", false],
    ]);
    // Linux には、ペインを閉じる近道が無い（行も出ない）
    assert.deepEqual(tail(LINUX), [
      [T("leader.direct.group"), "", true],
      [T("leader.pane.split.right"), "Ctrl+Shift+D", false],
      [T("leader.pane.split.down"), "Ctrl+Shift+E", false],
      [T("leader.pane.zoom"), "Ctrl+Shift+M", false],
      [T("leader.pane.resize"), "Ctrl+Shift+R", false],
    ]);
  });

  it("w はグループではなく、ワークスペースの窓を開く 1 つの葉（#296）。その下にほかの操作は無く、Cmd+1〜9 も無い", () => {
    const w = LEADER.find((n) => n.type === "leaf" && n.keys.includes("w"));
    assert.ok(w && w.type === "leaf");
    assert.deepEqual(w.run, { id: "workspace.switch" });
    assert.deepEqual(w.shortcut, { mac: "Cmd+Shift+W", other: "Ctrl+Shift+W" });
    assert.equal(childrenAt(["w"]), undefined);
    for (const mac of [MAC, LINUX])
      assert.equal(
        helpRows(mac).some((r) => r.shortcut && /\+[1-9]$/.test(r.shortcut)),
        false,
      );
  });
});

describe("リーダー", () => {
  for (const mac of [MAC, LINUX]) {
    const L = LEADER_KEY(mac);
    const os = mac ? "Mac" : "Linux";

    it(`${os}：リーダーを押すと入り、次のキーで動き、行ったら出る`, () => {
      const r = press(mac, [L, key("x"), key("p")]);
      assert.deepEqual(r.runs, [{ id: "proxy.panel" }]);
      assert.equal(r.state.leader, null);
      assert.deepEqual(r.passed, []);
    });

    it(`${os}：グループに入ると、案内の位置が一段下がる`, () => {
      assert.deepEqual(press(mac, [L]).state.leader, []);
      assert.deepEqual(press(mac, [L, key("x")]).state.leader, ["x"]);
      // w と t はグループではなく、窓を開く葉（入った先は無く、リーダーを出る）。t は右のタブの列にキーを置いて開く（#454）
      const w = press(mac, [L, key("w")]);
      assert.deepEqual(w.runs, [{ id: "workspace.switch" }]);
      assert.equal(w.state.leader, null);
      const t = press(mac, [L, key("t")]);
      assert.deepEqual(t.runs, [{ id: "workspace.switch", arg: "tab" }]);
      assert.equal(t.state.leader, null);
    });

    it(`${os}：続けて押せる葉は、行ってもリーダーを出ない`, () => {
      const r = press(mac, [L, key("j"), key("j"), key("l")]);
      assert.deepEqual(r.runs, [
        { id: "pane.focus", arg: "down" },
        { id: "pane.focus", arg: "down" },
        { id: "pane.focus", arg: "right" },
      ]);
      assert.deepEqual(r.state.leader, []);
      // 続けて押せない葉は出る
      assert.equal(press(mac, [L, key("y")]).state.leader, null);
    });

    it(`${os}：Esc で出る。Backspace は一段戻り、一番上では出る`, () => {
      assert.equal(press(mac, [L, key("Escape")]).state.leader, null);
      assert.deepEqual(
        press(mac, [L, key("x"), key("Backspace")]).state.leader,
        [],
      );
      assert.equal(press(mac, [L, key("Backspace")]).state.leader, null);
    });

    it(`${os}：リーダーのキーをもう 1 度押しても出る`, () => {
      assert.equal(press(mac, [L, L]).state.leader, null);
      assert.equal(press(mac, [L, key("x"), L]).state.leader, null);
    });

    it(`${os}：一覧に無いキーは捨てて（ターミナルに送らない）出る`, () => {
      const r = press(mac, [L, key("q")]);
      assert.equal(r.state.leader, null);
      assert.deepEqual(r.runs, []);
      assert.deepEqual(r.passed, []);
      // 出たあとのキーは、いつもどおりターミナルに届く
      assert.deepEqual(press(mac, [L, key("q"), key("q")]).passed.length, 1);
    });

    it(`${os}：修飾キーだけを押しても出ない（Shift を押して ? を打てる）`, () => {
      const r = press(mac, [L, key("Shift", "s"), key("?", "s", "Slash")]);
      assert.deepEqual(r.runs, [{ id: "help.keys" }]);
    });

    it(`${os}：Ctrl・Cmd・Option を押した字は一覧のキーに当たらない`, () => {
      assert.deepEqual(press(mac, [L, key("h", "c")]).runs, []);
      assert.deepEqual(press(mac, [L, key("h", "m")]).runs, []);
      assert.deepEqual(press(mac, [L, key("h", "a")]).runs, []);
    });

    it(`${os}：変換中・ダイアログ・リサイズモードの中では入らない`, () => {
      assert.deepEqual(
        press(mac, [{ ...L, isComposing: true }]).state.leader,
        null,
      );
      // 変換を確定する Enter が keyCode 229 で来たときと同じ見分け方（ime.ts の isComposingKey）
      assert.deepEqual(press(mac, [{ ...L, keyCode: 229 }]).state.leader, null);
      const d = press(mac, [L], { dialogOpen: true });
      assert.equal(d.state.leader, null);
      assert.equal(d.passed.length, 1);
      assert.equal(press(mac, [L], { resizeMode: true }).state.leader, null);
    });

    it(`${os}：入るキーの押しっぱなしの繰り返しで、出てしまわない`, () => {
      const r = press(mac, [L, { ...L, repeat: true }, key("y")]);
      assert.deepEqual(r.runs, [{ id: "clipboard.history" }]);
    });

    it(`${os}：最後のキーを押しっぱなしにした繰り返しは、ターミナルに送らない。離すと解ける`, () => {
      let s: RouterState = IDLE;
      for (const k of [L, key("q")]) s = route(s, k, env(mac)).state;
      // L のあとは [] の位置なので q は一覧に無い。出て、swallow になる
      const rep = route(s, { ...key("q"), repeat: true }, env(mac));
      assert.equal(rep.consume, true);
      const up = afterKeyUp(rep.state);
      assert.equal(route(up, key("q"), env(mac)).consume, false);
      // 押し直せば（repeat でない）、keyup が無くても解ける
      assert.equal(route(rep.state, key("q"), env(mac)).consume, false);
    });
  }

  it("Cmd+Shift+W / Ctrl+Shift+W は、リーダーを通さずにワークスペースの窓を開く。グループに 1 回で入る近道は無い（#457）", () => {
    assert.deepEqual(press(MAC, [key("W", "ms", "KeyW")]).runs, [
      { id: "workspace.switch" },
    ]);
    const r = press(LINUX, [key("W", "cs", "KeyW")]);
    assert.deepEqual(r.runs, [{ id: "workspace.switch" }]);
    // 近道では、リーダーに入らない
    assert.equal(r.state.leader, null);
  });

  it("Mac の Cmd+K は Linux では、Linux の Ctrl+Shift+K は Mac ではリーダーに入らない", () => {
    assert.equal(press(LINUX, [LEADER_KEY(MAC)]).state.leader, null);
    assert.equal(press(MAC, [LEADER_KEY(LINUX)]).state.leader, null);
  });
});

describe("リーダーを押したとき以外は、キーがターミナル（shj やシェル）に届く", () => {
  // shijimi-editor の README の「Keys」にあるキーと、シェルでよく使うキー（docs/key-design.md の 8 章）。
  const shjKeys: [string, KeyLike][] = [
    ["Space", key(" ", "", "Space")],
    ["Space（Shift）", key(" ", "s", "Space")],
    [":", key(":", "s", "Semicolon")],
    ["F1", key("F1")],
    ["Ctrl+K", key("k", "c", "KeyK")],
    ["Ctrl+P", key("p", "c", "KeyP")],
    ["Ctrl+B", key("b", "c", "KeyB")],
    ["Ctrl+E", key("e", "c", "KeyE")],
    ["Ctrl+G", key("g", "c", "KeyG")],
    ["Ctrl+`", key("`", "c", "Backquote")],
    ["Ctrl+J", key("j", "c", "KeyJ")],
    ["Ctrl+S", key("s", "c", "KeyS")],
    ["Ctrl+W", key("w", "c", "KeyW")],
    ["Ctrl+Tab", key("Tab", "c")],
    ["Ctrl+\\", key("\\", "c", "Backslash")],
    ["Ctrl+1", key("1", "c", "Digit1")],
    ["Ctrl+2", key("2", "c", "Digit2")],
    ["Ctrl+Q", key("q", "c", "KeyQ")],
    ["Alt+R", key("r", "a", "KeyR")],
    ["Alt+A", key("a", "a", "KeyA")],
    ["Alt+I", key("i", "a", "KeyI")],
    ["Alt+C", key("c", "a", "KeyC")],
    ["Alt+←", key("ArrowLeft", "a")],
    ["Alt+→", key("ArrowRight", "a")],
    ["Ctrl+Alt+D", key("d", "ca", "KeyD")],
    ["Ctrl+Alt+U", key("u", "ca", "KeyU")],
    ["Ctrl+O", key("o", "c", "KeyO")],
    ["Ctrl+I", key("i", "c", "KeyI")],
    ["Ctrl+C", key("c", "c", "KeyC")],
    ["Ctrl+X", key("x", "c", "KeyX")],
    ["Ctrl+Z", key("z", "c", "KeyZ")],
    ["Ctrl+F", key("f", "c", "KeyF")],
    ["Ctrl+D", key("d", "c", "KeyD")],
    ["Ctrl+R", key("r", "c", "KeyR")],
    ["Ctrl+H", key("h", "c", "KeyH")],
    ["Ctrl+M", key("m", "c", "KeyM")],
    ["Ctrl+Shift+←（選択）", key("ArrowLeft", "cs")],
    ["Ctrl+Shift+→（選択）", key("ArrowRight", "cs")],
    ["Ctrl+Shift+↑", key("ArrowUp", "cs")],
    ["Ctrl+Shift+↓", key("ArrowDown", "cs")],
    ["Ctrl+Shift+Home", key("Home", "cs")],
    ["Ctrl+Shift+End", key("End", "cs")],
    ["Ctrl+Shift+Z（やり直し）", key("Z", "cs", "KeyZ")],
    ["Ctrl+_", key("_", "cs", "Minus")],
    ["Ctrl+/", key("/", "c", "Slash")],
    ["Ctrl+-（Linux で消した）", key("-", "c", "Minus")],
    ["Ctrl+Shift+V（貼り付け）", key("V", "cs", "KeyV")],
    ["Cmd+Option+←（Mac で消した）", key("ArrowLeft", "ma")],
    ["Cmd+Option+→", key("ArrowRight", "ma")],
    ["Esc", key("Escape")],
    ["Backspace", key("Backspace")],
    ["Tab", key("Tab")],
    ["h", key("h")],
    ["j", key("j")],
    ["k", key("k")],
    ["l", key("l")],
    ["?", key("?", "s", "Slash")],
    ["+", key("+", "s", "Equal")],
    ["Enter", key("Enter")],
  ];

  for (const mac of [MAC, LINUX]) {
    for (const [name, k] of shjKeys) {
      // Linux の Ctrl+Shift+矢印など、Mac でも Ctrl のキーはそのまま届く。Mac で Cmd を含むものだけは別に確かめる
      if (!mac && k.metaKey) continue;
      it(`${mac ? "Mac" : "Linux"}：${name}`, () => {
        const r = press(mac, [k]);
        assert.equal(r.passed.length, 1, "受けてはいけない");
        assert.deepEqual(r.runs, []);
        assert.equal(r.state.leader, null);
      });
    }
  }

  it("リーダーを出たあと（Esc・行った後）は、また届く", () => {
    for (const mac of [MAC, LINUX]) {
      const L = LEADER_KEY(mac);
      const r = press(mac, [L, key("Escape"), key(" ", "", "Space"), key("h")]);
      assert.equal(r.passed.length, 2);
    }
  });

  it("リーダーに入っている間だけ、字をリーダーが受ける", () => {
    const L = LEADER_KEY(LINUX);
    const r = press(LINUX, [key("h"), L, key("h"), key("h")]);
    // 1 つ目の h はターミナルへ。L のあとの h は左へ移る葉（続けて押せる）なので、2 つ目の h もリーダー
    assert.equal(r.passed.length, 1);
    assert.equal(r.runs.length, 2);
  });
});

describe("近道（リーダーを通さずに 1 回で押せるキー）", () => {
  const cmd = (mac: boolean, k: KeyLike) => shortcutCommand(k, mac);

  it("Mac は Cmd のキー", () => {
    assert.deepEqual(cmd(MAC, key("d", "m", "KeyD")), {
      id: "pane.split",
      arg: "right",
    });
    assert.deepEqual(cmd(MAC, key("D", "ms", "KeyD")), {
      id: "pane.split",
      arg: "down",
    });
    assert.deepEqual(cmd(MAC, key("Enter", "ms")), { id: "pane.zoom" });
    assert.deepEqual(cmd(MAC, key("r", "m", "KeyR")), { id: "pane.resize" });
    assert.deepEqual(cmd(MAC, key("H", "ms", "KeyH")), {
      id: "clipboard.history",
    });
    assert.deepEqual(cmd(MAC, key("w", "m", "KeyW")), { id: "pane.close" });
    // Cmd+1〜9 は無い（ワークスペースは、リーダーの w の窓で選ぶ。#296）
    assert.equal(cmd(MAC, key("1", "m", "Digit1")), null);
    assert.equal(cmd(MAC, key("9", "m", "Digit9")), null);
    assert.equal(cmd(MAC, key("0", "m", "Digit0")) !== null, true);
  });

  it("Mac は表示の大きさの Cmd = + - 0。Shift 付きの + も受ける", () => {
    assert.deepEqual(cmd(MAC, key("=", "m", "Equal")), {
      id: "scale",
      arg: "in",
    });
    assert.deepEqual(cmd(MAC, key("+", "ms", "Equal")), {
      id: "scale",
      arg: "in",
    });
    assert.deepEqual(cmd(MAC, key("-", "m", "Minus")), {
      id: "scale",
      arg: "out",
    });
    assert.deepEqual(cmd(MAC, key("0", "m", "Digit0")), {
      id: "scale",
      arg: "reset",
    });
    assert.equal(cmd(MAC, key("_", "ms", "Minus")), null);
  });

  it("Linux は Ctrl+Shift+字。表示の大きさは Ctrl+= と Ctrl+0 だけで、Ctrl+- は無い", () => {
    assert.deepEqual(cmd(LINUX, key("D", "cs", "KeyD")), {
      id: "pane.split",
      arg: "right",
    });
    assert.deepEqual(cmd(LINUX, key("E", "cs", "KeyE")), {
      id: "pane.split",
      arg: "down",
    });
    assert.deepEqual(cmd(LINUX, key("M", "cs", "KeyM")), { id: "pane.zoom" });
    assert.deepEqual(cmd(LINUX, key("R", "cs", "KeyR")), { id: "pane.resize" });
    assert.deepEqual(cmd(LINUX, key("H", "cs", "KeyH")), {
      id: "clipboard.history",
    });
    assert.deepEqual(cmd(LINUX, key("=", "c", "Equal")), {
      id: "scale",
      arg: "in",
    });
    assert.deepEqual(cmd(LINUX, key("+", "cs", "Equal")), {
      id: "scale",
      arg: "in",
    });
    assert.deepEqual(cmd(LINUX, key("0", "c", "Digit0")), {
      id: "scale",
      arg: "reset",
    });
    assert.equal(cmd(LINUX, key("-", "c", "Minus")), null);
  });

  it("消したキー：Mac の Ctrl+Shift+M、Cmd+Option+矢印、Linux の Ctrl+Shift+矢印・Ctrl+-、Linux の Cmd+W と Ctrl+数字", () => {
    assert.equal(cmd(MAC, key("M", "cs", "KeyM")), null);
    assert.equal(cmd(MAC, key("ArrowLeft", "ma")), null);
    assert.equal(cmd(MAC, key("ArrowLeft", "cs")), null);
    assert.equal(cmd(LINUX, key("ArrowLeft", "cs")), null);
    assert.equal(cmd(LINUX, key("-", "c", "Minus")), null);
    assert.equal(cmd(LINUX, key("w", "m", "KeyW")), null);
    assert.deepEqual(cmd(LINUX, key("W", "cs", "KeyW")), {
      id: "workspace.switch",
    });
    assert.equal(cmd(LINUX, key("1", "c", "Digit1")), null);
    assert.equal(cmd(LINUX, key("1", "a", "Digit1")), null);
  });

  it("route：近道は受けて、コマンドを返す。押しっぱなしの繰り返しは、表示の大きさの + と - だけ", () => {
    const s = IDLE;
    const k = { ...key("d", "m", "KeyD"), repeat: true };
    const r = route(s, k, env(MAC));
    assert.equal(r.consume, true);
    assert.deepEqual(r.consume && r.repeat, false);
    const big = route(s, { ...key("=", "m", "Equal"), repeat: true }, env(MAC));
    assert.deepEqual(big.consume && big.repeat, true);
  });

  it("Cmd+W は、キーがペインにも向いていない所（入力欄など）では受けない", () => {
    const k = key("w", "m", "KeyW");
    assert.equal(route(IDLE, k, env(MAC, { inPane: true })).consume, true);
    assert.equal(route(IDLE, k, env(MAC, { inPane: false })).consume, false);
  });

  it("リサイズモードの中でも、Cmd+R（出る）は受ける", () => {
    const r = route(
      IDLE,
      key("r", "m", "KeyR"),
      env(MAC, { resizeMode: true }),
    );
    assert.deepEqual(r.consume && r.run, { id: "pane.resize" });
  });

  it("かな漢字変換中は受けない", () => {
    const k = { ...key("d", "m", "KeyD"), isComposing: true };
    assert.equal(route(IDLE, k, env(MAC)).consume, false);
  });
});

describe("案内の一覧（`?`）", () => {
  it("近道は、この OS のものだけを出す", () => {
    const mac = helpRows(MAC);
    const lin = helpRows(LINUX);
    const split = T("leader.pane.split.down");
    assert.equal(mac.find((r) => r.label === split)?.shortcut, "Cmd+Shift+D");
    assert.equal(lin.find((r) => r.label === split)?.shortcut, "Ctrl+Shift+E");
    // ペインを閉じる近道は Mac だけ（Linux には行も無い）
    const close = T("leader.pane.close");
    assert.equal(mac.find((r) => r.label === close)?.shortcut, "Cmd+W");
    assert.equal(
      lin.find((r) => r.label === close),
      undefined,
    );
    assert.equal(
      lin.find((r) => r.path.join(" ") === "v -")?.shortcut,
      undefined,
    );
    assert.equal(
      mac.find((r) => r.path.join(" ") === "w")?.shortcut,
      "Cmd+Shift+W",
    );
  });

  it("案内に出るキーは、すべて実際に受ける（表から作るので、ずれない）", () => {
    const L = LEADER_KEY(MAC);
    for (const { path, node } of treeLeaves(LEADER)) {
      if (node.type !== "leaf") continue;
      const first = node.keys[0];
      // 葉の最初のキーで動くか。`+` と大文字は Shift を伴う
      const press1 = (k: string): KeyLike =>
        k === "?" || k === "+" || /^[A-Z]$/.test(k) ? key(k, "s") : key(k);
      const seq = [
        L,
        ...path.slice(0, -1).map((k) => press1(k)),
        press1(first),
      ];
      const r = press(MAC, seq);
      assert.deepEqual(r.runs, [node.run], path.join(" "));
    }
  });
});

describe("keyspec", () => {
  it("近道の書き方を読み、修飾キーが多くても少なくても当たらない", () => {
    const s = parseSpec("Cmd+Shift+D");
    assert.equal(matchSpec(key("D", "ms", "KeyD"), s), true);
    assert.equal(matchSpec(key("d", "m", "KeyD"), s), false);
    assert.equal(matchSpec(key("D", "mas", "KeyD"), s), false);
    assert.equal(matchSpec(key("D", "cms", "KeyD"), s), false);
    assert.throws(() => parseSpec("Super+K"));
  });
});

describe("リーダーの中の字の当たり方", () => {
  const L = LEADER_KEY(LINUX);

  it("打った字（key）で探す。AZERTY の q（物理キーは KeyA）は、a の葉に当たらない", () => {
    const r = press(LINUX, [L, key("q", "", "KeyA")]);
    assert.deepEqual(r.runs, []);
    assert.equal(r.state.leader, null);
    // 同じ配列で、字が a なら（物理キーは KeyQ）a の葉
    assert.deepEqual(press(LINUX, [L, key("a", "", "KeyQ")]).runs, [
      { id: "tab.window" },
    ]);
  });

  it("かな漢字変換中など、字が分からないときだけ、物理キーで探す", () => {
    const ime = (code: string): KeyLike => ({
      ...key("Process", "", code),
      isComposing: true,
    });
    assert.deepEqual(press(LINUX, [L, key("i"), ime("KeyD")]).runs, [
      { id: "notice.dismiss" },
    ]);
    assert.deepEqual(press(LINUX, [L, ime("Digit1")]).runs, []);
  });
});

describe("リーダーの案内（menuRows）", () => {
  const keysOf = (path: string[], mac: boolean) =>
    menuRows(path, mac).map((r) => r.keys);

  it("Mac では表示の大きさのグループ（v）を案内に出さず、Linux では出す", () => {
    assert.equal(keysOf([], MAC).includes("v"), false);
    assert.equal(keysOf([], LINUX).includes("v"), true);
  });

  it("v の中の案内は、Linux では + - 0 の 3 行", () => {
    assert.deepEqual(
      menuRows(["v"], LINUX).map((r) => [r.keys, r.label]),
      [
        ["+ =", T("leader.scale.in")],
        ["-", T("leader.scale.out")],
        ["0", T("leader.scale.reset")],
      ],
    );
  });

  it("`?` の一覧（helpRows）には、どの OS でも v の 3 つが載る", () => {
    for (const mac of [MAC, LINUX]) {
      const paths = helpRows(mac).map((r) => r.path.join(" "));
      for (const p of ["v", "v + =", "v -", "v 0"])
        assert.ok(paths.includes(p), `${mac ? "Mac" : "Linux"} に ${p}`);
    }
  });

  it("t は、案内の板を持たない葉（#454）。旧 t の下のキーは、木にも `?` の一覧にも無い", () => {
    assert.equal(childrenAt(["t"]), undefined);
    assert.equal(
      helpRows(LINUX).some((r) => r.path[0] === "t" && r.path.length > 1),
      false,
    );
  });

  it("お知らせは i のグループ（#456）。a は無く、新しい版に更新する u がある。n の下には無い", () => {
    assert.deepEqual(keysOf(["i"], MAC), ["u", "d", "g", "o", "f"]);
    assert.equal(childrenAt(["n"]), undefined);
    for (const mac of [MAC, LINUX]) {
      // 旧 n u は、お知らせの操作を動かさない（n で窓を開いてリーダーを出るので、u はリーダーでは受けない）
      assert.deepEqual(press(mac, [LEADER_KEY(mac), key("n"), key("u")]).runs, [
        { id: "workspace.switch", arg: "newTab" },
      ]);
      assert.deepEqual(press(mac, [LEADER_KEY(mac), key("i"), key("u")]).runs, [
        { id: "notice.update" },
      ]);
    }
  });

  it("n は、ワークスペースの窓を、作るタブの種類を選ぶ間にして開く葉（#456）。種類ごとの作るキー（旧 o n・o N・d n）は木に無い", () => {
    for (const mac of [MAC, LINUX]) {
      const r = press(mac, [LEADER_KEY(mac), key("n")]);
      assert.deepEqual(r.runs, [{ id: "workspace.switch", arg: "newTab" }]);
      assert.equal(r.state.leader, null);
      // d n は何も動かさず、リーダーを出る
      const d = press(mac, [LEADER_KEY(mac), key("d"), key("n")]);
      assert.deepEqual(d.runs, []);
      assert.equal(d.state.leader, null);
    }
    const ids = (list: Node[]): string[] =>
      list.flatMap((n) => (n.type === "leaf" ? [n.run.id] : ids(n.children)));
    for (const id of ["browser.new", "browser.incognito", "db.open", "tab.new"])
      assert.equal(ids(LEADER).includes(id), false, id);
  });

  it("向きの hjkl は、案内では 1 行にまとまる", () => {
    const rows = (path: string[]) =>
      menuRows(path, LINUX).map((r) => [r.keys, r.label]);
    const move = ["h|j|k|l", T("leader.pane.focus.range")];
    assert.deepEqual(rows([]).slice(0, 2), [
      move,
      ["Tab", T("leader.pane.last")],
    ]);
    // 旧 p のグループ（分ける・入れ替える向き）は無い（#457）
    assert.deepEqual(rows(["p"]), []);
  });

  it("`?` の一覧でも、向きと番号の同種の操作は 1 行にまとまり、近道はどのキーのものかを添えて残る。押したときの動きは葉ごとで変わらない", () => {
    const rows = helpRows(MAC);
    const paths = rows.map((r) => r.path.join(" "));
    assert.ok(paths.includes("h|j|k|l"));
    for (const k of ["h", "j", "k", "l"]) assert.ok(!paths.includes(k), k);
    // 番号指定（1–9）の行は、#454 で t の下から無くなり、木のどこにも無い
    assert.ok(!paths.some((p) => /(^| )[1-9]$/.test(p)));
    // 案内（menuRows）と一覧（helpRows）で、まとめる行は同じ
    for (const p of [[], ["x"]]) {
      const menu = menuRows(p, MAC)
        .filter((r) => !r.group && /[|]/.test(r.keys))
        .map((r) => [...p, r.keys].join(" "));
      for (const m of menu) assert.ok(paths.includes(m), m);
    }
    assert.deepEqual(press(LINUX, [LEADER_KEY(LINUX), key("j")]).runs, [
      { id: "pane.focus", arg: "down" },
    ]);
  });

  it("t は、ワークスペースの窓を、右のタブの列にキーを置いて開く葉（#454）。後に押したキーは、リーダーでは受けない", () => {
    const r = press(LINUX, [LEADER_KEY(LINUX), key("t")]);
    assert.deepEqual(r.runs, [{ id: "workspace.switch", arg: "tab" }]);
    assert.equal(r.state.leader, null);
    // リーダーを出たあとの n は、リーダーの葉には当たらない（窓の中のキーとして扱われる）
    assert.deepEqual(
      press(LINUX, [LEADER_KEY(LINUX), key("t"), key("n")]).runs,
      [{ id: "workspace.switch", arg: "tab" }],
    );
  });

  it("m は、グループではなくマシンのダイアログを開く葉（中の操作はダイアログのキー）", () => {
    const r = press(LINUX, [LEADER_KEY(LINUX), key("m")]);
    assert.deepEqual(r.runs, [{ id: "machine.dialog" }]);
    assert.equal(r.state.leader, null);
    assert.equal(keysOf([], MAC).includes("m"), true);
  });
});

describe("リーダーの閉じ方（キャラクターが案内を押していくかの見分け）", () => {
  for (const [os, mac] of [
    ["mac", true],
    ["linux", false],
  ] as const) {
    const L = LEADER_KEY(mac);
    it(`${os}：Esc で出たときだけ escaped が付く`, () => {
      assert.equal(press(mac, [L, key("Escape")]).state.escaped, true);
      assert.equal(
        press(mac, [L, key("x"), key("Escape")]).state.escaped,
        true,
      );
    });
    it(`${os}：リーダーのキー・Backspace・一覧に無いキー・操作の実行で出たときは付かない`, () => {
      assert.notEqual(press(mac, [L, L]).state.escaped, true);
      assert.notEqual(press(mac, [L, key("Backspace")]).state.escaped, true);
      assert.notEqual(press(mac, [L, key("F13")]).state.escaped, true);
      assert.notEqual(press(mac, [L, key("y")]).state.escaped, true);
    });
  }
});

describe("内蔵ブラウザ（#202。設定で有効にしたときだけ）", () => {
  /** 木の外の、ブラウザのコマンドの id（並べた順） */
  const browserIds = () =>
    outsideLeaves()
      .filter((n) => n.run.id.startsWith("browser."))
      .map((n) => n.run.id);

  it("有効にしていなければ、ブラウザのコマンドは近道にも `?` の一覧にも無く、設定の近道にも書けない", () => {
    setBrowserEnabled(false);
    assert.deepEqual(browserIds(), []);
    assert.ok(
      !helpRows(MAC).some((r) => r.label === T("leader.browser.reload")),
    );
    // Cmd+R はリサイズモードのまま
    assert.deepEqual(
      press(MAC, [key("r", "m", "KeyR")], { browser: true }).runs,
      [{ id: "pane.resize" }],
    );
    assert.deepEqual(
      setUserShortcuts([{ key: "Ctrl+Alt+B", command: "browser.back" }], MAC),
      [
        `gui.shortcuts."Ctrl+Alt+B": ${T("shortcut.err.noCommand", { command: "browser.back" })}`,
      ],
    );
    setUserShortcuts([], MAC);
  });

  it("リーダーの o のグループは無い（#459。ページへの操作は、リーダーの a で開くブラウザのタブの窓の中のキー）", () => {
    for (const on of [false, true]) {
      setBrowserEnabled(on);
      assert.equal(childrenAt(["o"]), undefined);
      assert.ok(!helpRows(MAC).some((r) => r.path[0] === "o"));
      assert.ok(!menuRows([], MAC).some((r) => r.keys === "o"));
      for (const k of ["u", "h", "b", "B", "x", "R", "j"]) {
        const r = press(MAC, [
          LEADER_KEY(MAC),
          key("o"),
          key(k, /^[A-Z]$/.test(k) ? "s" : ""),
        ]);
        assert.deepEqual(r.runs, [], `o ${k}`);
        assert.equal(r.state.leader, null);
      }
    }
    setBrowserEnabled(false);
  });

  describe("有効にしたとき", () => {
    before(() => setBrowserEnabled(true));
    after(() => setBrowserEnabled(false));

    it("ブラウザのコマンドは、全部木の外（設定の近道だけ）にある。#459 までのリーダーの o の葉と、#456 までの o n・o N", () => {
      assert.deepEqual(browserIds(), [
        "browser.new",
        "browser.incognito",
        "browser.url",
        "browser.back",
        "browser.forward",
        "browser.reload",
        "browser.stop",
        "browser.close",
        "browser.external",
        "browser.bookmark",
        "browser.bookmarks",
        "browser.find",
        "browser.copyUrl",
        "browser.devtools",
        "browser.login",
        "browser.rename",
      ]);
      // 続けて押せるのは、戻る・進む
      const repeat = outsideLeaves()
        .filter((n) => n.run.id.startsWith("browser.") && n.repeat)
        .map((n) => n.run.id);
      assert.deepEqual(repeat, ["browser.back", "browser.forward"]);
      // `?` の一覧では、既定の近道を持つ読み込み直す・ページ内検索だけが、木のあとの「近道だけ」の行に出る
      const outside = helpRows(MAC).filter((r) => r.path.length === 0);
      for (const [label, shortcut] of [
        [T("leader.browser.reload"), "Cmd+R"],
        [T("leader.browser.find"), "Cmd+F"],
      ])
        assert.equal(
          outside.find((r) => r.label === label)?.shortcut,
          shortcut,
          label,
        );
      assert.ok(!outside.some((r) => r.label === T("leader.browser.back")));
    });

    it("設定の近道に、ブラウザのコマンド（閉じる・名前を変えるも）を書ける（#459 で木から外しても、書いた設定は壊れない）", () => {
      assert.deepEqual(
        setUserShortcuts(
          [
            { key: "Ctrl+Alt+B", command: "browser.bookmark" },
            { key: "Ctrl+Alt+H", command: "browser.back" },
            { key: "Ctrl+Alt+X", command: "browser.close" },
            { key: "Ctrl+Alt+R", command: "browser.rename" },
          ],
          LINUX,
        ),
        [],
      );
      assert.deepEqual(
        press(LINUX, [
          key("b", "ca"),
          key("h", "ca"),
          key("x", "ca"),
          key("r", "ca"),
        ]).runs,
        [
          { id: "browser.bookmark" },
          { id: "browser.back" },
          { id: "browser.close" },
          { id: "browser.rename" },
        ],
      );
      setUserShortcuts([], LINUX);
    });

    for (const mac of [MAC, LINUX]) {
      const os = mac ? "Mac" : "Linux";
      const R = mac ? key("r", "m", "KeyR") : key("R", "cs", "KeyR");

      it(`${os}：ブラウザを出している間だけ、Cmd+R / Ctrl+Shift+R は読み込み直す。ほかのときはリサイズモード`, () => {
        assert.deepEqual(press(mac, [R], { browser: true }).runs, [
          { id: "browser.reload" },
        ]);
        assert.deepEqual(press(mac, [R]).runs, [{ id: "pane.resize" }]);
        // リサイズモードの中は、出る（リサイズモードのキーを先にする）
        assert.deepEqual(
          press(mac, [R], { browser: true, resizeMode: true }).runs,
          [{ id: "pane.resize" }],
        );
        // リサイズモードを出るキーの判定（panes.ts）は、ブラウザの近道に取られない
        assert.equal(shortcutCommand(R, mac)?.id, "pane.resize");
      });

      it(`${os}：ブラウザを出している間だけ、${mac ? "Cmd+F" : "Ctrl+F"} はページ内検索（#205）。ほかのときはターミナルに届く`, () => {
        const F = mac ? key("f", "m", "KeyF") : key("f", "c", "KeyF");
        assert.deepEqual(press(mac, [F], { browser: true }).runs, [
          { id: "browser.find" },
        ]);
        const r = press(mac, [F]);
        assert.deepEqual(r.runs, []);
        assert.equal(r.passed.length, 1);
        // リサイズモードの中は受けない
        assert.deepEqual(
          press(mac, [F], { browser: true, resizeMode: true }).runs,
          [],
        );
        // ページにキーがある間も受ける
        assert.ok(
          interceptKeys(mac).some(
            (k) =>
              k.key === "f" && k.meta === mac && k.ctrl === !mac && !k.shift,
          ),
        );
      });
    }

    it("近道は、ブラウザを出しているときだけのものを除いて OS ごとに重ならない（ブラウザだけのものどうしも重ならない）", () => {
      for (const mac of [MAC, LINUX]) {
        for (const inBrowser of [false, true]) {
          const seen = new Map<string, string>();
          for (const { path, node } of leaves()) {
            if (node.type === "leaf" && !!node.shortcutInBrowser !== inBrowser)
              continue;
            if (node.type === "group") continue;
            const s = shortcutOn(node, mac);
            if (!s) continue;
            assert.equal(seen.has(s), false, `${s}（${path.join(" ")}）`);
            seen.set(s, path.join(" "));
          }
        }
      }
    });

    it("Linux で Ctrl 単独を使う近道は、ブラウザを出している間だけの Ctrl+F（ページ内検索）だけ", () => {
      for (const { node } of leaves()) {
        const s = shortcutOn(node, LINUX);
        if (
          !s ||
          /^Ctrl\+Shift\+[A-Z]$/.test(s) ||
          s === "Ctrl+=" ||
          s === "Ctrl+0"
        )
          continue;
        assert.equal(s, "Ctrl+F");
        assert.ok(node.type === "leaf" && node.shortcutInBrowser);
      }
    });

    it("ページに渡すキーは、リーダーとすべての近道（木の外の、ペインの近道も）。リーダーだけが、続くキーも受ける", () => {
      for (const mac of [MAC, LINUX]) {
        const keys = interceptKeys(mac);
        const has = (s: string, enter: boolean) =>
          keys.some(
            (k) =>
              JSON.stringify({ ...parseSpec(s), enter }) === JSON.stringify(k),
          );
        assert.ok(has(mac ? "Cmd+K" : "Ctrl+Shift+K", true));
        assert.ok(has(mac ? "Cmd+Shift+W" : "Ctrl+Shift+W", false));
        // 旧い入口の近道（#457 で無くした）は渡さない
        assert.ok(!has(mac ? "Cmd+Shift+P" : "Ctrl+Shift+P", true));
        assert.ok(!has(mac ? "Cmd+Shift+P" : "Ctrl+Shift+P", false));
        assert.ok(has(mac ? "Cmd+R" : "Ctrl+Shift+R", false));
        assert.ok(has(mac ? "Cmd+D" : "Ctrl+Shift+D", false));
        // Cmd+C・Cmd+V（ページのコピー・貼り付け）は渡さない
        assert.ok(!has(mac ? "Cmd+C" : "Ctrl+Shift+C", false));
        assert.ok(!has(mac ? "Cmd+V" : "Ctrl+Shift+V", false));
      }
    });
  });
});

describe("設定で足す近道（[gui.shortcuts]）", () => {
  after(() => setUserShortcuts([], LINUX));

  it("まとめた行（h|j|k|l）に設定の近道を足すと、近道 1 つずつに、どのキーのものかが付く", () => {
    assert.deepEqual(
      setUserShortcuts(
        [
          { key: "Ctrl+Alt+J", command: "pane.focus:down" },
          { key: "Ctrl+Alt+H", command: "pane.focus:left" },
        ],
        LINUX,
      ),
      [],
    );
    const row = helpRows(LINUX).find((r) => r.path.join(" ") === "h|j|k|l");
    assert.equal(row?.shortcut, "Ctrl+Alt+H (h), Ctrl+Alt+J (j)");
  });

  it("木の外のペインの操作（#457）は、設定の近道に足せる。既定の近道のある行には並べて出し、無いものは行が増える", () => {
    assert.deepEqual(
      setUserShortcuts(
        [
          { key: "Ctrl+Alt+J", command: "pane.split:down" },
          { key: "Ctrl+Alt+H", command: "pane.split:left" },
          { key: "Ctrl+Alt+S", command: "pane.swap:right" },
          { key: "Ctrl+Alt+A", command: "tab.window" },
        ],
        LINUX,
      ),
      [],
    );
    assert.deepEqual(
      press(LINUX, [key("h", "ca"), key("s", "ca"), key("a", "ca")]).runs,
      [
        { id: "pane.split", arg: "left" },
        { id: "pane.swap", arg: "right" },
        { id: "tab.window" },
      ],
    );
    const rows = helpRows(LINUX);
    const of = (label: string) => rows.find((r) => r.label === label)?.shortcut;
    assert.equal(of(T("leader.pane.split.down")), "Ctrl+Shift+E, Ctrl+Alt+J");
    assert.equal(of(T("leader.pane.split.left")), "Ctrl+Alt+H");
    assert.equal(of(T("leader.pane.swap.right")), "Ctrl+Alt+S");
    assert.equal(of(T("leader.pane.swap.left")), undefined);
    // 木の葉（a）に足した近道は、その行に出る
    assert.equal(
      rows.find((r) => r.path.join(" ") === "a")?.shortcut,
      "Ctrl+Alt+A",
    );
  });

  it("書いたキーでコマンドを動かし、引数も渡せる。ターミナルに届かない", () => {
    const problems = setUserShortcuts(
      [
        { key: "ctrl+alt+n", command: "workspace.new" },
        { key: "Alt+J", command: "pane.focus:down" },
        { key: "Ctrl++", command: "scale:in" },
      ],
      LINUX,
    );
    assert.deepEqual(problems, []);
    const r = press(LINUX, [key("n", "ca"), key("j", "a"), key("+", "c")]);
    assert.deepEqual(r.runs, [
      { id: "workspace.new" },
      { id: "pane.focus", arg: "down" },
      { id: "scale", arg: "in" },
    ]);
    assert.equal(r.passed.length, 0);
    // 足していないキーは今までどおりターミナルに届く
    assert.equal(press(LINUX, [key("j", "")]).passed.length, 1);
  });

  it("リーダーの木に無いワークスペースのコマンド（#296）も、近道に足せる（引数つきも）。`?` の一覧では、w の下ではなく、最後の近道だけの操作に並ぶ", () => {
    const problems = setUserShortcuts(
      [
        { key: "Ctrl+Alt+1", command: "workspace.nth:0" },
        { key: "Ctrl+Alt+J", command: "workspace.step:next" },
        { key: "Ctrl+Alt+K", command: "workspace.move:up" },
        { key: "Ctrl+Alt+L", command: "workspace.last" },
        { key: "Ctrl+Alt+X", command: "workspace.close" },
        { key: "Ctrl+Alt+R", command: "workspace.rename" },
      ],
      LINUX,
    );
    assert.deepEqual(problems, []);
    const r = press(LINUX, [
      key("1", "ca"),
      key("j", "ca"),
      key("k", "ca"),
      key("l", "ca"),
      key("x", "ca"),
      key("r", "ca"),
    ]);
    assert.deepEqual(r.runs, [
      { id: "workspace.nth", arg: 0 },
      { id: "workspace.step", arg: "next" },
      { id: "workspace.move", arg: "up" },
      { id: "workspace.last" },
      { id: "workspace.close" },
      { id: "workspace.rename" },
    ]);
    const rows = helpRows(LINUX);
    assert.ok(!rows.some((r) => r.path[0] === "w" && r.path.length > 1));
    assert.equal(
      rows.find((r) => r.label === T("leader.ws.close"))?.shortcut,
      "Ctrl+Alt+X",
    );
  });

  it("同じキーの既定の近道に勝ち、none なら既定の近道を消すだけ", () => {
    assert.deepEqual(
      setUserShortcuts(
        [
          { key: "Ctrl+Shift+D", command: "pane.close" },
          { key: "Ctrl+Shift+E", command: "none" },
        ],
        LINUX,
      ),
      [],
    );
    assert.deepEqual(press(LINUX, [key("D", "cs")]).runs, [
      { id: "pane.close" },
    ]);
    assert.equal(press(LINUX, [key("E", "cs")]).passed.length, 1);
    // `?` の一覧：消した・奪われた既定の近道は出ず、足した近道は最初の行に出る
    const rows = helpRows(LINUX);
    const of = (label: string) => rows.find((r) => r.label === label);
    assert.equal(of(T("leader.pane.split.right")), undefined);
    assert.equal(of(T("leader.pane.split.down")), undefined);
    assert.equal(of(T("leader.pane.close"))?.shortcut, "Ctrl+Shift+D");
  });

  it("間違いは理由を返し、ほかの近道は使う", () => {
    const problems = setUserShortcuts(
      [
        { key: "Ctrl+Alt+X", command: "nothing.here" },
        { key: "Hyper+X", command: "workspace.new" },
        { key: "j", command: "workspace.new" },
        { key: "Ctrl+Shift+K", command: "workspace.new" },
        { key: "Ctrl+Alt+B", command: "browser.new" },
        { key: "Ctrl+Alt+Y", command: "clipboard.history" },
      ],
      LINUX,
    );
    assert.equal(problems.length, 5);
    assert.match(problems[0], /nothing\.here/);
    assert.match(problems[1], /Hyper/);
    assert.ok(problems[3].endsWith(T("shortcut.err.leader")));
    // 内蔵ブラウザを使わないときは、browser.* は使えない
    assert.match(problems[4], /browser\.new/);
    assert.deepEqual(press(LINUX, [key("y", "ca")]).runs, [
      { id: "clipboard.history" },
    ]);
  });

  it("キーの名前は大文字小文字を問わず受け、無い名前は間違いにする", () => {
    const problems = setUserShortcuts(
      [
        { key: "Ctrl+Alt+enter", command: "workspace.new" },
        { key: "Ctrl+Alt+Left", command: "pane.focus:left" },
        { key: "Ctrl+Alt+Foo", command: "workspace.new" },
      ],
      LINUX,
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /Foo/);
    const r = press(LINUX, [key("Enter", "ca"), key("ArrowLeft", "ca")]);
    assert.deepEqual(r.runs, [
      { id: "workspace.new" },
      { id: "pane.focus", arg: "left" },
    ]);
  });

  it("同じキーを別の書き方で 2 つのファイルに書いたら、後のファイルが勝つ。同じファイルなら間違い", () => {
    const problems = setUserShortcuts(
      [
        { key: "Ctrl+Alt+N", command: "workspace.new", source: 0 },
        { key: "ctrl+alt+n", command: "workspace.close", source: 1 },
        { key: "Ctrl+Alt+M", command: "workspace.new", source: 0 },
        { key: "control+alt+m", command: "workspace.close", source: 0 },
      ],
      LINUX,
    );
    assert.equal(problems.length, 1);
    assert.deepEqual(press(LINUX, [key("n", "ca")]).runs, [
      { id: "workspace.close" },
    ]);
    assert.deepEqual(press(LINUX, [key("m", "ca")]).runs, [
      { id: "workspace.new" },
    ]);
  });

  it("木から外したタブを作るコマンド（#456。旧 o n・o N・d n）も、近道に足せる。browser.* は、内蔵ブラウザが有効なときだけ", () => {
    const list = [
      { key: "Ctrl+Alt+D", command: "db.open" },
      { key: "Ctrl+Alt+B", command: "browser.new" },
      { key: "Ctrl+Alt+I", command: "browser.incognito" },
      { key: "Ctrl+Alt+N", command: "workspace.switch:newTab" },
    ];
    const off = setUserShortcuts(list, LINUX);
    assert.equal(off.length, 2);
    assert.match(off[0], /browser\.new/);
    assert.match(off[1], /browser\.incognito/);
    assert.deepEqual(press(LINUX, [key("d", "ca"), key("n", "ca")]).runs, [
      { id: "db.open" },
      { id: "workspace.switch", arg: "newTab" },
    ]);
    setBrowserEnabled(true);
    try {
      assert.deepEqual(setUserShortcuts(list, LINUX), []);
      assert.deepEqual(press(LINUX, [key("b", "ca"), key("i", "ca")]).runs, [
        { id: "browser.new" },
        { id: "browser.incognito" },
      ]);
    } finally {
      setBrowserEnabled(false);
    }
  });

  it("ページに渡すキーに入る", () => {
    setUserShortcuts([{ key: "Ctrl+Alt+N", command: "workspace.new" }], LINUX);
    assert.ok(
      interceptKeys(LINUX).some(
        (k) => k.ctrl && k.alt && k.key === "n" && !k.enter,
      ),
    );
  });
});
