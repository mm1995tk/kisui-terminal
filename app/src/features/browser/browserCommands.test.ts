import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  WindowCommandError,
  type WindowCaller,
} from "../commands/windowRun.ts";
import type { Machine } from "../sessions/machines.ts";
import { LOCAL } from "../sessions/shell.ts";
import { browserKey, termKey, type GwsState } from "../workspaces/model.ts";
import type { Row } from "../workspaces/rows.ts";
import { checkUrl, createBrowserCommands } from "./browserCommands.ts";
import type { PasskeyLogin } from "./os.ts";
import type { BrowserTab } from "./tabs.ts";

const state: GwsState = {
  list: [
    {
      id: "gaaaaaaaaaa",
      name: "",
      num: 1,
      tabs: [
        { kind: "term", target: LOCAL, ws: "wlocal", title: "" },
        { kind: "term", target: "dev-vm", ws: "wdev", title: "" },
        { kind: "browser", id: "tpage" },
        { kind: "browser", id: "tnew" },
      ],
    },
  ],
};

const rows: Row[] = [
  {
    gws: "gaaaaaaaaaa",
    band: { focused: true },
    tabs: {
      shown: termKey(LOCAL, "wlocal"),
      focused: true,
      items: [
        { key: termKey(LOCAL, "wlocal"), title: "repo" },
        { key: termKey("dev-vm", "wdev"), title: "dev" },
        { key: browserKey("tpage"), title: "Docs" },
        { key: browserKey("tnew"), title: "New" },
      ],
    },
  },
] as unknown as Row[];

const machines: Machine[] = [{ target: "dev-vm", name: "dev" }];

const page: BrowserTab = {
  id: "tpage",
  target: LOCAL,
  workspace: "",
  url: "https://example.com/a",
  title: "Docs",
  history: { back: true, forward: false },
};
const fresh: BrowserTab = { ...page, id: "tnew", url: "", title: "" };

function setup(
  opts: {
    granted?: boolean;
    askEach?: boolean;
    browser?: boolean;
    noView?: boolean;
    login?: PasskeyLogin;
    tab?: Partial<BrowserTab>;
  } = {},
) {
  const calls: unknown[][] = [];
  const table = createBrowserCommands({
    sessions: { machines: () => machines, labelOf: (t) => t },
    gws: () => state,
    rows: () => rows,
    browser: opts.browser ?? true,
    browserTabs: {
      tabs: () => ({ tabs: [{ ...page, ...opts.tab }, fresh], views: {} }),
    },
    tabs: {
      closeTabRow: (gid, key) => calls.push(["close", gid, key]),
      setTabName: async (gid, key, name) => {
        calls.push(["rename", gid, key, name]);
      },
      newBrowserTab: (g, priv, origin) => {
        calls.push(["new", g.id, priv, origin]);
        return "tcreated";
      },
      newBrowserTabAt: async (g, url, priv, origin) => {
        calls.push(["newAt", g.id, url, priv, origin]);
        return "tcreated2";
      },
    },
    pages: {
      navPage: (id, a) => calls.push(["nav", id, a]),
      stopPage: (id) => calls.push(["stop", id]),
      hasPage: (t) => !opts.noView && t.id === "tpage",
      goToChecked: async (id, url) => {
        calls.push(["go", id, url]);
      },
    },
    bookmarks: {
      bookmarkPageChecked: async (t) => {
        calls.push(["bookmark", t.id]);
      },
      readBookmarks: async () => [{ url: "https://a.example/", title: "A" }],
    },
    os: {
      findInTab: async (id, text) => {
        calls.push(["find", id, text]);
        return text === "yes";
      },
      openTabDevtools: async (id) => {
        calls.push(["devtools", id]);
      },
      startPasskeyLogin: async (id) => {
        calls.push(["login", id]);
        return opts.login ?? "opened";
      },
    },
    openUrlExternally: async (t, u) => {
      calls.push(["external", t, u]);
    },
    granted: () => opts.granted === true,
    anyAskEach: () => opts.askEach === true,
  });
  const run = (
    command: string,
    args: Record<string, unknown>,
    from = LOCAL,
    tab = "wlocal",
  ) =>
    table[command].run(args, {
      from,
      pane: "t1",
      tab,
      signal: new AbortController().signal,
    } satisfies WindowCaller);
  return { calls, run, table };
}

async function refusal(p: () => unknown): Promise<WindowCommandError> {
  try {
    await p();
  } catch (e) {
    assert.ok(e instanceof WindowCommandError, String(e));
    return e;
  }
  assert.fail("not refused");
}

