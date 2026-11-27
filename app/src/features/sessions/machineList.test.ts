import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canDo,
  creatableRows,
  keepRow,
  machineKey,
  machineRows,
  moveRow,
  pickerKey,
  type MachineRow,
} from "./machineList.ts";
import type { MachineGroup } from "../workspaces/rows.ts";
import { statusLine } from "./status.ts";
import { setLang } from "../../i18n/index.ts";

// 日本語の文で確かめる（画面の言葉の既定は英語）
setLang("ja");

const ev = (key: string, extra: object = {}) => ({
  key,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  ...extra,
});

const group = (over: Partial<MachineGroup>): MachineGroup => ({
  target: "dev",
  label: "dev",
  removable: true,
  fixed: false,
  color: "#fff",
  health: "up",
  bands: [],
  ...over,
});

const row = (over: Partial<MachineRow> = {}): MachineRow => ({
  target: "dev",
  label: "dev",
  health: "up",
  status: "つながっています",
  title: "",
  terminalTabs: 0,
  removable: true,
  fixed: false,
  hasSession: true,
  ...over,
});

describe("machineRows", () => {
  it("ワークスペースが無いマシンと、つながっていないマシンも、数と状態を持って並ぶ", () => {
    const rows = machineRows(
      [
        group({ target: "local", label: "ローカル", removable: false }),
        group({ target: "a", label: "a", health: "down" }),
      ],
      (t) =>
        t === "a"
          ? { text: "つながりません", title: "boom", retry: "again" }
          : statusLine(undefined),
      (t) => t === "local",
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0].status, "つながっています");
    assert.equal(rows[0].terminalTabs, 0);
    assert.equal(rows[1].status, "つながりません");
    assert.equal(rows[1].title, "boom");
    assert.equal(rows[1].retry, "again");
    assert.equal(rows[1].hasSession, false);
  });

  it("状態の文が空でつながっていなければ、「つながっていません」", () => {
    const [r] = machineRows(
      [group({ health: "down" })],
      () => ({ text: "", title: "" }),
      () => false,
    );
    assert.equal(r.status, "つながっていません");
  });
});

describe("machineKey", () => {
  it("操作のキー", () => {
    for (const [k, action] of [
      ["a", "add"],
      ["n", "rename"],
      ["d", "remove"],
      ["x", "disconnect"],
      ["r", "reconnect"],
      ["t", "terminal"],
      ["p", "grant"],
    ] as const)
      assert.deepEqual(machineKey(ev(k)), { kind: "action", action });
    // P（Shift+p）は、時間の前に終える
    assert.deepEqual(machineKey(ev("P", { shiftKey: true })), {
      kind: "action",
      action: "grantEnd",
    });
  });

  it("移るキー（j k / 矢印 / Ctrl+J Ctrl+K / g G）", () => {
    assert.deepEqual(machineKey(ev("j")), { kind: "move", to: "next" });
    assert.deepEqual(machineKey(ev("ArrowUp")), { kind: "move", to: "prev" });
    assert.deepEqual(machineKey(ev("j", { ctrlKey: true })), {
      kind: "move",
      to: "next",
    });
    assert.deepEqual(machineKey(ev("g")), { kind: "move", to: "first" });
    assert.deepEqual(machineKey(ev("G", { shiftKey: true })), {
      kind: "move",
      to: "last",
    });
  });

  it("Enter はタブ作成を始める（#461）。修飾キーを重ねた Enter と、変換を確定する Enter は受けない", () => {
    assert.deepEqual(machineKey(ev("Enter")), {
      kind: "action",
      action: "newTab",
    });
    for (const extra of [
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { shiftKey: true },
      { isComposing: true },
      // macOS で変換を確定する Enter（isComposing が false で keyCode が 229）
      { keyCode: 229 },
    ])
      assert.equal(machineKey(ev("Enter", extra)), null);
  });

  it("? は一覧。修飾キーを重ねたもの・変換中は受けない", () => {
    assert.deepEqual(machineKey(ev("?", { shiftKey: true })), { kind: "help" });
    for (const extra of [
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { isComposing: true },
    ])
      assert.equal(machineKey(ev("r", extra)), null);
    assert.equal(machineKey(ev("z")), null);
  });
});

describe("moveRow・keepRow", () => {
  it("端で止まる", () => {
    assert.equal(moveRow(0, "prev", 3), 0);
    assert.equal(moveRow(2, "next", 3), 2);
    assert.equal(moveRow(1, "first", 3), 0);
    assert.equal(moveRow(1, "last", 3), 2);
    assert.equal(moveRow(0, "next", 0), 0);
  });

  it("消えた行は、元の位置（端なら 1 つ前）に選び直す", () => {
    const rows = [{ target: "a" }, { target: "b" }];
    assert.equal(keepRow(rows, "b", 0), 1);
    assert.equal(keepRow(rows, "gone", 5), 1);
    assert.equal(keepRow([], "gone", 0), 0);
  });
});

