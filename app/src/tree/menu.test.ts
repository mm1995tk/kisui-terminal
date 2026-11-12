import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  absolutePath,
  menuItems,
  newEntryDefault,
  newEntryPath,
  parentPath,
  renamedPath,
  shouldRestoreFocus,
} from "./menu.ts";

describe("menuItems", () => {
  it("ファイルには新規作成と cd を出さない", () => {
    assert.deepEqual(menuItems({ dir: false }), [
      "copy-name",
      "copy-relative",
      "copy-absolute",
      "rename",
      "delete",
    ]);
  });
  it("フォルダには全部出す", () => {
    assert.deepEqual(menuItems({ dir: true }), [
      "copy-name",
      "copy-relative",
      "copy-absolute",
      "new-file",
      "new-dir",
      "rename",
      "delete",
      "cd",
    ]);
  });
});

describe("パス", () => {
  it("absolutePath", () => {
    assert.equal(absolutePath("/w/p", "a/b"), "/w/p/a/b");
    assert.equal(absolutePath("/w/p/", "a"), "/w/p/a");
    assert.equal(absolutePath("/w/p", ""), "/w/p");
  });
  it("parentPath", () => {
    assert.equal(parentPath("a/b/c"), "a/b");
    assert.equal(parentPath("a"), "");
  });
  it("newEntryDefault", () => {
    assert.equal(newEntryDefault(""), "");
    assert.equal(newEntryDefault("src"), "src/");
  });
  it("newEntryPath は名前が無ければ null", () => {
    assert.equal(newEntryPath(" src/a.go ", "file"), "src/a.go");
    assert.equal(newEntryPath("./a.go", "file"), "a.go");
    assert.equal(newEntryPath("src/", "file"), null);
    assert.equal(newEntryPath("  ", "file"), null);
    assert.equal(newEntryPath("src/new/", "dir"), "src/new");
  });
  it("renamedPath は変わっていなければ null", () => {
    assert.equal(renamedPath("a/b", "a/c"), "a/c");
    assert.equal(renamedPath("a/b", "a/b"), null);
    assert.equal(renamedPath("a/b", ""), null);
  });
});

describe("shouldRestoreFocus（キーで開いたメニューを閉じたあと）", () => {
  const body = {};
  const row = (over = {}) => ({
    isConnected: true,
    matches: (s: string) => s === ".tree-row",
    ...over,
  });

  it("Esc・項目の選択でフォーカスが body に落ちたら、行へ戻す", () => {
    assert.equal(shouldRestoreFocus(row(), body, body), true);
    assert.equal(shouldRestoreFocus(row(), null, body), true);
  });

  it("項目で窓が出た・外を押してほかにフォーカスが移ったときは戻さない", () => {
    assert.equal(shouldRestoreFocus(row(), {}, body), false);
  });

  it("行が消えた・行でなかった・開く前にフォーカスが無かったときは戻さない", () => {
    assert.equal(
      shouldRestoreFocus(row({ isConnected: false }), body, body),
      false,
    );
    assert.equal(
      shouldRestoreFocus(row({ matches: () => false }), body, body),
      false,
    );
    assert.equal(shouldRestoreFocus(null, body, body), false);
  });
});
