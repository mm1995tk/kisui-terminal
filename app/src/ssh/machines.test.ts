import assert from "node:assert/strict";
import { test } from "node:test";

import { LOCAL } from "./api.ts";
import {
  addMachine,
  filterCandidates,
  labelOf,
  LEGACY_KEY,
  loadMachines,
  mergeMachines,
  recordToSave,
  MACHINES_KEY,
  removeMachine,
  renameMachine,
  saveMachines,
  targetProblem,
  type KeyValueStore,
  type Machine,
} from "./machines.ts";

function mem(init: Record<string, string> = {}): KeyValueStore & {
  m: Map<string, string>;
} {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
  };
}

test("記録が無い・壊れている・store が無いときは空", () => {
  assert.deepEqual(loadMachines(mem()), []);
  assert.deepEqual(loadMachines(mem({ [MACHINES_KEY]: "{" })), []);
  assert.deepEqual(loadMachines(mem({ [MACHINES_KEY]: '{"a":1}' })), []);
  assert.deepEqual(loadMachines(undefined), []);
});

test("保存して読み戻せる。使えない行き先と重なりは捨てる", () => {
  const s = mem();
  saveMachines(s, [{ target: "dev", name: "開発" }, { target: "db" }]);
  assert.deepEqual(loadMachines(s), [
    { target: "dev", name: "開発" },
    { target: "db" },
  ]);
  const raw = JSON.stringify([
    { target: "a" },
    { target: "a", name: "x" },
    { target: "-oProxyCommand=x" },
    { target: LOCAL },
    { target: 1 },
    "b",
  ]);
  assert.deepEqual(loadMachines(mem({ [MACHINES_KEY]: raw })), [
    { target: "a" },
  ]);
});

test("足したマシンの記録が無いときだけ、以前の記録を引き継ぐ", () => {
  const legacy = JSON.stringify([LOCAL, "dev", "-x", "db"]);
  assert.deepEqual(loadMachines(mem({ [LEGACY_KEY]: legacy })), [
    { target: "dev" },
    { target: "db" },
  ]);
  // 足したマシンの記録があれば（空でも）それを使う
  assert.deepEqual(
    loadMachines(mem({ [LEGACY_KEY]: legacy, [MACHINES_KEY]: "[]" })),
    [],
  );
});

test("行き先の確かめ", () => {
  assert.equal(targetProblem("dev"), undefined);
  assert.equal(targetProblem("user@host.example"), undefined);
  for (const bad of ["", LOCAL, "-oProxyCommand=x", "@x", "a b", "a\nb"]) {
    assert.notEqual(targetProblem(bad), undefined, JSON.stringify(bad));
  }
});

test("足す：前後の空白を除き、名前は空なら付けない", () => {
  const r = addMachine([], "  dev ", "  ");
  assert.deepEqual(r, { machines: [{ target: "dev" }] });
  const r2 = addMachine([{ target: "dev" }], "db", " DB ");
  assert.deepEqual(r2, {
    machines: [{ target: "dev" }, { target: "db", name: "DB" }],
  });
});

test("足す：同じ行き先・使えない行き先・名前の重なりは断る", () => {
  const list: Machine[] = [{ target: "dev", name: "開発" }];
  assert.ok("error" in addMachine(list, "dev"));
  assert.ok("error" in addMachine(list, ""));
  assert.ok("error" in addMachine(list, "-x"));
  assert.ok("error" in addMachine(list, "db", "開発"));
  assert.ok("error" in addMachine(list, "db", "このマシン"));
  assert.ok("machines" in addMachine(list, "db", "dev"));
});

test("名前を変える：空にすると行き先に戻る。重なる名前は断る", () => {
  const list: Machine[] = [{ target: "dev", name: "開発" }, { target: "db" }];
  assert.deepEqual(renameMachine(list, "dev", ""), {
    machines: [{ target: "dev" }, { target: "db" }],
  });
  assert.deepEqual(renameMachine(list, "db", "DB"), {
    machines: [
      { target: "dev", name: "開発" },
      { target: "db", name: "DB" },
    ],
  });
  assert.ok("error" in renameMachine(list, "db", "開発"));
  // 自分の今の名前にはできる
  assert.ok("machines" in renameMachine(list, "dev", "開発"));
});

test("候補を入力で絞る（大文字小文字は区別しない）", () => {
  const c = ["dev-vm", "dev-db", "Prod"];
  assert.deepEqual(filterCandidates(c, ""), c);
  assert.deepEqual(filterCandidates(c, " dev"), ["dev-vm", "dev-db"]);
  assert.deepEqual(filterCandidates(c, "PROD"), ["Prod"]);
  assert.deepEqual(filterCandidates(c, "zzz"), []);
});

test("外す・表示名", () => {
  const list: Machine[] = [{ target: "dev", name: "開発" }, { target: "db" }];
  assert.deepEqual(removeMachine(list, "dev"), [{ target: "db" }]);
  assert.equal(labelOf(list, LOCAL), "このマシン");
  assert.equal(labelOf(list, "dev"), "開発");
  assert.equal(labelOf(list, "db"), "db");
  assert.equal(labelOf(list, "unknown"), "unknown");
});
const config = [{ ssh: "dev-vm", name: "dev" }, { ssh: "build" }];

test("設定ファイルのマシンが先で、足したマシンが後。同じ行き先は設定ファイルのほう", () => {
  const saved = [{ target: "dev-vm", name: "古い名前" }, { target: "other" }];
  assert.deepEqual(mergeMachines(config, saved), [
    { target: "dev-vm", name: "dev", fixed: true },
    { target: "build", fixed: true },
    { target: "other" },
  ]);
});

test("名前が設定ファイルのマシンと重なる足したマシンは出さない", () => {
  const saved = [
    { target: "x", name: "dev" },
    { target: "build2", name: "build" },
  ];
  assert.deepEqual(
    mergeMachines(config, saved).map((m) => m.target),
    ["dev-vm", "build"],
  );
});

test("外せず、名前も変えられない", () => {
  const list = mergeMachines(config, [{ target: "other" }]);
  assert.deepEqual(removeMachine(list, "dev-vm"), list);
  assert.deepEqual(
    removeMachine(list, "other").map((m) => m.target),
    ["dev-vm", "build"],
  );
  assert.ok("error" in renameMachine(list, "dev-vm", "新しい"));
  assert.ok("machines" in renameMachine(list, "other", "新しい"));
});

test("足すときは、設定ファイルの行き先も名前も重ねられない", () => {
  const list = mergeMachines(config, []);
  assert.ok("error" in addMachine(list, "dev-vm"));
  assert.ok("error" in addMachine(list, "z", "dev"));
  assert.ok("machines" in addMachine(list, "z", "zed"));
});

test("保存するのは足したマシンだけ。重なって出ていない記録は残し、外したものは残さない", () => {
  const saved = [
    { target: "dev-vm", name: "古い名前" },
    { target: "other" },
    { target: "gone" },
  ];
  // gone を外した
  const next = mergeMachines(config, saved).filter((m) => m.target !== "gone");
  assert.deepEqual(recordToSave(next, saved, config), [
    { target: "other" },
    { target: "dev-vm", name: "古い名前" },
  ]);
});
