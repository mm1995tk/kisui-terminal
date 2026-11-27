import assert from "node:assert/strict";
import { test } from "node:test";

import { setLang } from "../../i18n/index.ts";
import type { KeyValueStore } from "../keyValueStore.ts";
import {
  fromConfig,
  LEGACY_KEY,
  MACHINES_KEY,
  type ConfigMachine,
  type Machine,
  type MachineEditError,
} from "./machines.ts";
import { moveMachineRecords, MOVED_KEY, recordsToMove } from "./moveRecords.ts";
import type { MachineEdit } from "./shell.ts";

setLang("ja");

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

/** 殻の代わり。config.toml（base）と config.local.toml（local）を持ち、足すと local に書く。 */
function fakeShell(
  base: ConfigMachine[],
  opts: { fail?: (e: MachineEdit) => MachineEditError | undefined } = {},
) {
  const local: ConfigMachine[] = [];
  const edits: MachineEdit[] = [];
  const list = (): ConfigMachine[] => [
    ...base.map((b) => local.find((l) => l.ssh === b.ssh) ?? b),
    ...local.filter((l) => !base.some((b) => b.ssh === l.ssh)),
  ];
  return {
    edits,
    list,
    api: {
      async editMachine(e: MachineEdit): Promise<ConfigMachine[]> {
        edits.push(e);
        const err = opts.fail?.(e);
        if (err) throw err;
        if (e.kind !== "add") throw new Error("not used");
        local.push({ ssh: e.ssh, name: e.name, local: true });
        return list();
      },
    },
  };
}

/** サイドバーに出る並び（ssh の行き先と名前）。 */
const shown = (list: Machine[]) => list.map((m) => [m.target, m.name ?? null]);

/** 前の版のサイドバー（設定ファイルのマシンのあとに、重ならない記録）。 */
function before(config: ConfigMachine[], saved: Machine[]): Machine[] {
  return [...fromConfig(config), ...recordsToMove(config, saved)];
}

test("記録のマシンを config.local.toml に移し、サイドバーの並びは起動の前と同じ", async () => {
  const config: ConfigMachine[] = [{ ssh: "dev-vm", name: "dev" }];
  const saved = [
    { target: "a", name: "エー" },
    { target: "dev-vm", name: "古い名前" }, // config.toml と同じ行き先：config.toml のものを残す
    { target: "x", name: "dev" }, // 名前が config.toml のマシンと重なる：前の版でも出ていなかった
    { target: "b" },
  ];
  const store = mem({ [MACHINES_KEY]: JSON.stringify(saved) });
  const shell = fakeShell(config);
  const r = await moveMachineRecords({ api: shell.api, store, config });
  assert.equal(r.problem, undefined);
  assert.deepEqual(shell.edits, [
    { kind: "add", ssh: "a", name: "エー" },
    { kind: "add", ssh: "b", name: null },
  ]);
  assert.deepEqual(shown(fromConfig(r.machines)), shown(before(config, saved)));
  assert.deepEqual(shown(fromConfig(r.machines)), [
    ["dev-vm", "dev"],
    ["a", "エー"],
    ["b", null],
  ]);
  // 移したマシンは Dialog から変えられる（config.local.toml のもの）。config.toml のものは変えられない
  assert.deepEqual(
    fromConfig(r.machines).map((m) => m.fixed ?? false),
    [true, false, false],
  );
  // 印を付け、記録そのものは残す
  assert.equal(store.m.get(MOVED_KEY), "1");
  assert.equal(store.m.get(MACHINES_KEY), JSON.stringify(saved));

  // 次の起動では読まない（同じ記録があっても、もう移さない）
  const again = fakeShell(shell.list());
  const r2 = await moveMachineRecords({
    api: again.api,
    store,
    config: shell.list(),
  });
  assert.deepEqual(again.edits, []);
  assert.deepEqual(r2.machines, shell.list());
});

test("もっと前の版の記録（つなぎ先の一覧）も移す", async () => {
  const store = mem({ [LEGACY_KEY]: JSON.stringify(["@local", "dev"]) });
  const shell = fakeShell([]);
  const r = await moveMachineRecords({ api: shell.api, store, config: [] });
  assert.deepEqual(r.machines, [{ ssh: "dev", name: null, local: true }]);
});

test("記録が無い・store が無いときは何もしない", async () => {
  const config: ConfigMachine[] = [{ ssh: "a" }];
  const shell = fakeShell(config);
  assert.deepEqual(
    await moveMachineRecords({ api: shell.api, store: undefined, config }),
    { machines: config },
  );
  const store = mem();
  assert.deepEqual(
    await moveMachineRecords({ api: shell.api, store, config }),
    { machines: config },
  );
  assert.deepEqual(shell.edits, []);
});

test("config.local.toml に書けなければ止めて知らせ、印を付けない（次の起動でまた移す）", async () => {
  const saved = [{ target: "a" }, { target: "b", name: "ビー" }];
  const store = mem({ [MACHINES_KEY]: JSON.stringify(saved) });
  const shell = fakeShell([], {
    fail: (e) =>
      e.kind === "add" && e.ssh === "b"
        ? { kind: "file", detail: "/c/config.local.toml: 書けません" }
        : undefined,
  });
  const r = await moveMachineRecords({ api: shell.api, store, config: [] });
  assert.deepEqual(shown(fromConfig(r.machines)), [["a", null]]);
  assert.equal(
    r.problem?.title,
    "ウィンドウで足したマシンを config.local.toml に移せませんでした",
  );
  assert.match(r.problem?.error ?? "", /書けません/);
  assert.match(r.problem?.error ?? "", /今回は出していません：ビー/);
  assert.equal(store.m.get(MOVED_KEY), undefined);

  // 次の起動：移したもの（a）は設定ファイルにあるので、残り（b）だけを移す
  const next = fakeShell(shell.list());
  const r2 = await moveMachineRecords({
    api: next.api,
    store,
    config: shell.list(),
  });
  assert.equal(r2.problem, undefined);
  assert.deepEqual(next.edits, [{ kind: "add", ssh: "b", name: "ビー" }]);
  assert.equal(store.m.get(MOVED_KEY), "1");
});

test("殻の確かめで断られた 1 台は飛ばして続け、知らせる", async () => {
  const saved = [{ target: "a", name: "Local" }, { target: "b" }];
  const store = mem({ [MACHINES_KEY]: JSON.stringify(saved) });
  const shell = fakeShell([], {
    fail: (e) =>
      e.kind === "add" && e.ssh === "a"
        ? { kind: "rejected", detail: "名前 Local は使えません" }
        : undefined,
  });
  const r = await moveMachineRecords({ api: shell.api, store, config: [] });
  assert.deepEqual(shown(fromConfig(r.machines)), [["b", null]]);
  assert.equal(
    r.problem?.title,
    "ウィンドウで足したマシンのうち、config.local.toml に移さなかったものがあります",
  );
  assert.match(r.problem?.error ?? "", /^Local: .*名前 Local は使えません/);
  assert.equal(store.m.get(MOVED_KEY), "1");
});
