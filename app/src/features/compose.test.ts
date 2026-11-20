// 機能の持ち物のつなぎ（compose.ts）を、偽の殻（kisui serve の代わり）で動かして確かめる（#313）。
// 動きは機能ごとの controller に分かれているので、controller の境目をまたぐ流れ
// （接続の知らせ → フォーカス、作る・閉じる → 移る、タブ → ブラウザのページ、shj の頼み → 画面）が、つないだあとも通ることを見る。
// 画面（.tsx）は node --test では描けないので、画面の側に頼むこと（FeatureUi）は、呼ばれたことを覚えるだけの偽物にする。
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, describe, it } from "node:test";

import type { BrowserOs } from "./browser/os.ts";
import type { StoredTabs } from "./browser/tabs.ts";
import type { CommandUi } from "./commands/run.ts";
import type { FeaturePorts, Features, FeatureUi } from "./compose.ts";
import type { KeyValueStore } from "./keyValueStore.ts";
import type { ClosedEvent, ShellApi } from "./sessions/shell.ts";
import type { Workspace } from "../infrastructure/rpc/protocol.ts";

// node では solid-js がサーバー用（反応しない作り）に解決されるので、ブラウザー用に向け直す
// （controller は solid-js を読むので、読み込む前に向け直す。テストのファイルごとに別のプロセスなので、ほかのテストには効かない）
registerHooks({
  resolve: (specifier, context, nextResolve) =>
    nextResolve(
      specifier === "solid-js" ? "solid-js/dist/solid.js" : specifier,
      context,
    ),
});
const { createRoot } = await import("solid-js");
const { createFeatures } = await import("./compose.ts");
const { LOCAL } = await import("./sessions/shell.ts");
const { termsOf } = await import("./workspaces/model.ts");

/** 待っている処理（返事・知らせ・effect）が済むまで待つ。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

/** マシン 1 台の kisui serve の代わり。ワークスペースの一覧と shj のフォーカスを持つ。 */
interface Serve {
  workspaces: Workspace[];
  focus: string | null;
  /** 受けた要求のメソッド名（届いた順） */
  methods: string[];
  /** GUI へ知らせを送る */
  notify(method: string, params: unknown): void;
}

/** 偽の殻。つなぎ先（target）ごとに Serve を 1 つ持ち、JSON-RPC の要求に答える。 */
function fakeShell(initial: Record<string, { ids: string[]; focus?: string }>) {
  type Line = (e: { id: string; line: string }) => void;
  const lines: Line[] = [];
  const closeds: ((e: ClosedEvent) => void)[] = [];
  const serves = new Map<string, Serve>();
  const connOf = new Map<string, string>(); // 接続の id -> target
  let seq = 0;
  const workspace = (id: string): Workspace => ({
    id,
    folder: null,
    kind: null,
    name: null,
    primary: `t-${id}`,
    terms: [],
    primaryShj: null,
    extras: [],
  });
  const serveOf = (target: string): Serve => {
    let s = serves.get(target);
    if (!s) {
      const init = initial[target] ?? { ids: [] };
      const emit = (obj: unknown) => {
        for (const [id, t] of connOf)
          if (t === target)
            lines.forEach((f) => f({ id, line: JSON.stringify(obj) }));
      };
      s = {
        workspaces: init.ids.map(workspace),
        focus: init.focus ?? null,
        methods: [],
        notify: (method, params) => emit({ jsonrpc: "2.0", method, params }),
      };
      serves.set(target, s);
    }
    return s;
  };
  const api: ShellApi = {
    listSshHosts: async () => ["host1"],
    configGui: async () => ({
      machines: [],
      browser: false,
      shortcuts: [],
      passkeyRejected: [],
    }),
    connect: async (id, target) => {
      connOf.set(id, target);
      serveOf(target);
      lines.forEach((f) => f({ id, line: "@@shj-rpc 1@@" }));
    },
    send: async (id, text) => {
      const target = connOf.get(id);
      if (target === undefined) return;
      const s = serveOf(target);
      const msg = JSON.parse(text);
      s.methods.push(msg.method);
      if (msg.id === undefined) return; // 通知
      const emit = (obj: unknown) =>
        queueMicrotask(() =>
          lines.forEach((f) => f({ id, line: JSON.stringify(obj) })),
        );
      const reply = (result: unknown) =>
        emit({ jsonrpc: "2.0", id: msg.id, result });
      const fail = (message: string) =>
        emit({ jsonrpc: "2.0", id: msg.id, error: { code: -32001, message } });
      switch (msg.method) {
        case "session.hello":
          reply({
            protocol: { major: 4, minor: 0 },
            encoding: "json",
            shj: { version: "1", commit: "x", channel: "stable" },
            serverId: `serve-${target}`,
            startedAt: "now",
            capabilities: [],
            workspaces: s.workspaces,
            rev: 1,
          });
          break;
        case "workspace.list":
          reply({ workspaces: s.workspaces, focus: s.focus });
          break;
        case "workspace.create": {
          const w = workspace(`w${++seq}`);
          s.workspaces = [...s.workspaces, w];
          // 本物と同じく、一覧の知らせは返事と前後しうる。ここでは知らせを先に送る
          s.notify("workspace.changed", { added: [w] });
          reply({ id: w.id });
          break;
        }
        case "workspace.focus":
          if (!s.workspaces.some((w) => w.id === msg.params.id)) {
            fail(`no such workspace: ${msg.params.id}`);
            break;
          }
          s.focus = msg.params.id;
          reply({ rev: 2 });
          break;
        case "workspace.close":
          s.workspaces = s.workspaces.filter((w) => w.id !== msg.params.id);
          if (s.focus === msg.params.id) s.focus = null;
          s.notify("workspace.changed", { removed: [msg.params.id] });
          reply({});
          break;
        case "session.ping":
        case "session.bye":
        case "tree.watch":
          reply({});
          break;
        default:
          fail(`not supported by the fake: ${msg.method}`);
      }
    },
    disconnect: async (id) => {
      connOf.delete(id);
    },
    askpassReply: async () => {},
    installPlan: async () => ({ version: "0", path: "p", release_url: "u" }),
    installRemote: async () => ({ path: "p", asset: "a", sha256: "h" }),
    installCancel: async () => {},
    onLine: async (f) => {
      lines.push(f);
      return () => void lines.splice(lines.indexOf(f), 1);
    },
    onClosed: async (f) => {
      closeds.push(f);
      return () => void closeds.splice(closeds.indexOf(f), 1);
    },
    onAskpass: async () => () => {},
    onAskpassDone: async () => () => {},
  };
  return { api, serveOf };
}

