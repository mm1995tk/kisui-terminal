import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { setLang, T } from "../../i18n/index.ts";
import type { DbConnection } from "../../infrastructure/rpc/protocol.ts";
import { LOCAL } from "../sessions/shell.ts";
import { createDbConnections } from "./connectionController.ts";
import {
  editErrorLines,
  emptyFields,
  localMark,
  rowEditNote,
  rowEditState,
  type DbConnectionEdit,
  type LocalDbConnections,
  type LocalDbEntry,
} from "./connectionForm.ts";
import type { DbChoice } from "./model.ts";
import { dbPickerFooter, dbPickerKey } from "./pickerKeys.ts";

const conn = (name: string, variant = ""): DbConnection => ({
  name,
  variant,
  kind: "postgres",
  host: "localhost",
  port: 5432,
  user: "app",
  database: "",
  readOnly: false,
});
const choice = (name: string, target = LOCAL, variant = ""): DbChoice => ({
  target,
  machine: target,
  color: "#000",
  connection: conn(name, variant),
});
const entry = (
  name: string,
  editable = true,
  overrides = false,
): LocalDbEntry => ({
  ...emptyFields(),
  name,
  user: "app",
  editable,
  overrides,
});
const local: LocalDbConnections = {
  local: [entry("dev"), entry("hand", false), entry("shop", true, true)],
  fixed: ["prod"],
};

describe("rowEditState（接続を選ぶ窓の行を、窓から変えられるか）", () => {
  it("この PC の config.local.toml の接続は直せる・消せる", () => {
    assert.equal(rowEditState(choice("dev"), local).kind, "edit");
    assert.equal(rowEditNote(rowEditState(choice("dev"), local)), undefined);
  });

  it("窓で入れないキーを書いた接続・変種の行は、消せるだけ", () => {
    assert.equal(rowEditState(choice("hand"), local).kind, "removeOnly");
    assert.equal(
      rowEditState(choice("dev", LOCAL, "prod"), local).kind,
      "removeOnly",
    );
    assert.equal(
      rowEditNote(rowEditState(choice("hand"), local)),
      T("dbConn.note.fileOnly"),
    );
  });

  it("config.toml の接続・リモートのマシンの接続は変えられず、理由を出す", () => {
    assert.equal(rowEditState(choice("prod"), local).kind, "fixed");
    assert.equal(
      rowEditNote(rowEditState(choice("prod"), local)),
      T("dbConn.note.fixed"),
    );
    assert.equal(rowEditState(choice("dev", "dev-vm"), local).kind, "remote");
    assert.equal(rowEditState(choice("dev"), undefined).kind, "unknown");
  });
});

describe("localMark（config.local.toml で登録している行の印）", () => {
  it("手元の config.local.toml の接続（上書きも）に付け、config.toml の接続・リモートの接続には付けない", () => {
    assert.equal(localMark(choice("dev"), local), true);
    assert.equal(localMark(choice("shop"), local), true);
    assert.equal(localMark(choice("prod"), local), false);
    assert.equal(localMark(choice("dev", "dev-vm"), local), false);
    assert.equal(localMark(choice("dev"), undefined), false);
  });
});

describe("editErrorLines（殻が書けなかった理由）", () => {
  it("項目の間違いは、キーと理由を 1 つずつ 1 行に（kisui と同じ理由。値は入れる）", () => {
    setLang("en");
    assert.deepEqual(
      editErrorLines({
        kind: "invalid",
        detail: [
          { key: "port", code: "config.err.port", args: [] },
          { key: "name", code: "config.err.toolong", args: ["100"] },
          { key: "host", code: "gui.db.hosturl", args: [] },
        ],
      }),
      [
        "port: must be from 1 to 65535",
        "name: must be 100 characters or fewer",
        `host: ${T("dbConn.err.hosturl")}`,
      ],
    );
    setLang("ja");
    assert.deepEqual(
      editErrorLines({
        kind: "invalid",
        detail: [{ key: "user", code: "config.err.required", args: [] }],
      }),
      ["user：省けません"],
    );
    setLang("en");
  });

  it("config.toml の接続・重なり・そのほか", () => {
    assert.deepEqual(editErrorLines({ kind: "fixed", detail: "prod" }), [
      T("dbConn.err.fixed", { name: "prod" }),
    ]);
    assert.deepEqual(editErrorLines({ kind: "exists", detail: "dev" }), [
      T("dbConn.err.exists", { name: "dev" }),
    ]);
    assert.deepEqual(editErrorLines("boom"), [
      T("dbConn.err.failed", { error: "boom" }),
    ]);
  });
});

