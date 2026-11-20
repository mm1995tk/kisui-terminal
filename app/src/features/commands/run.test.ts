import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";

// node では solid-js がサーバー用に解決されるので、ブラウザー用に向け直す（compose.test.ts と同じ。読み込む前に向け直す）
registerHooks({
  resolve: (specifier, context, nextResolve) =>
    nextResolve(
      specifier === "solid-js" ? "solid-js/dist/solid.js" : specifier,
      context,
    ),
});

const { createCommandRunner } = await import("./run.ts");

/** どの名前を引いても、何もしない関数を返す偽物（over は、その名前だけ差し替える）。 */
function stub(over: Record<string, unknown> = {}): never {
  return new Proxy(over, {
    get: (t, k) => (k in t ? t[k as string] : () => undefined),
  }) as never;
}

/** DB のタブを出しているか（tab）を決めて、コマンドを動かす道具を作る。 */
function setup(tab: { id: string } | undefined) {
  const seen: string[] = [];
  const run = createCommandRunner({
    workspaces: stub({
      cannot: (title: string) => void seen.push(`cannot ${title}`),
    }),
    tabs: stub(),
    terminals: stub(),
    browserTabs: stub(),
    pages: stub(),
    db: stub({
      shownDbTab: () => tab,
      reloadCatalog: (id: string) => void seen.push(`reload ${id}`),
    }),
    bookmarks: stub(),
    downloads: stub(),
    updates: stub(),
    mascot: stub(),
    scale: stub(),
    os: stub(),
    setFocusError: () => undefined,
    showToast: () => undefined,
    focusTerminal: () => void seen.push("focusTerminal"),
    ui: stub({ focusDbTree: () => void seen.push("focusDbTree") }),
  });
  return { seen, runCommand: run.runCommand };
}

describe("db.tree（サイドバーの木にキーを向ける。#374）", () => {
  it("DB のタブを出していなければ、キーを向けず、その旨を伝える", () => {
    const { seen, runCommand } = setup(undefined);
    runCommand({ id: "db.tree" });
    assert.deepEqual(seen, ["cannot " + "No database tab is shown"]);
  });

  it("DB のタブを出していれば、続けて 2 回実行しても、2 回とも木にキーを向ける（出し隠しではない）", () => {
    const { seen, runCommand } = setup({ id: "t1" });
    runCommand({ id: "db.tree" });
    runCommand({ id: "db.tree" });
    assert.deepEqual(seen, ["focusDbTree", "focusDbTree"]);
  });

  it("db.refresh は木を読み直し、キーを入力欄に向ける（木にはキーを向けない）", () => {
    const { seen, runCommand } = setup({ id: "t1" });
    runCommand({ id: "db.refresh" });
    assert.deepEqual(seen, ["reload t1", "focusTerminal"]);
  });
});