/** 偽のブラウザの殻。覚えているタブを返し、頼まれたことを覚える。 */
function fakeBrowser(
  stored: StoredTabs = { tabs: [] } as unknown as StoredTabs,
) {
  const calls: string[] = [];
  const off = async () => () => {};
  const os: BrowserOs = {
    openTab: async () => {},
    resolveTabUrl: async (_target, url) => url,
    moveTab: async () => {},
    showTabView: async () => {},
    focusTab: async () => {},
    goTab: async (tab, url) => void calls.push(`go ${tab} ${url}`),
    navTab: async (tab, action) => void calls.push(`nav ${tab} ${action}`),
    zoomTab: async () => {},
    findInTab: async () => false,
    openTabDevtools: async () => {},
    startPasskeyLogin: async () => "opened",
    loadBookmarks: async () => [],
    loadChromeBookmarks: async () => ({}),
    saveBookmarks: async () => {},
    closeTabView: async (tab) => void calls.push(`close ${tab}`),
    loadTabs: async () => stored,
    saveTabs: async () => {},
    onTabPage: off,
    onTabTitle: off,
    onTabFavicon: off,
    onTabKey: off,
    onTabPopup: off,
    onTabClosed: off,
    onDownload: off,
    openDownload: async () => {},
    revealDownload: async () => {},
    enableOverlay: async () => false,
    layerTab: async () => {},
  };
  return { os, calls };
}

function memoryStore(): KeyValueStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

const disposers: (() => void)[] = [];
afterEach(() => {
  // 接続を閉じ、タイマーを止める（残すと、テストのプロセスが終わらない）
  for (const d of disposers.splice(0)) d();
});