describe("dbPickerKey・dbPickerFooter（接続を選ぶ窓のキーと下の段）", () => {
  const ev = (key: string, mods: Partial<KeyboardEvent> = {}) =>
    ({ key, ...mods }) as KeyboardEvent;

  it("a e d は足す・直す・消す。修飾キー付きは受けない。動かす・決めるは一覧から選ぶ窓と同じ", () => {
    assert.deepEqual(dbPickerKey(ev("a")), { kind: "add" });
    assert.deepEqual(dbPickerKey(ev("e")), { kind: "edit" });
    assert.deepEqual(dbPickerKey(ev("d")), { kind: "remove" });
    assert.equal(dbPickerKey(ev("a", { metaKey: true })), null);
    assert.equal(dbPickerKey(ev("D", { shiftKey: true })), null);
    assert.deepEqual(dbPickerKey(ev("Enter")), { kind: "choose" });
  });

  it("変換中の a e d は受けない", () => {
    for (const key of ["a", "e", "d"]) {
      assert.equal(dbPickerKey(ev(key, { isComposing: true })), null, key);
      assert.equal(dbPickerKey(ev(key, { keyCode: 229 })), null, key);
    }
  });

  it("直せない行では edit・remove を出さない（行の見出しは出す）", () => {
    const keys = (o: { editable: boolean; removable: boolean }) =>
      dbPickerFooter(o).map((r) => r.items.map((i) => i.keys.join(" ")));
    assert.deepEqual(keys({ editable: true, removable: true }), [
      ["e", "d"],
      ["a"],
    ]);
    assert.deepEqual(keys({ editable: false, removable: true }), [
      ["d"],
      ["a"],
    ]);
    assert.deepEqual(keys({ editable: false, removable: false }), [[], ["a"]]);
  });
});

describe("createDbConnections（足す・直す・消すの流れ）", () => {
  function setup(edit: (e: DbConnectionEdit) => Promise<LocalDbConnections>) {
    const sent: DbConnectionEdit[] = [];
    let refreshed = 0;
    const c = createDbConnections({
      config: {
        list: async () => local,
        edit: (e) => {
          sent.push(e);
          return edit(e);
        },
      },
      refresh: () => refreshed++,
    });
    return { c, sent, refreshed: () => refreshed };
  }

  it("書けたら窓を閉じて一覧を聞き直す。直すときは元の名前を渡す", async () => {
    const { c, sent, refreshed } = setup(async () => local);
    await c.loadLocal();
    c.openConnFor("edit", choice("dev"));
    assert.equal(c.connForm()?.name, "dev");
    const fields = { ...c.connForm()!.fields, name: "dev2" };
    c.submitConnForm(fields);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(sent, [
      { kind: "update", name: "dev", connection: fields },
    ]);
    assert.equal(c.connForm(), null);
    assert.equal(refreshed(), 1);
  });

  it("書いている間に窓を閉じても、書けたら一覧を聞き直す", async () => {
    const { c, refreshed } = setup(async () => local);
    c.openConnAdd();
    c.submitConnForm({ ...emptyFields(), name: "x", user: "u" });
    c.closeConnForm();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(c.connForm(), null);
    assert.equal(refreshed(), 1);
  });

  it("書けなければ窓を開けたまま、入れた値と理由を残す", async () => {
    const { c, refreshed } = setup(async () => {
      throw { kind: "fixed", detail: "prod" };
    });
    c.openConnAdd();
    const fields = { ...emptyFields(), name: "prod", user: "u" };
    c.submitConnForm(fields);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(c.connForm()?.fields, fields);
    assert.deepEqual(c.connForm()?.errors, [
      T("dbConn.err.fixed", { name: "prod" }),
    ]);
    assert.equal(c.connForm()?.busy, false);
    assert.equal(refreshed(), 0);
  });

  it("変えられない行では窓を開かない。消せるだけの行は消す窓だけ開く", async () => {
    const { c } = setup(async () => local);
    await c.loadLocal();
    c.openConnFor("edit", choice("prod"));
    assert.equal(c.connForm(), null);
    c.openConnFor("edit", choice("hand"));
    assert.equal(c.connForm(), null);
    c.openConnFor("remove", choice("hand"));
    assert.equal(c.connForm()?.mode, "remove");
    assert.equal(c.connForm()?.overrides, false);
  });

  it("上書きは断らずに直す・消す窓を開き、上書きであることを窓に渡す", async () => {
    const { c } = setup(async () => local);
    await c.loadLocal();
    c.openConnFor("remove", choice("shop"));
    assert.equal(c.connForm()?.mode, "remove");
    assert.equal(c.connForm()?.overrides, true);
  });
});
