import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  afterKeyUp,
  childrenAt,
  helpRows,
  IDLE,
  LEADER,
  leaderKeyName,
  menuRows,
  route,
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

function leaves(
  list: Node[] = LEADER,
  path: string[] = [],
): { path: string[]; node: Node }[] {
  return list.flatMap((n) => [
    { path: [...path, n.type === "group" ? n.key : n.keys[0]], node: n },
    ...(n.type === "group" ? leaves(n.children, [...path, n.key]) : []),
  ]);
}

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
        const s = mac ? node.shortcut?.mac : node.shortcut?.other;
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
      const s = node.shortcut?.other;
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
      "h",
      "j",
      "k",
      "l",
      "Tab",
      "w",
      "w j",
      "w k",
      "w h",
      "w l",
      "w Tab",
      ...Array.from({ length: 9 }, (_, i) => `w ${i + 1}`),
      "w n",
      "w x",
      "w r",
      "m",
      "m a",
      "m n",
      "m d",
      "m x",
      "m r",
      "p",
      "p h",
      "p j",
      "p k",
      "p l",
      "p s",
      "p s h",
      "p s j",
      "p s k",
      "p s l",
      "p m",
      "p m h",
      "p m j",
      "p m k",
      "p m l",
      "p x",
      "p z",
      "p r",
      "b",
      "y",
      "v",
      "v + =",
      "v -",
      "v 0",
      "n",
      "n u",
      "n d",
      "n g",
      "?",
    ]);
  });

  it("#88 のキー（w j/k はワークスペース、w h/l はマシン）は続けて押せて、近道は無い", () => {
    const w = childrenAt(["w"]) ?? [];
    const find = (k: string) =>
      w.find((n) => n.type === "leaf" && n.keys.includes(k));
    for (const [k, id, arg] of [
      ["j", "workspace.step", "next"],
      ["k", "workspace.step", "prev"],
      ["h", "machine.step", "prev"],
      ["l", "machine.step", "next"],
    ] as const) {
      const n = find(k);
      assert.ok(n && n.type === "leaf", k);
      assert.deepEqual(n.run, { id, arg });
      assert.equal(n.repeat, true);
      assert.equal(n.shortcut, undefined);
    }
  });
});