describe("canDo", () => {
  it("config.toml で決めたマシンと「ローカル」は、名前を変えられず外せない", () => {
    for (const a of ["rename", "remove"] as const) {
      assert.match(canDo(row({ fixed: true }), a, true) ?? "", /config\.toml/);
      assert.match(canDo(row({ removable: false }), a, true) ?? "", /ローカル/);
      assert.equal(canDo(row(), a, true), null);
    }
  });

  it("ターミナルの始め方は、「ローカル」でも変えられる（[server] に書く）。config.toml で決めたマシンは変えられない", () => {
    assert.equal(canDo(row(), "terminal", true), null);
    assert.equal(canDo(row({ removable: false }), "terminal", true), null);
    // つながっていなくても、設定は変えられる
    assert.equal(canDo(row({ health: "down" }), "terminal", false), null);
    assert.match(
      canDo(row({ fixed: true }), "terminal", true) ?? "",
      /config\.toml/,
    );
  });

  it("手元の PC のペインの操作を許す相手は、ssh 先のマシン。途中で終えられるのは、許している間だけ", () => {
    assert.equal(canDo(row(), "grant", true), null);
    assert.equal(canDo(row({ fixed: true }), "grant", true), null);
    assert.equal(canDo(row({ health: "down" }), "grant", false), null);
    assert.notEqual(canDo(row({ removable: false }), "grant", true), null);
    // もう許していても、許し直せる（時間を数え直す）
    assert.equal(canDo(row({ grant: "5m" }), "grant", true), null);
    assert.equal(canDo(row({ grant: "5m" }), "grantEnd", true), null);
    assert.notEqual(canDo(row(), "grantEnd", true), null);
  });

  it("許している間は、行に残りの時間が入る", () => {
    const rows = machineRows(
      [group({})],
      () => ({ text: "", title: "" }),
      () => true,
      (t) => (t === group({}).target ? "12m" : undefined),
    );
    assert.equal(rows[0].grant, "12m");
    assert.equal(
      machineRows(
        [group({})],
        () => ({ text: "", title: "" }),
        () => true,
      )[0].grant,
      undefined,
    );
  });

  it("config.toml で決めたマシンでも、切る・つなぎ直すはできる", () => {
    assert.equal(canDo(row({ fixed: true }), "disconnect", true), null);
    assert.equal(
      canDo(
        row({ fixed: true, health: "down", retry: "again" }),
        "reconnect",
        true,
      ),
      null,
    );
  });

  it("切れるのは、足したマシンで、つないでいるものだけ", () => {
    assert.ok(canDo(row({ removable: false }), "disconnect", true));
    assert.ok(canDo(row({ hasSession: false }), "disconnect", true));
  });

  it("タブ作成を始められるのは、つながっているマシンで、今のワークスペースがあるときだけ（#461）", () => {
    assert.equal(canDo(row(), "newTab", true), null);
    assert.equal(
      canDo(row({ removable: false, fixed: true }), "newTab", true),
      null,
    );
    // r でつなぎ直せるときは r を案内する
    for (const retry of ["now", "again"] as const) {
      const why = canDo(
        row({ health: "down", retry, label: "devbox" }),
        "newTab",
        true,
      );
      assert.match(why ?? "", /devbox はつながっていない/);
      assert.match(why ?? "", /r でつなぎ直せます/);
    }
    // つないでいる最中・待つだけのとき（r も断られる）は、r を案内しない
    for (const health of ["down", "pending"] as const) {
      const why = canDo(row({ health, label: "devbox" }), "newTab", true);
      assert.match(why ?? "", /devbox は今つないでいる最中/);
      assert.doesNotMatch(why ?? "", /r で/);
    }
    assert.match(
      canDo(row(), "newTab", false) ?? "",
      /ワークスペースがありません/,
    );
    // つながっていないことを先に出す（つながっても、ワークスペースが無ければ次の理由が出る）
    assert.match(
      canDo(row({ health: "down", retry: "again" }), "newTab", false) ?? "",
      /つながっていない/,
    );
  });

  it("つなぎ直すのは、待ち時間中・失敗・引き継がれたあとだけ", () => {
    assert.ok(canDo(row(), "reconnect", true));
    assert.equal(canDo(row({ retry: "now" }), "reconnect", true), null);
  });
});

describe("pickerKey / creatableRows（ワークスペースを作るマシンを選ぶ Dialog）", () => {
  it("Enter で決め、j k g G・矢印で動かす。修飾キーを重ねた Enter と変換中は受けない", () => {
    assert.deepEqual(pickerKey(ev("Enter")), { kind: "choose" });
    assert.deepEqual(pickerKey(ev("j")), { kind: "move", to: "next" });
    assert.deepEqual(pickerKey(ev("ArrowUp")), { kind: "move", to: "prev" });
    assert.equal(pickerKey(ev("Enter", { shiftKey: true })), null);
    assert.equal(pickerKey(ev("Enter", { ctrlKey: true })), null);
    assert.equal(pickerKey(ev("Enter", { isComposing: true })), null);
    // マシンのダイアログの操作（足す・外すなど）は、この Dialog では受けない
    assert.equal(pickerKey(ev("a")), null);
    assert.equal(pickerKey(ev("d")), null);
  });

  it("`?` で、キーの一覧を出す（Ctrl を重ねたものは受けない）", () => {
    assert.deepEqual(pickerKey(ev("?", { shiftKey: true })), { kind: "help" });
    assert.equal(pickerKey(ev("?", { ctrlKey: true })), null);
  });

  it("作れるのは、つながっているマシンだけ", () => {
    const rows = [
      row({ target: "a", health: "up" }),
      row({ target: "b", health: "down" }),
      row({ target: "c", health: "pending" }),
    ];
    assert.deepEqual(
      creatableRows(rows).map((r) => r.target),
      ["a"],
    );
  });
});