describe("checkUrl", () => {
  it("http と https の URL だけを通し、整えた形を返す", () => {
    assert.equal(checkUrl(" https://example.com "), "https://example.com/");
    for (const bad of [
      "",
      "ftp://x.example/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://u:p@example.com/",
      "https://example.com/\nx",
      "https://example.com/" + "a".repeat(5000),
    ])
      assert.throws(() => checkUrl(bad), WindowCommandError, bad);
  });
});

describe("kisui browser の受け持ち", () => {
  it("どれもリモートの Machine の Pane の頼みを受ける印（remote）が付いている", () => {
    const { table } = setup();
    assert.equal(Object.keys(table).length, 15);
    for (const c of Object.values(table)) assert.equal(c.remote, true);
  });

  it("内蔵ブラウザが無効なら、どれも理由を出して断る", async () => {
    const { run, table } = setup({ browser: false });
    for (const name of Object.keys(table)) {
      const e = await refusal(() => run(name, { tab: "tpage", url: "x" }));
      assert.match(e.message, /built-in browser is off/, name);
    }
  });

  it("手元の PC の Pane からは、Tab を id でも名前でも指して、キーと同じ操作を行う", async () => {
    const { run, calls } = setup();
    await run("browser.reload", { tab: "tpage" });
    await run("browser.back", { tab: "Docs" });
    await run("browser.close", { tab: "tpage" });
    await run("browser.rename", { tab: "tpage", name: "x" });
    assert.deepEqual(calls, [
      ["nav", "tpage", "reload"],
      ["nav", "tpage", "back"],
      ["close", "gaaaaaaaaaa", browserKey("tpage")],
      ["rename", "gaaaaaaaaaa", browserKey("tpage"), "x"],
    ]);
  });

  it("Browser tab でない Tab は断る", async () => {
    const { run } = setup();
    const e = await refusal(() => run("browser.reload", { tab: "wlocal" }));
    assert.match(e.message, /not a browser tab/);
  });

  it("今できない操作は、Dialog と同じ理由で断る", async () => {
    const { run, calls } = setup({ tab: { history: undefined } });
    await refusal(() => run("browser.back", { tab: "tpage" }));
    await refusal(() => run("browser.forward", { tab: "tpage" }));
    await refusal(() => run("browser.stop", { tab: "tpage" }));
    await refusal(() => run("browser.reload", { tab: "tnew" }));
    await refusal(() => run("browser.find", { tab: "tnew", text: "a" }));
    assert.deepEqual(calls, []);
  });

  it("まだページ（webview）が無い Tab への reload・find・devtools・login は、理由で断る", async () => {
    const { run, calls } = setup({ noView: true });
    for (const [name, args] of [
      ["browser.reload", { tab: "tpage" }],
      ["browser.find", { tab: "tpage", text: "a" }],
      ["browser.devtools", { tab: "tpage" }],
      ["browser.login", { tab: "tpage" }],
    ] as const) {
      const e = await refusal(() => run(name, args));
      assert.match(e.message, /has no page yet/, name);
    }
    // 保存した URL に頼む操作は、ページが無くても行う
    await run("browser.copyUrl", { tab: "tpage" });
    await run("browser.url", { tab: "tpage", url: "https://b.example" });
    assert.deepEqual(calls, [["go", "tpage", "https://b.example/"]]);
  });

  it("copy-url は URL を返す", async () => {
    const { run } = setup();
    assert.deepEqual(await run("browser.copyUrl", { tab: "tpage" }), {
      id: "tpage",
      url: "https://example.com/a",
    });
  });

  it("find は見つかったかを返す", async () => {
    const { run } = setup();
    assert.deepEqual(await run("browser.find", { tab: "tpage", text: "yes" }), {
      id: "tpage",
      found: true,
    });
    assert.deepEqual(await run("browser.find", { tab: "tpage", text: "no" }), {
      id: "tpage",
      found: false,
    });
    await refusal(() => run("browser.find", { tab: "tpage", text: "" }));
  });

  it("url は http と https の URL だけを開く", async () => {
    const { run, calls } = setup();
    await run("browser.url", { tab: "tpage", url: "https://b.example" });
    await refusal(() =>
      run("browser.url", { tab: "tpage", url: "file:///etc/passwd" }),
    );
    assert.deepEqual(calls, [["go", "tpage", "https://b.example/"]]);
  });

  it("new は頼んだ Pane の Workspace に足し、URL があれば URL で足す", async () => {
    const { run, calls } = setup();
    assert.deepEqual(await run("browser.new", { private: true }), {
      id: "tcreated",
    });
    assert.deepEqual(await run("browser.new", { url: "https://c.example" }), {
      id: "tcreated2",
    });
    await refusal(() => run("browser.new", { url: "gopher://x" }));
    await refusal(() => run("browser.new", {}, LOCAL, "wnone"));
    assert.deepEqual(calls, [
      ["new", "gaaaaaaaaaa", true, { target: LOCAL, ws: "wlocal" }],
      [
        "newAt",
        "gaaaaaaaaaa",
        "https://c.example/",
        false,
        { target: LOCAL, ws: "wlocal" },
      ],
    ]);
  });

  it("external・devtools・login は人の画面を開く。login は殻の断りを理由にする", async () => {
    const { run, calls } = setup();
    await run("browser.external", { tab: "tpage" });
    await run("browser.devtools", { tab: "tpage" });
    await run("browser.login", { tab: "tpage" });
    assert.deepEqual(calls, [
      ["external", LOCAL, "https://example.com/a"],
      ["devtools", "tpage"],
      ["login", "tpage"],
    ]);
    const s = setup({ login: "not-allowed" });
    const e = await refusal(() => s.run("browser.login", { tab: "tpage" }));
    assert.match(e.message, /example\.com/);
  });

  it("bookmark add と bookmark list", async () => {
    const { run, calls } = setup();
    await run("browser.bookmark", { tab: "tpage" });
    assert.deepEqual(calls, [["bookmark", "tpage"]]);
    assert.deepEqual(await run("browser.bookmarks", {}), {
      bookmarks: [{ url: "https://a.example/", title: "A" }],
    });
  });
});