describe("リーダー", () => {
  for (const mac of [MAC, LINUX]) {
    const L = LEADER_KEY(mac);
    const os = mac ? "Mac" : "Linux";

    it(`${os}：リーダーを押すと入り、次のキーで動き、行ったら出る`, () => {
      const r = press(mac, [L, key("p"), key("s"), key("l")]);
      assert.deepEqual(r.runs, [{ id: "pane.split", arg: "right" }]);
      assert.equal(r.state.leader, null);
      assert.deepEqual(r.passed, []);
    });

    it(`${os}：p m のあとに h j k l で、ペインを隣と入れ替える`, () => {
      for (const [k, dir] of [
        ["h", "left"],
        ["j", "down"],
        ["k", "up"],
        ["l", "right"],
      ] as const) {
        const r = press(mac, [L, key("p"), key("m"), key(k)]);
        assert.deepEqual(r.runs, [{ id: "pane.swap", arg: dir }]);
        assert.equal(r.state.leader, null);
        assert.deepEqual(r.passed, []);
      }
      assert.deepEqual(press(mac, [L, key("p"), key("m")]).state.leader, [
        "p",
        "m",
      ]);
    });

    it(`${os}：グループに入ると、案内の位置が一段下がる`, () => {
      assert.deepEqual(press(mac, [L]).state.leader, []);
      assert.deepEqual(press(mac, [L, key("w")]).state.leader, ["w"]);
      assert.deepEqual(press(mac, [L, key("w"), key("1")]).runs, [
        { id: "workspace.nth", arg: 0 },
      ]);
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
        press(mac, [L, key("p"), key("Backspace")]).state.leader,
        [],
      );
      assert.equal(press(mac, [L, key("Backspace")]).state.leader, null);
    });

    it(`${os}：リーダーのキーをもう 1 度押しても出る`, () => {
      assert.equal(press(mac, [L, L]).state.leader, null);
      assert.equal(press(mac, [L, key("p"), L]).state.leader, null);
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
      for (const k of [L, key("x")]) s = route(s, k, env(mac)).state;
      // L のあとは [] の位置なので x は一覧に無い。出て、swallow になる
      const rep = route(s, { ...key("x"), repeat: true }, env(mac));
      assert.equal(rep.consume, true);
      const up = afterKeyUp(rep.state);
      assert.equal(route(up, key("x"), env(mac)).consume, false);
      // 押し直せば（repeat でない）、keyup が無くても解ける
      assert.equal(route(rep.state, key("x"), env(mac)).consume, false);
    });
  }

  it("入口の近道（Mac は Cmd+Shift+W / P、Linux は Ctrl+Shift+W / P）で、グループに 1 回で入る", () => {
    const w = press(MAC, [key("W", "ms", "KeyW")]);
    assert.deepEqual(w.state.leader, ["w"]);
    assert.deepEqual(press(LINUX, [key("P", "cs", "KeyP")]).state.leader, [
      "p",
    ]);
    // 入ったあとは、その一覧のキーで動く
    assert.deepEqual(
      press(LINUX, [key("P", "cs", "KeyP"), key("s"), key("j")]).runs,
      [{ id: "pane.split", arg: "down" }],
    );
    // Backspace で 1 段目の一覧に戻る
    assert.deepEqual(
      press(MAC, [key("W", "ms", "KeyW"), key("Backspace")]).state.leader,
      [],
    );
    // ダイアログの間は入らない
    assert.equal(
      press(MAC, [key("W", "ms", "KeyW")], { dialogOpen: true }).state.leader,
      null,
    );
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
    assert.deepEqual(cmd(MAC, key("1", "m", "Digit1")), {
      id: "workspace.nth",
      arg: 0,
    });
    assert.deepEqual(cmd(MAC, key("9", "m", "Digit9")), {
      id: "workspace.nth",
      arg: 8,
    });
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
    assert.equal(
      cmd(LINUX, key("W", "cs", "KeyW")),
      null,
      "Ctrl+Shift+W はグループの入口で、コマンドではない",
    );
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
    assert.equal(
      mac.find((r) => r.path.join(" ") === "p s l")?.shortcut,
      "Cmd+D",
    );
    assert.equal(
      lin.find((r) => r.path.join(" ") === "p s l")?.shortcut,
      "Ctrl+Shift+D",
    );
    assert.equal(
      lin.find((r) => r.path.join(" ") === "p x")?.shortcut,
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
    for (const { path, node } of leaves()) {
      if (node.type !== "leaf") continue;
      const first = node.keys[0];
      // 葉の最初のキーで動くか。`+` は Shift を伴うことがある
      const press1 = (k: string): KeyLike =>
        k === "?" || k === "+" ? key(k, "s") : key(k);
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
    const r = press(LINUX, [L, key("m"), key("q", "", "KeyA")]);
    assert.deepEqual(r.runs, []);
    assert.equal(r.state.leader, null);
    // 同じ配列で、字が a なら（物理キーは KeyQ）a の葉
    assert.deepEqual(press(LINUX, [L, key("m"), key("a", "", "KeyQ")]).runs, [
      { id: "machine.add" },
    ]);
  });

  it("かな漢字変換中など、字が分からないときだけ、物理キーで探す", () => {
    const ime = (code: string): KeyLike => ({
      ...key("Process", "", code),
      isComposing: true,
    });
    assert.deepEqual(press(LINUX, [L, key("m"), ime("KeyA")]).runs, [
      { id: "machine.add" },
    ]);
    assert.deepEqual(press(LINUX, [L, ime("Digit1")]).runs, []);
    assert.deepEqual(press(LINUX, [L, key("w"), ime("Digit1")]).runs, [
      { id: "workspace.nth", arg: 0 },
    ]);
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
        ["+ =", "大きくする"],
        ["-", "小さくする"],
        ["0", "元の大きさに戻す"],
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

  it("w の中の 1〜9 は、案内では 1 行にまとまり、`?` の一覧では 9 行ある", () => {
    const rows = menuRows(["w"], LINUX);
    assert.deepEqual(
      rows.filter((r) => /^[1-9]/.test(r.keys)),
      [{ keys: "1–9", label: "上から N 番目へ", group: false }],
    );
    assert.equal(
      helpRows(LINUX).filter((r) => /^w [1-9]$/.test(r.path.join(" "))).length,
      9,
    );
  });

  it("お知らせの n に a は無く、新しい版に更新する u がある", () => {
    assert.deepEqual(keysOf(["n"], MAC), ["u", "d", "g"]);
  });

  it("向きの hjkl は、案内では 1 行（ワークスペースは 2 行）にまとまる", () => {
    const rows = (path: string[]) =>
      menuRows(path, LINUX).map((r) => [r.keys, r.label]);
    const move = ["h|j|k|l", "ペインを移動"];
    assert.deepEqual(rows([]).slice(0, 2), [move, ["Tab", "直前のペインへ"]]);
    assert.deepEqual(rows(["p"]).slice(0, 1), [move]);
    assert.deepEqual(rows(["p", "s"]), [["h|j|k|l", "向きを選んで分ける"]]);
    assert.deepEqual(rows(["p", "m"]), [["h|j|k|l", "向きを選んで入れ替える"]]);
    assert.deepEqual(rows(["w"]).slice(0, 3), [
      ["j|k", "ワークスペースを移動"],
      ["h|l", "マシンを移動"],
      ["Tab", "直前のワークスペースへ"],
    ]);
  });

  it("まとめても、`?` の一覧と近道には hjkl が 1 つずつ残り、押したときの動きは変わらない", () => {
    const rows = helpRows(MAC);
    const paths = rows.map((r) => r.path.join(" "));
    for (const g of ["", "p ", "p s ", "p m ", "w "])
      for (const k of ["h", "j", "k", "l"])
        assert.ok(paths.includes(g + k), g + k);
    assert.match(
      JSON.stringify(rows.find((r) => r.path.join(" ") === "p s l")),
      /Cmd\+D/,
    );
    assert.deepEqual(
      press(LINUX, [LEADER_KEY(LINUX), key("p"), key("s"), key("j")]).runs,
      [{ id: "pane.split", arg: "down" }],
    );
    assert.deepEqual(
      press(LINUX, [LEADER_KEY(LINUX), key("p"), key("m"), key("h")]).runs,
      [{ id: "pane.swap", arg: "left" }],
    );
    assert.deepEqual(
      press(LINUX, [LEADER_KEY(LINUX), key("w"), key("l")]).runs,
      [{ id: "machine.step", arg: "next" }],
    );
  });

  it("葉と範囲の無いグループは、木のとおりに並ぶ", () => {
    assert.deepEqual(keysOf(["m"], MAC), ["a", "n", "d", "x", "r"]);
  });
});
