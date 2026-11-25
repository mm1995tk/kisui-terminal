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
      reloadStructure: (id: string) => void seen.push(`reloadStructure ${id}`),
      stepResultTab: (id: string, step: number) =>
        void seen.push(`stepResultTab ${id} ${step}`),
      closeResult: (id: string) => {
        seen.push(`closeResult ${id}`);
        return true;
      },
      openElevate: (id: string) => void seen.push(`openElevate ${id}`),
      endElevation: (id: string) => void seen.push(`endElevation ${id}`),
      showView: (id: string) => {
        seen.push(`showView ${id}`);
        return id === "t1";
      },
    }),
    bookmarks: stub(),
    downloads: stub(),
    updates: stub(),
    mascot: stub(),
    scale: stub(),
    proxy: stub(),
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
    assert.deepEqual(seen, [
      "reload t1",
      "reloadStructure t1",
      "focusTerminal",
    ]);
  });
});

describe("db.view（結果の場所のデータと Structure の切り替え。#379）", () => {
  it("DB のタブを出していなければ、切り替えず、その旨を伝える", () => {
    const { seen, runCommand } = setup(undefined);
    runCommand({ id: "db.view" });
    assert.deepEqual(seen, ["cannot " + "No database tab is shown"]);
  });

  it("テーブルを選んだタブなら切り替える", () => {
    const { seen, runCommand } = setup({ id: "t1" });
    runCommand({ id: "db.view" });
    assert.deepEqual(seen, ["showView t1"]);
  });

  it("テーブルを選んでいないタブ（切り替えが無い）なら、その旨を伝える", () => {
    const { seen, runCommand } = setup({ id: "t2" });
    runCommand({ id: "db.view" });
    assert.deepEqual(seen, ["showView t2", "cannot " + "No table is chosen"]);
  });
});

describe("db.result・db.closeResult（結果のタブの切り替えと、閉じる。#404）", () => {
  it("DB のタブを出していなければ、何もせず、その旨を伝える", () => {
    const { seen, runCommand } = setup(undefined);
    runCommand({ id: "db.result", arg: "next" });
    runCommand({ id: "db.closeResult" });
    assert.deepEqual(seen, [
      "cannot " + "No database tab is shown",
      "cannot " + "No database tab is shown",
    ]);
  });

  it("d ] は次、d [ は前の結果のタブへ", () => {
    const { seen, runCommand } = setup({ id: "t1" });
    runCommand({ id: "db.result", arg: "next" });
    runCommand({ id: "db.result", arg: "prev" });
    assert.deepEqual(seen, ["stepResultTab t1 1", "stepResultTab t1 -1"]);
  });

  it("d x は、出している結果のタブを閉じる", () => {
    const { seen, runCommand } = setup({ id: "t1" });
    runCommand({ id: "db.closeResult" });
    assert.deepEqual(seen, ["closeResult t1"]);
  });
});

describe("db.elevate・db.elevateEnd（権限を時間を決めて強める・元に戻す。#383）", () => {
  it("DB のタブを出していなければ、何もせず、その旨を伝える", () => {
    const { seen, runCommand } = setup(undefined);
    runCommand({ id: "db.elevate" });
    runCommand({ id: "db.elevateEnd" });
    assert.deepEqual(seen, [
      "cannot " + "No database tab is shown",
      "cannot " + "No database tab is shown",
    ]);
  });

  it("d p は出している DB のタブの接続の強める窓を出し、d P は元に戻す", () => {
    const { seen, runCommand } = setup({ id: "t1" });
    runCommand({ id: "db.elevate" });
    runCommand({ id: "db.elevateEnd" });
    assert.deepEqual(seen, ["openElevate t1", "endElevation t1"]);
  });
});

describe("tab.window（今出しているタブの種類の窓を開く。リーダーの a。#457）", () => {
  /** 出しているタブ（shown）と、窓がある種類（windows）を決めて、コマンドを動かす道具を作る。 */
  function setupTabWindow(
    shown: { browser?: boolean; db?: boolean; terminal?: boolean },
    windows: string[] = ["terminal"],
  ) {
    const seen: string[] = [];
    const run = createCommandRunner({
      workspaces: stub({
        focus: () => (shown.terminal ? { target: "local", id: "w1" } : null),
        cannot: (title: string, text: string) =>
          void seen.push(`cannot ${title} / ${text}`),
      }),
      tabs: stub(),
      terminals: stub(),
      browserTabs: stub(),
      pages: stub({
        shownBrowserTab: () => (shown.browser ? "b1" : undefined),
      }),
      db: stub({ shownDbTab: () => (shown.db ? { id: "d1" } : undefined) }),
      bookmarks: stub(),
      downloads: stub(),
      updates: stub(),
      mascot: stub(),
      scale: stub(),
      proxy: stub(),
      os: stub(),
      setFocusError: () => undefined,
      showToast: () => undefined,
      focusTerminal: () => undefined,
      ui: stub({
        openTabWindow: (kind: string) => {
          if (!windows.includes(kind)) return false;
          seen.push(`open ${kind}`);
          return true;
        },
      }),
    });
    return { seen, runCommand: run.runCommand };
  }
  const noWindow =
    "cannot This tab has no window / " +
    "Only terminal tabs have a window of their own for now.";

  it("ターミナルのタブを出していれば、ターミナルのタブの窓を開く", () => {
    const { seen, runCommand } = setupTabWindow({ terminal: true });
    runCommand({ id: "tab.window" });
    assert.deepEqual(seen, ["open terminal"]);
  });

  it("DB・ブラウザのタブを出している間は、裏にターミナルのタブがあっても、ターミナルのタブの窓を開かず、その旨を伝える", () => {
    for (const shown of [
      { db: true, terminal: true },
      { browser: true, terminal: true },
      { browser: true },
    ]) {
      const { seen, runCommand } = setupTabWindow(shown);
      runCommand({ id: "tab.window" });
      assert.deepEqual(seen, [noWindow]);
    }
  });

  it("種類の窓があれば（あとから足す DB・ブラウザの窓）、その種類の窓を開く", () => {
    const { seen, runCommand } = setupTabWindow({ db: true, terminal: true }, [
      "terminal",
      "db",
    ]);
    runCommand({ id: "tab.window" });
    assert.deepEqual(seen, ["open db"]);
  });

  it("タブを出していなければ、窓を開かず、その旨を伝える", () => {
    const { seen, runCommand } = setupTabWindow({});
    runCommand({ id: "tab.window" });
    assert.deepEqual(seen, [
      "cannot This tab has no window / " +
        "No tab is shown. Press n after the leader to create one.",
    ]);
  });
});