/** 機能の持ち物を、偽の殻につないで作る。 */
function start(opts: {
  serves?: Record<string, { ids: string[]; focus?: string }>;
  browser?: boolean;
  store?: KeyValueStore;
  stored?: StoredTabs;
}) {
  const shell = fakeShell(opts.serves ?? {});
  const browser = fakeBrowser(opts.stored);
  const store = opts.store ?? memoryStore();
  /** 画面の側に頼まれたこと（届いた順） */
  const ui: string[] = [];
  const featureUi: FeatureUi = {
    focusTerminal: () => void ui.push("focusTerminal"),
    forgetPageReturn: () => void ui.push("forgetPageReturn"),
    revealSidebar: () => void ui.push("revealSidebar"),
    restoreTreeScroll: () => void ui.push("restoreTreeScroll"),
    focusFind: () => void ui.push("focusFind"),
    requestStartFocus: (t, id) => void ui.push(`requestStartFocus ${t} ${id}`),
    focusExplorer: (t, id) => void ui.push(`focusExplorer ${t} ${id}`),
    focusChanges: (t, id) => void ui.push(`focusChanges ${t} ${id}`),
    copyToClipboard: async (text) => void ui.push(`copy ${text}`),
    showScale: (v) => void ui.push(`showScale ${v}`),
    showToast: (text) => void ui.push(`toast ${text}`),
  };
  const commandUi: CommandUi = {
    toggleResizeMode: () => void ui.push("toggleResizeMode"),
    toggleSidebar: () => void ui.push("toggleSidebar"),
    openMachines: () => void ui.push("openMachines"),
    openWorkspaceSwitcher: () => void ui.push("openWorkspaceSwitcher"),
    openClipboardHistory: () => void ui.push("openClipboardHistory"),
    openMascotPicker: () => void ui.push("openMascotPicker"),
    openKeyList: () => void ui.push("openKeyList"),
    focusUrlBar: () => void ui.push("focusUrlBar"),
    forgetPageReturn: () => void ui.push("forgetPageReturn"),
    copyToClipboard: async (text) => void ui.push(`copy ${text}`),
    dismissLastNotice: () => void ui.push("dismissLastNotice"),
  };
  const ports: FeaturePorts = {
    shell: shell.api,
    store,
    browser: browser.os,
    openUrl: async (target, url) => void ui.push(`openUrl ${target} ${url}`),
    applyScale: async () => {},
    mascot: {
      load: async () => null,
      reload: async () => null,
      commit: async () => {},
      list: async () => ({ root: "", current: null, entries: [] }),
      select: async () => {},
      frameUrl: (id) => id,
    },
    updates: {
      check: async () => null,
      checkNow: async () => ({ status: "latest", current: "1" }) as never,
      install: async () => {},
    },
  };
  let f!: Features;
  createRoot((dispose) => {
    disposers.push(dispose);
    f = createFeatures({
      ports,
      config: [],
      browser: opts.browser ?? false,
      mac: false,
      ui: featureUi,
      commandUi,
    });
  });
  return { f, ui, store, serve: shell.serveOf, browserCalls: browser.calls };
}

