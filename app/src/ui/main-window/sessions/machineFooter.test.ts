import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { KeyLike } from "../../../features/commands/guiKeys.ts";
import {
  COMMON_KEYS,
  placeKeys,
  type FooterRow,
} from "../../../features/commands/placeKeys.ts";
import {
  machineKey,
  type MachineRow,
} from "../../../features/sessions/machineList.ts";
import { setLang } from "../../../i18n/index.ts";
import { machineDialogFooter } from "./machineFooter.ts";

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

/** 全部の操作ができるマシン（つながっていて、config.local.toml のマシンで、接続があり、手元の PC のペインの操作を許している） */
const remote: MachineRow = {
  target: "dev",
  label: "dev",
  health: "up",
  status: "up",
  title: "",
  terminalTabs: 1,
  removable: true,
  fixed: false,
  hasSession: true,
  retry: "now",
  grant: "30m",
};

const shown = (rows: FooterRow[]) =>
  rows.map((r) => [r.title, r.items.map((i) => i.keys.join(" "))]);

describe("machineDialogFooter（マシンのダイアログの Key footer の今効く操作。#489）", () => {
  afterEach(() => setLang("en"));

  it("全部効くマシンでは、選んでいるマシンの行に Enter n d x r t p P を、マシンの一覧の行に a を出す", () => {
    assert.deepEqual(
      shown(
        machineDialogFooter({
          renaming: false,
          selected: remote,
          hasWorkspace: true,
        }),
      ),
      [
        ["Selected machine", ["Enter", "n", "d", "x", "r", "t", "p", "P"]],
        ["Machine list", ["a"]],
      ],
    );
  });

  it("許していないマシンには P（途中で終える）を出さない。手元の PC には p も出さない", () => {
    const notGranted: MachineRow = { ...remote, grant: undefined };
    assert.deepEqual(
      shown(
        machineDialogFooter({
          renaming: false,
          selected: notGranted,
          hasWorkspace: true,
        }),
      )[0],
      ["Selected machine", ["Enter", "n", "d", "x", "r", "t", "p"]],
    );
  });

  it("効かない操作は出さない（config.toml だけのマシン・つながっていないマシン・ワークスペースが無いとき）", () => {
    const fixed: MachineRow = { ...remote, fixed: true };
    assert.deepEqual(
      shown(
        machineDialogFooter({
          renaming: false,
          selected: fixed,
          hasWorkspace: true,
        }),
      )[0],
      ["Selected machine", ["Enter", "x", "r", "p", "P"]],
    );
    const down: MachineRow = { ...remote, health: "down", hasSession: false };
    assert.deepEqual(
      shown(
        machineDialogFooter({
          renaming: false,
          selected: down,
          hasWorkspace: false,
        }),
      )[0],
      ["Selected machine", ["n", "d", "r", "t", "p", "P"]],
    );
    const local: MachineRow = {
      ...remote,
      removable: false,
      retry: undefined,
      grant: undefined,
    };
    assert.deepEqual(
      shown(
        machineDialogFooter({
          renaming: false,
          selected: local,
          hasWorkspace: true,
        }),
      )[0],
      ["Selected machine", ["Enter", "t"]],
    );
  });

  it("マシンが無ければ、選んでいるマシンの行は見出しだけ。a は効く", () => {
    assert.deepEqual(
      shown(
        machineDialogFooter({
          renaming: false,
          selected: undefined,
          hasWorkspace: true,
        }),
      ),
      [
        ["Selected machine", []],
        ["Machine list", ["a"]],
      ],
    );
  });

  it("名前を打っている間は、見出しだけ", () => {
    assert.deepEqual(
      shown(
        machineDialogFooter({
          renaming: true,
          selected: remote,
          hasWorkspace: true,
        }),
      ),
      [["Typing a name", []]],
    );
  });

  it("行の見出しは設定の言語（ja は日本語）、操作の名前はどちらも英語", () => {
    setLang("ja");
    assert.deepEqual(
      shown(
        machineDialogFooter({
          renaming: false,
          selected: remote,
          hasWorkspace: true,
        }),
      ).map(([t]) => t),
      ["選んでいるマシン", "マシンの一覧"],
    );
    const rows = machineDialogFooter({
      renaming: false,
      selected: remote,
      hasWorkspace: true,
    });
    setLang("en");
    const en = machineDialogFooter({
      renaming: false,
      selected: remote,
      hasWorkspace: true,
    });
    assert.deepEqual(
      rows.flatMap((r) => r.items.map((i) => i.label)),
      en.flatMap((r) => r.items.map((i) => i.label)),
    );
  });

  it("Key footer に出す操作は、どれも machineKey が受ける（案内と受けるキーがずれない）", () => {
    for (const r of machineDialogFooter({
      renaming: false,
      selected: remote,
      hasWorkspace: true,
    }))
      for (const i of r.items)
        for (const p of i.probes)
          assert.notEqual(
            machineKey(key(p, { shiftKey: /^[A-Z?]$/.test(p) })),
            null,
            `${i.keys}: ${p}`,
          );
  });

  it("`?` の一覧の表の操作は、どこでも同じキーと g G（同じ操作の別のキー）を除き、どれも Key footer に出る。Enter のほか、どこでも同じキーは出さない", () => {
    const probes = machineDialogFooter({
      renaming: false,
      selected: remote,
      hasWorkspace: true,
    }).flatMap((r) => r.items.flatMap((i) => i.probes));
    const alt = new Set(["g", "G", "Home", "End"]);
    for (const r of placeKeys().machines.rows)
      for (const p of r.probes)
        if (!COMMON_KEYS.has(p) && !alt.has(p))
          assert.ok(probes.includes(p), `${r.keys}: ${p}`);
    // Enter は、この Dialog ではタブを作る操作（選ぶ Dialog の「決める」ではない）なので出す
    for (const p of probes) assert.ok(p === "Enter" || !COMMON_KEYS.has(p), p);
  });
});
