import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Row } from "../../../features/workspaces/rows.ts";
import { createSwitcherNewTab } from "./switcherNewTab.ts";

/** 窓の側の持ち物の代わり。呼ばれたことを log に残す。 */
function setup(o: { row?: Row | null; machines?: number; browser?: boolean }) {
  const log: string[] = [];
  const row =
    o.row === null ? undefined : (o.row ?? ({ gws: "g1" } as unknown as Row));
  const newTab = createSwitcherNewTab({
    selected: () => row,
    sel: () => row?.gws,
    has: () => true,
    machineCount: () => o.machines ?? 1,
    browser: () => o.browser ?? true,
    create: (gws, machine, name) => {
      log.push(`create ${gws} ${machine} ${name}`);
      return { key: Promise.resolve(undefined) };
    },
    openBrowser: (gws, incognito) => {
      log.push(`browser ${gws} ${incognito}`);
      return `b:${gws}`;
    },
    openDb: (gws) => void log.push(`db ${gws}`),
    noMachine: () => void log.push("noMachine"),
    pickTab: (key) => void log.push(`pickTab ${key}`),
    focusList: () => void log.push("focusList"),
    clearOthers: () => void log.push("clearOthers"),
  });
  return { newTab, log };
}

describe("ワークスペースの窓の、タブを作る操作（#456）", () => {
  it("始めると、ほかの入力欄をやめて、種類を選ぶ一覧を出す。一番上のターミナルを選んでいる", () => {
    const { newTab, log } = setup({});
    newTab.start();
    assert.deepEqual(newTab.choosing(), { gws: "g1", kind: "terminal" });
    assert.equal(newTab.creating(), undefined);
    assert.deepEqual(log, ["clearOthers"]);
  });

  it("ワークスペースを選んでいなければ（1 つも無い）、何も出さない", () => {
    const { newTab, log } = setup({ row: null });
    newTab.start();
    assert.equal(newTab.choosing(), undefined);
    assert.deepEqual(log, []);
  });

  it("選ぶ行は、一覧の種類の順に動き、端で止まる", () => {
    const { newTab } = setup({});
    newTab.start();
    newTab.move("prev");
    assert.equal(newTab.choosing()?.kind, "terminal");
    const seen: (string | undefined)[] = [];
    for (let i = 0; i < 4; i++) {
      newTab.move("next");
      seen.push(newTab.choosing()?.kind);
    }
    assert.deepEqual(seen, ["browser", "incognito", "db", "db"]);
  });

  it("内蔵ブラウザが無効なら、ブラウザとシークレットには決められない", () => {
    const { newTab, log } = setup({ browser: false });
    newTab.start();
    assert.deepEqual(newTab.kinds(), ["terminal", "db"]);
    newTab.pick("browser");
    newTab.pick("incognito");
    assert.deepEqual(newTab.choosing(), { gws: "g1", kind: "terminal" });
    assert.deepEqual(log, ["clearOthers"]);
    newTab.move("next");
    assert.equal(newTab.choosing()?.kind, "db");
  });

  it("ターミナルに決めると、一覧を閉じて、名前とマシンの行を出す", () => {
    const { newTab } = setup({});
    newTab.start();
    newTab.choose();
    assert.equal(newTab.choosing(), undefined);
    assert.deepEqual(newTab.creating(), { gws: "g1" });
    newTab.submit("api", "local");
    assert.equal(newTab.creating(), undefined);
  });

  it("つながっているマシンが無いと、ターミナルには進まず、できないことを伝える。一覧は開けたまま", () => {
    const { newTab, log } = setup({ machines: 0 });
    newTab.start();
    newTab.pick("terminal");
    assert.deepEqual(newTab.choosing(), { gws: "g1", kind: "terminal" });
    assert.equal(newTab.creating(), undefined);
    assert.deepEqual(log, ["clearOthers", "noMachine"]);
  });

  it("ブラウザ・シークレットに決めると、すぐ開いて、できたタブを選び、キーを窓に戻す", () => {
    for (const [what, incognito] of [
      ["browser", false],
      ["incognito", true],
    ] as const) {
      const { newTab, log } = setup({});
      newTab.start();
      newTab.pick(what);
      assert.equal(newTab.choosing(), undefined);
      assert.deepEqual(log, [
        "clearOthers",
        `browser g1 ${incognito}`,
        "pickTab b:g1",
        "focusList",
      ]);
    }
  });

  it("DB に決めると、一覧を閉じて、そのワークスペースを作成先にして呼んだ側に任せる", () => {
    const { newTab, log } = setup({});
    newTab.start();
    newTab.pick("db");
    assert.equal(newTab.choosing(), undefined);
    assert.deepEqual(log, ["clearOthers", "db g1"]);
  });

  it("やめると、一覧だけを閉じて、キーを窓に戻す", () => {
    const { newTab, log } = setup({});
    newTab.start();
    newTab.cancel();
    assert.equal(newTab.choosing(), undefined);
    assert.deepEqual(log, ["clearOthers", "focusList"]);
  });
});