describe("機能の持ち物のつなぎ（compose.ts）", () => {
  it("起動すると「ローカル」につなぎ、一覧が空なら、ワークスペースを 1 つ作ってフォーカスし、ターミナルにキーを向ける", async () => {
    const { f, ui, serve, store } = start({});
    await settle();
    assert.equal(f.sessions.states()[LOCAL]?.kind, "connected");
    assert.equal(serve(LOCAL).workspaces.length, 1);
    const id = serve(LOCAL).workspaces[0]!.id;
    assert.deepEqual(f.workspaces.focus(), { target: LOCAL, id });
    assert.equal(serve(LOCAL).focus, id);
    // GUI のワークスペースが 1 つでき、中にそのターミナルのタブがある。記録にも残る
    assert.equal(f.workspaces.gws().list.length, 1);
    assert.deepEqual(
      termsOf(f.workspaces.gws().list[0]!).map((t) => [t.target, t.ws]),
      [[LOCAL, id]],
    );
    assert.equal(f.workspaces.rows().length, 1);
    assert.equal(f.workspaces.currentGws()?.id, f.workspaces.gws().list[0]!.id);
    assert.ok(
      [...(store as ReturnType<typeof memoryStore>).map.values()].some((v) =>
        v.includes(id),
      ),
    );
    assert.ok(ui.includes("focusTerminal"));
    assert.equal(f.focusError(), null);
    // フォーカスしているワークスペースのターミナルが出る（先頭がプライマリ）
    assert.equal(f.terminals.termList().length, 1);
  });

  it("一覧にワークスペースがあれば作らず、shj のフォーカスに合わせる", async () => {
    const { f, serve } = start({
      serves: { [LOCAL]: { ids: ["a", "b"], focus: "b" } },
    });
    await settle();
    assert.deepEqual(
      serve(LOCAL).workspaces.map((w) => w.id),
      ["a", "b"],
    );
    assert.ok(!serve(LOCAL).methods.includes("workspace.create"));
    assert.deepEqual(f.workspaces.focus(), { target: LOCAL, id: "b" });
    // マシンのワークスペース 1 つが、GUI のワークスペース 1 つになる
    assert.equal(f.workspaces.gws().list.length, 2);
    assert.equal(f.workspaces.rows().length, 2);
  });

  it("フォーカスしているワークスペースを閉じると、隣のワークスペースへ移り、shj にも伝える", async () => {
    const { f, serve } = start({
      serves: { [LOCAL]: { ids: ["a", "b"], focus: "a" } },
    });
    await settle();
    const current = f.workspaces.currentGws()!;
    await f.workspaces.closeWorkspace(current.id);
    await settle();
    assert.deepEqual(
      serve(LOCAL).workspaces.map((w) => w.id),
      ["b"],
    );
    assert.deepEqual(f.workspaces.focus(), { target: LOCAL, id: "b" });
    assert.equal(serve(LOCAL).focus, "b");
    assert.equal(f.workspaces.gws().list.length, 1);
    assert.equal(f.focusError(), null);
  });

  it("別のワークスペースへ移ると、フォーカスと shj のフォーカスが移り、ターミナルにキーを向ける", async () => {
    const { f, ui, serve } = start({
      serves: { [LOCAL]: { ids: ["a", "b"], focus: "a" } },
    });
    await settle();
    ui.length = 0;
    f.commands.runCommand({ id: "workspace.nth", arg: 1 });
    await settle();
    assert.deepEqual(f.workspaces.focus(), { target: LOCAL, id: "b" });
    assert.equal(serve(LOCAL).focus, "b");
    assert.ok(ui.includes("focusTerminal"));
    // 直前のワークスペースへ戻る（workspace.last）
    f.commands.runCommand({ id: "workspace.last" });
    await settle();
    assert.deepEqual(f.workspaces.focus(), { target: LOCAL, id: "a" });
  });

  it("ターミナルのタブを足すと同じワークスペースに入り、閉じると隣のタブへ戻る", async () => {
    const { f, serve } = start({
      serves: { [LOCAL]: { ids: ["a"], focus: "a" } },
    });
    await settle();
    const gid = f.workspaces.currentGws()!.id;
    await f.tabs.addWorkspaceTab(gid, "terminal");
    await settle();
    assert.equal(serve(LOCAL).workspaces.length, 2);
    const added = serve(LOCAL).workspaces[1]!.id;
    // GUI のワークスペースは増えず、タブが 2 つになる。足したタブにフォーカスが移る
    assert.equal(f.workspaces.gws().list.length, 1);
    assert.deepEqual(
      termsOf(f.workspaces.gws().list[0]!).map((t) => t.ws),
      ["a", added],
    );
    assert.deepEqual(f.workspaces.focus(), { target: LOCAL, id: added });

    f.commands.runCommand({ id: "tab.close" });
    await settle();
    assert.deepEqual(
      serve(LOCAL).workspaces.map((w) => w.id),
      ["a"],
    );
    assert.deepEqual(f.workspaces.focus(), { target: LOCAL, id: "a" });
    assert.deepEqual(
      termsOf(f.workspaces.gws().list[0]!).map((t) => t.ws),
      ["a"],
    );
  });

  it("内蔵ブラウザ：タブを足すとそのページが出て、閉じるとターミナルに戻る", async () => {
    const { f, ui, browserCalls } = start({
      serves: { [LOCAL]: { ids: ["a"], focus: "a" } },
      browser: true,
    });
    await settle();
    assert.equal(f.browserTabs.tabsReady(), true);
    assert.equal(f.pages.shownBrowserTab(), undefined);
    f.commands.runCommand({ id: "browser.new" });
    await settle();
    const tab = f.pages.shownBrowserTab();
    assert.ok(tab, "ブラウザのタブが出ていない");
    // 新しいタブのページ（URL が空）。ワークスペースの並びにも入る
    assert.equal(f.pages.newTabPageId(), tab.id);
    assert.equal(f.workspaces.gws().list[0]!.tabs.length, 2);
    assert.equal(f.tabs.currentTabKey()?.includes(tab.id), true);
    // URL を開くと、そのタブがページになる
    f.pages.submitUrlBar(tab.id, "https://example.com/");
    await settle();
    assert.equal(f.pages.pageTabId(), tab.id);
    assert.equal(f.pages.shownBrowserTab()?.url, "https://example.com/");
    assert.ok(browserCalls.includes(`go ${tab.id} https://example.com/`));
    // ペインの操作は、まずターミナルのグリッドに戻す（見えないペインは動かさない）
    ui.length = 0;
    f.commands.runCommand({ id: "browser.close" });
    await settle();
    assert.equal(f.pages.shownBrowserTab(), undefined);
    assert.equal(f.browserTabs.tabs().tabs.length, 0);
    assert.equal(f.workspaces.gws().list[0]!.tabs.length, 1);
    assert.ok(ui.includes("focusTerminal"));
  });

  it("内蔵ブラウザを使わないときは、ブラウザのタブを読まず、URL は外部ブラウザで開く", async () => {
    const { f, ui } = start({
      serves: { [LOCAL]: { ids: ["a"], focus: "a" } },
    });
    await settle();
    assert.equal(f.browserTabs.tabsReady(), false);
    f.pages.openUrlFor(LOCAL, "https://example.com/", "a");
    await settle();
    assert.ok(ui.includes(`openUrl ${LOCAL} https://example.com/`));
    assert.equal(f.browserTabs.tabs().tabs.length, 0);
  });

  it("shj の頼み（ツリーへ・CHANGES へ・URL を開く）を、受け持つ所へ渡す", async () => {
    const { f, ui, serve } = start({
      serves: { [LOCAL]: { ids: ["a"], focus: "a" } },
      browser: true,
    });
    await settle();
    ui.length = 0;
    serve(LOCAL).notify("explorer.focus", { workspaceId: "a" });
    serve(LOCAL).notify("explorer.focus", { workspaceId: "a", start: true });
    serve(LOCAL).notify("changes.focus", { workspaceId: "a" });
    serve(LOCAL).notify("browser.open", {
      workspaceId: "a",
      url: "https://example.com/x",
    });
    await settle();
    assert.deepEqual(
      ui.filter((u) => /Explorer|StartFocus|Changes/.test(u)),
      [
        `focusExplorer ${LOCAL} a`,
        `requestStartFocus ${LOCAL} a`,
        `focusChanges ${LOCAL} a`,
      ],
    );
    // 内蔵ブラウザを使っているので、そのワークスペースの新しいタブで開く
    assert.equal(f.pages.shownBrowserTab()?.url, "https://example.com/x");
  });

  it("リモートを足すと、つながってからマシンを記録し、窓を閉じる。外すと接続を切る", async () => {
    const { f, serve, store } = start({
      serves: {
        [LOCAL]: { ids: ["a"], focus: "a" },
        host1: { ids: ["r"], focus: "r" },
      },
    });
    await settle();
    assert.deepEqual(f.sessions.hosts(), ["host1"]);
    f.sessions.openAdd();
    f.sessions.submitAdd("host1", "");
    assert.equal(f.sessions.addPending()?.target, "host1");
    await settle();
    assert.equal(f.sessions.adding(), false);
    assert.equal(f.sessions.addPending(), null);
    assert.deepEqual(
      f.sessions.machines().map((m) => m.target),
      ["host1"],
    );
    assert.deepEqual(f.sessions.targets(), [LOCAL, "host1"]);
    assert.equal(f.sessions.states().host1?.kind, "connected");
    assert.ok(
      [...(store as ReturnType<typeof memoryStore>).map.values()].some((v) =>
        v.includes("host1"),
      ),
    );
    // リモートのワークスペースも並ぶ。フォーカスは「ローカル」のまま
    assert.equal(f.workspaces.rows().length, 2);
    assert.deepEqual(f.workspaces.focus(), { target: LOCAL, id: "a" });
    assert.equal(serve("host1").workspaces.length, 1);

    f.sessions.removeFromSidebar("host1");
    await settle();
    assert.deepEqual(f.sessions.targets(), [LOCAL]);
    assert.equal(f.sessions.sessions().host1, undefined);
    assert.deepEqual(f.workspaces.focus(), { target: LOCAL, id: "a" });
  });

  it("コマンドは、画面の側ですること（窓を出す・サイドバーの開閉）を CommandUi に頼む", async () => {
    const { f, ui } = start({
      serves: { [LOCAL]: { ids: ["a"], focus: "a" } },
    });
    await settle();
    ui.length = 0;
    f.commands.runCommand({ id: "machine.dialog" });
    f.commands.runCommand({ id: "workspace.switch" });
    f.commands.runCommand({ id: "sidebar.toggle" });
    f.commands.runCommand({ id: "pane.resize" });
    f.commands.runCommand({ id: "help.keys" });
    assert.deepEqual(ui, [
      "openMachines",
      "openWorkspaceSwitcher",
      "toggleSidebar",
      "toggleResizeMode",
      "openKeyList",
    ]);
    // できないことは、知らせに出す（ブラウザのタブを出していないときの o のコマンド）
    f.commands.runCommand({ id: "browser.reload" });
    assert.notEqual(f.focusError(), null);
  });
});