describe("kisui browser の届く範囲", () => {
  const all: [string, Record<string, unknown>][] = [
    ["browser.new", {}],
    ["browser.url", { tab: "tpage", url: "https://b.example" }],
    ["browser.back", { tab: "tpage" }],
    ["browser.forward", { tab: "tpage" }],
    ["browser.reload", { tab: "tpage" }],
    ["browser.stop", { tab: "tpage" }],
    ["browser.close", { tab: "tpage" }],
    ["browser.rename", { tab: "tpage", name: "x" }],
    ["browser.external", { tab: "tpage" }],
    ["browser.copyUrl", { tab: "tpage" }],
    ["browser.bookmark", { tab: "tpage" }],
    ["browser.bookmarks", {}],
    ["browser.find", { tab: "tpage", text: "a" }],
    ["browser.devtools", { tab: "tpage" }],
    ["browser.login", { tab: "tpage" }],
  ];

  it("リモートの Machine の Pane は、許されていなければ、どれにも届かない（Tab は無いときと同じ文で断る）", async () => {
    const { run, calls } = setup();
    for (const [name, args] of all) {
      const e = await refusal(() => run(name, args, "dev-vm", "wdev"));
      assert.match(
        e.message,
        name === "browser.new" || name === "browser.bookmarks"
          ? /allows dev-vm/
          : /No tab has the id or the name "tpage"/,
        name,
      );
    }
    assert.deepEqual(calls, []);
  });

  it("許している間は、リモートの Machine の Pane も届く", async () => {
    const { run, calls } = setup({ granted: true });
    await run("browser.reload", { tab: "tpage" }, "dev-vm", "wdev");
    assert.deepEqual(await run("browser.new", {}, "dev-vm", "wdev"), {
      id: "tcreated",
    });
    assert.deepEqual(calls, [
      ["nav", "tpage", "reload"],
      ["new", "gaaaaaaaaaa", false, { target: "dev-vm", ws: "wdev" }],
    ]);
  });

  it("許していても、操作のたびに聞く Pane があるうちは、URL を開く・外のブラウザ・DevTools・ログインを、リモートの Machine には通さない", async () => {
    const { run, calls } = setup({ granted: true, askEach: true });
    for (const [name, args] of [
      ["browser.new", { url: "https://c.example" }],
      ["browser.url", { tab: "tpage", url: "https://b.example" }],
      ["browser.external", { tab: "tpage" }],
      ["browser.devtools", { tab: "tpage" }],
      ["browser.login", { tab: "tpage" }],
    ] as const) {
      const e = await refusal(() => run(name, args, "dev-vm", "wdev"));
      assert.match(e.message, /ask the person every time/, name);
    }
    assert.deepEqual(calls, []);
    // 人が聞くと決めていても、手元の PC の Pane は通す。URL を開かない操作も通す
    await run("browser.devtools", { tab: "tpage" });
    await run("browser.reload", { tab: "tpage" }, "dev-vm", "wdev");
    assert.deepEqual(calls, [
      ["devtools", "tpage"],
      ["nav", "tpage", "reload"],
    ]);
  });
});
