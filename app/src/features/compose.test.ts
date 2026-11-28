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
import type { ConfigMachine } from "./sessions/machines.ts";
import type {
  AskpassRequest,
  ClosedEvent,
  ShellApi,
} from "./sessions/shell.ts";
import type { TermDefaults } from "./sessions/termDefaults.ts";
import type { ProxyFlow, Workspace } from "../infrastructure/rpc/protocol.ts";

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
  /** proxy.start の答えより先に送る知らせ（答えの一覧を作ったあとに変わった通信。#409） */
  lateFlow?: ProxyFlow;
  /** プロキシに通している単位（#409。scope → 待ち受け口・記録しているか・ワークスペース・通信） */
  proxy: Map<
    string,
    {
      port: number;
      recording: boolean;
      workspaceId?: string;
      flows: ProxyFlow[];
      /** 要求を止めるのを入れているか（#411） */
      holding?: boolean;
    }
  >;
  /** 受けた proxy.release のパラメータ（#411。届いた順） */
  released: Record<string, unknown>[];
  /** 受けた workspace.create のパラメータ（届いた順） */
  created: Record<string, unknown>[];
}

/** 偽の殻。つなぎ先（target）ごとに Serve を 1 つ持ち、JSON-RPC の要求に答える。 */
function fakeShell(
  initial: Record<
    string,
    { ids: string[]; focus?: string; capabilities?: string[] }
  >,
) {
  type Line = (e: { id: string; line: string }) => void;
  const lines: Line[] = [];
  const closeds: ((e: ClosedEvent) => void)[] = [];
  // ssh の質問の受け手（テストが質問を送る）
  const askeds: ((e: AskpassRequest) => void)[] = [];
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
        proxy: new Map(),
        released: [],
        created: [],
      };
      serves.set(target, s);
    }
    return s;
  };
  // config.local.toml のマシン（Dialog で足す・名前を変える・外すと書き換わる）
  const machines: ConfigMachine[] = [];
  // config.local.toml に書けない（読み取り専用など）ふりをするか
  const edit = { fail: false };
  // 設定ファイルの [server] の start_dir と shell（Dialog で変えると書き換わる。手で書き換えるふりもできる）
  const local: { terminal: TermDefaults } = { terminal: {} };
  const api: ShellApi = {
    listSshHosts: async () => ["host1"],
    configGui: async () => ({
      machines: machines.map((m) => ({ ...m })),
      browser: false,
      shortcuts: [],
      passkeyRejected: [],
      localTerminal: { ...local.terminal },
    }),
    editMachine: async (e) => {
      if (edit.fail)
        throw { kind: "file", detail: "/c/config.local.toml: 書けません" };
      const at = machines.findIndex((m) => m.ssh === e.ssh);
      if (e.kind === "add")
        machines.push({ ssh: e.ssh, name: e.name, local: true });
      else if (e.kind === "rename")
        machines[at] = { ...machines[at], name: e.name };
      else if (e.kind === "terminal")
        machines[at] = {
          ...machines[at],
          startDir: e.startDir,
          shell: e.shell,
        };
      else machines.splice(at, 1);
      return machines.map((m) => ({ ...m }));
    },
    editLocalTerminal: async (e) => {
      if (edit.fail) throw { kind: "notexec", detail: e.shell };
      local.terminal = { ...e };
      return { ...e };
    },
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
            capabilities: initial[target]?.capabilities ?? [],
            workspaces: s.workspaces,
            rev: 1,
          });
          break;
        case "workspace.list":
          reply({ workspaces: s.workspaces, focus: s.focus });
          break;
        case "workspace.create": {
          s.created.push(msg.params);
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
        case "proxy.list":
          reply({
            scopes: [...s.proxy].map(([scope, p]) => ({
              scope,
              port: p.port,
              recording: p.recording,
              workspaceId: p.workspaceId,
              holding: p.holding ?? false,
            })),
          });
          break;
        case "proxy.start": {
          const ws = msg.params.workspaceId as string | undefined;
          const scope = ws === undefined ? msg.params.scope : `ws:${ws}`;
          const p = s.proxy.get(scope) ?? {
            port: 40000 + s.proxy.size,
            recording: true,
            workspaceId: ws,
            flows: [],
          };
          p.recording = true;
          s.proxy.set(scope, p);
          if (s.lateFlow) s.notify("proxy.flow", { scope, flow: s.lateFlow });
          reply({
            scope,
            workspaceId: ws,
            port: p.port,
            recording: true,
            flows: p.flows,
          });
          break;
        }
        case "proxy.stop": {
          const p = s.proxy.get(msg.params.scope);
          if (!p) fail(`no such proxy: ${msg.params.scope}`);
          else {
            if (p.workspaceId === undefined) s.proxy.delete(msg.params.scope);
            else p.recording = false;
            reply({});
          }
          break;
        }
        case "proxy.flows":
          reply({ flows: s.proxy.get(msg.params.scope)?.flows ?? [] });
          break;
        case "proxy.hold": {
          const p = s.proxy.get(msg.params.scope);
          if (!p) fail(`no such proxy: ${msg.params.scope}`);
          else {
            p.holding = msg.params.on;
            reply({ holding: p.holding });
          }
          break;
        }
        case "proxy.release": {
          const f = s.proxy
            .get(msg.params.scope)
            ?.flows.find((x) => x.id === msg.params.id);
          if (!f || f.state !== "held")
            fail(`the request is not held: ${msg.params.id}`);
          else {
            s.released.push(msg.params);
            // 流した・捨てた通信は、知らせで進む
            Object.assign(
              f,
              msg.params.action === "drop"
                ? { state: "failed", error: "dropped in the proxy panel" }
                : { state: "pending", edited: msg.params.action === "edit" },
            );
            s.notify("proxy.flow", {
              scope: msg.params.scope,
              flow: { ...f },
            });
            reply({});
          }
          break;
        }
        case "proxy.detail": {
          const f = s.proxy
            .get(msg.params.scope)
            ?.flows.find((x) => x.id === msg.params.id);
          if (!f) fail("no such flow");
          else
            reply({
              ...f,
              protocol: "HTTP/1.1",
              reqHeaders: [["Accept", "*/*"]],
              respHeaders: [["Content-Type", "text/plain"]],
              reqBody: { size: 0 },
              respBody: { size: 2, text: "ok" },
            });
          break;
        }
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
    onAskpass: async (f) => {
      askeds.push(f);
      return () => void askeds.splice(askeds.indexOf(f), 1);
    },
    onAskpassDone: async () => () => {},
  };
  /** 殻が ssh の質問を Window へ渡したふりをする。 */
  const ask = (e: AskpassRequest) => askeds.forEach((f) => f(e));
  return { api, serveOf, machines, edit, local, ask };
}

/** 偽のブラウザの殻。覚えているタブを返し、頼まれたことを覚える。 */
function fakeBrowser(
  stored: StoredTabs = { tabs: [] } as unknown as StoredTabs,
) {
  const calls: string[] = [];
  const off = async () => () => {};
  /** 殻からの「読み込みが失敗した」の受け手（テストが知らせを送る） */
  const loadFailed: Parameters<BrowserOs["onTabLoadFailed"]>[0][] = [];
  /** 殻からの「読み込み中」「Esc が押された」の受け手 */
  const loading: Parameters<BrowserOs["onTabLoading"]>[0][] = [];
  const escape: Parameters<BrowserOs["onTabEscape"]>[0][] = [];
  const history: Parameters<BrowserOs["onTabHistory"]>[0][] = [];
  const os: BrowserOs = {
    openTab: async () => {},
    resolveTabUrl: async (_target, url) => url,
    moveTab: async () => {},
    showTabView: async () => {},
    focusTab: async () => {},
    goTab: async (tab, url) => void calls.push(`go ${tab} ${url}`),
    navTab: async (tab, action) => void calls.push(`nav ${tab} ${action}`),
    stopTab: async (tab) => void calls.push(`stop ${tab}`),
    zoomTab: async () => {},
    findInTab: async () => false,
    openTabDevtools: async () => {},
    startPasskeyLogin: async () => "opened",
    loadBookmarks: async () => [],
    loadFirefoxBookmarks: async () => ({}),
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
    onTabLoadFailed: async (h) => {
      loadFailed.push(h);
      return () => void loadFailed.splice(loadFailed.indexOf(h), 1);
    },
    onTabLoadCleared: off,
    onTabLoading: async (h) => {
      loading.push(h);
      return () => void loading.splice(loading.indexOf(h), 1);
    },
    onTabHistory: async (h) => {
      history.push(h);
      return () => void history.splice(history.indexOf(h), 1);
    },
    onTabEscape: async (h) => {
      escape.push(h);
      return () => void escape.splice(escape.indexOf(h), 1);
    },
    onDownload: off,
    onCookieMismatch: off,
    openDownload: async () => {},
    revealDownload: async () => {},
    enableOverlay: async () => false,
    layerTab: async () => {},
  };
  return { os, calls, loadFailed, loading, escape, history };
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
  serves?: Record<
    string,
    { ids: string[]; focus?: string; capabilities?: string[] }
  >;
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
    focusProxyPanel: () => void ui.push("focusProxyPanel"),
  };
  const commandUi: CommandUi = {
    toggleResizeMode: () => void ui.push("toggleResizeMode"),
    toggleSidebar: () => void ui.push("toggleSidebar"),
    openMachines: () => void ui.push("openMachines"),
    openWorkspaceSwitcher: (start) =>
      void ui.push(`openWorkspaceSwitcher ${start}`),
    openTabWindow: (kind) => {
      ui.push(`openTabWindow ${kind}`);
      return true;
    },
    openClipboardHistory: () => void ui.push("openClipboardHistory"),
    openMascotPicker: () => void ui.push("openMascotPicker"),
    openKeyList: () => void ui.push("openKeyList"),
    focusUrlBar: () => void ui.push("focusUrlBar"),
    focusDbTree: () => void ui.push("focusDbTree"),
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
    exportFile: async () => null,
    clipboardHistory: async () => [],
    dbConfig: {
      list: async () => ({ local: [], fixed: [] }),
      edit: async () => ({ local: [], fixed: [] }),
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
  return {
    f,
    ui,
    store,
    machines: shell.machines,
    edit: shell.edit,
    local: shell.local,
    ask: shell.ask,
    serve: shell.serveOf,
    browserCalls: browser.calls,
    loadFailed: browser.loadFailed,
    loading: browser.loading,
    escape: browser.escape,
    history: browser.history,
  };
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

  it("内蔵ブラウザ：ブラウザのタブの Dialog の操作（runBrowserOn）は、指したタブに行う。無いタブ・ページの無いタブには何もしない (#459)", async () => {
    const { f, browserCalls } = start({
      serves: { [LOCAL]: { ids: ["a"], focus: "a" } },
      browser: true,
    });
    await settle();
    f.commands.runCommand({ id: "browser.new" });
    await settle();
    const first = f.pages.shownBrowserTab()!;
    f.pages.submitUrlBar(first.id, "https://example.com/");
    await settle();
    f.commands.runCommand({ id: "browser.new" });
    await settle();
    const second = f.pages.shownBrowserTab()!;
    assert.notEqual(second.id, first.id);
    // 出しているのは 2 つ目（新しいタブのページ）。指した 1 つ目に行う
    browserCalls.length = 0;
    f.commands.runBrowserOn(first.id, "reload");
    f.commands.runBrowserOn(first.id, "back");
    await settle();
    assert.deepEqual(browserCalls, [
      `nav ${first.id} reload`,
      `nav ${first.id} back`,
    ]);
    // ページの無いタブ（新しいタブのページ）と、無いタブには何もしない
    browserCalls.length = 0;
    f.commands.runBrowserOn(second.id, "reload");
    f.commands.runBrowserOn("gone", "reload");
    await settle();
    assert.deepEqual(browserCalls, []);
  });

  it("内蔵ブラウザ：browser.rename・browser.close（設定の Shortcut。#459 で木から外した）は、タブ共通の処理で、ブラウザのタブを出しているときだけ動く", async () => {
    const { f } = start({
      serves: { [LOCAL]: { ids: ["a"], focus: "a" } },
      browser: true,
    });
    await settle();
    // ターミナルのタブを出している間は、名前を変えない・閉じない
    f.commands.runCommand({ id: "browser.rename" });
    f.commands.runCommand({ id: "browser.close" });
    await settle();
    assert.equal(f.tabs.renamingTab(), null);
    assert.equal(f.workspaces.gws().list[0]!.tabs.length, 1);
    f.commands.runCommand({ id: "browser.new" });
    await settle();
    const tab = f.pages.shownBrowserTab()!;
    f.commands.runCommand({ id: "browser.rename" });
    await settle();
    assert.ok(f.tabs.renamingTab()?.key.includes(tab.id));
    f.tabs.cancelTabRename();
    f.commands.runCommand({ id: "browser.close" });
    await settle();
    assert.equal(f.browserTabs.tabs().tabs.length, 0);
    assert.equal(f.workspaces.gws().list[0]!.tabs.length, 1);
  });

  it("内蔵ブラウザ：読み込みが失敗したままのタブの「読み込み直す」は、前のページでなく、開けなかった URL を開き直す (#432)", async () => {
    const { f, browserCalls, loadFailed } = start({
      serves: { [LOCAL]: { ids: ["a"], focus: "a" } },
      browser: true,
    });
    await settle();
    f.commands.runCommand({ id: "browser.new" });
    await settle();
    const tab = f.pages.shownBrowserTab()!;
    f.pages.submitUrlBar(tab.id, "https://example.com/");
    await settle();
    // 失敗していなければ、WebView の読み込み直し
    browserCalls.length = 0;
    f.commands.runCommand({ id: "browser.reload" });
    await settle();
    assert.deepEqual(browserCalls, [`nav ${tab.id} reload`]);
    // 別の URL がページの出る前に失敗した（WebView には example.com が残っている）
    const failed = "https://self-signed.badssl.com/";
    for (const h of loadFailed)
      h({ tab: tab.id, url: failed, reason: "cert-untrusted", detail: "" });
    await settle();
    assert.equal(f.pages.shownBrowserTab()?.loadError?.url, failed);
    // ブラウザのタブの Dialog の r・Cmd+R も、失敗の表示の「もう一度開く」（navPage）も、開けなかった URL を開く
    browserCalls.length = 0;
    f.commands.runCommand({ id: "browser.reload" });
    f.pages.navPage(tab.id, "reload");
    await settle();
    assert.deepEqual(browserCalls, [
      `go ${tab.id} ${failed}`,
      `go ${tab.id} ${failed}`,
    ]);
    // 戻る・進むは、失敗していてもそのまま WebView に頼む
    browserCalls.length = 0;
    f.pages.navPage(tab.id, "back");
    await settle();
    assert.deepEqual(browserCalls, [`nav ${tab.id} back`]);
  });

  it("内蔵ブラウザ：読み込み中は、ブラウザのタブの Dialog の c・URL バーの「×」・ページの Esc のどれでも止まる。読み込み中でなければ何もしない (#449)", async () => {
    const { f, browserCalls, loading, escape } = start({
      serves: { [LOCAL]: { ids: ["a"], focus: "a" } },
      browser: true,
    });
    await settle();
    f.commands.runCommand({ id: "browser.new" });
    await settle();
    const tab = f.pages.shownBrowserTab()!;
    f.pages.submitUrlBar(tab.id, "https://example.com/");
    await settle();
    const send = (l: boolean, progress = 0) => {
      for (const h of loading) h({ tab: tab.id, loading: l, progress });
    };
    // 読み込み中でなければ、browser.stop も Esc も何もしない（Esc はページが受けるだけ）
    browserCalls.length = 0;
    f.commands.runCommand({ id: "browser.stop" });
    for (const h of escape) h({ tab: tab.id });
    await settle();
    assert.deepEqual(browserCalls, []);
    // 読み込み中は進み具合が入り、止めるとすぐ印が消える
    send(true, 30);
    await settle();
    assert.deepEqual(f.pages.shownBrowserTab()?.loading, { progress: 30 });
    f.commands.runCommand({ id: "browser.stop" });
    await settle();
    assert.deepEqual(browserCalls, [`stop ${tab.id}`]);
    assert.equal(f.pages.shownBrowserTab()?.loading, undefined);
    // 「×」（stopPage）と Esc も同じ
    for (const via of ["button", "escape"]) {
      browserCalls.length = 0;
      send(true, 50);
      await settle();
      if (via === "button") f.pages.stopPage(tab.id);
      else for (const h of escape) h({ tab: tab.id });
      await settle();
      assert.deepEqual(browserCalls, [`stop ${tab.id}`], via);
    }
    // 読み込みが終われば印が消える
    send(true, 80);
    send(false);
    await settle();
    assert.equal(f.pages.shownBrowserTab()?.loading, undefined);
  });

  it("内蔵ブラウザ：戻る先・進む先の有無は、殻の知らせのとおりにタブに入る。開いた直後はどちらも無い (#450)", async () => {
    const { f, history } = start({
      serves: { [LOCAL]: { ids: ["a"], focus: "a" } },
      browser: true,
    });
    await settle();
    f.commands.runCommand({ id: "browser.new" });
    await settle();
    const tab = f.pages.shownBrowserTab()!;
    f.pages.submitUrlBar(tab.id, "https://example.com/");
    await settle();
    assert.equal(f.pages.shownBrowserTab()?.history, undefined);
    const send = (back: boolean, forward: boolean) => {
      for (const h of history) h({ tab: tab.id, back, forward });
    };
    send(true, false);
    await settle();
    assert.deepEqual(f.pages.shownBrowserTab()?.history, {
      back: true,
      forward: false,
    });
    send(true, true);
    await settle();
    assert.deepEqual(f.pages.shownBrowserTab()?.history, {
      back: true,
      forward: true,
    });
    send(false, true);
    await settle();
    assert.deepEqual(f.pages.shownBrowserTab()?.history, {
      back: false,
      forward: true,
    });
  });

  it("内蔵ブラウザ：タブの無いワークスペースで o n を押すと、そのワークスペースにタブが入り、ワークスペースは増えない (#416)", async () => {
    const { f } = start({
      serves: { [LOCAL]: { ids: ["a"], focus: "a" } },
      browser: true,
    });
    await settle();
    const made = f.workspaces.createEmptyWorkspace("empty");
    assert.ok("id" in made);
    f.workspaces.showGws(made.id);
    await settle();
    assert.equal(f.workspaces.currentId(), made.id);
    const before = f.workspaces.gws().list.length;
    f.commands.runCommand({ id: "browser.new" });
    await settle();
    const list = f.workspaces.gws().list;
    assert.equal(list.length, before);
    const g = list.find((x) => x.id === made.id)!;
    assert.equal(g.tabs.length, 1);
    assert.equal(g.tabs[0]!.kind, "browser");
    assert.equal(f.workspaces.currentId(), made.id);
  });

  it("内蔵ブラウザ：ブラウザのタブだけのワークスペースで o n を押しても、そのワークスペースにタブが入り、増えない (#416)", async () => {
    const { f } = start({
      serves: { [LOCAL]: { ids: ["a"], focus: "a" } },
      browser: true,
    });
    await settle();
    f.workspaces.createBrowserWorkspace();
    await settle();
    const gid = f.workspaces.currentId()!;
    const before = f.workspaces.gws().list.length;
    f.commands.runCommand({ id: "browser.new" });
    await settle();
    const list = f.workspaces.gws().list;
    assert.equal(list.length, before);
    assert.equal(list.find((x) => x.id === gid)!.tabs.length, 2);
    assert.equal(f.workspaces.currentId(), gid);
  });

  it("内蔵ブラウザ：w n のブラウザは、ブラウザのタブ 1 つのワークスペースを 1 つだけ作ってそこへ移る (#416)", async () => {
    const { f } = start({
      serves: { [LOCAL]: { ids: ["a"], focus: "a" } },
      browser: true,
    });
    await settle();
    const before = f.workspaces.gws().list.length;
    f.workspaces.createBrowserWorkspace();
    await settle();
    const list = f.workspaces.gws().list;
    assert.equal(list.length, before + 1);
    const gid = f.workspaces.currentId()!;
    const g = list.find((x) => x.id === gid);
    assert.ok(g, "移った先のワークスペースが記録に無い");
    assert.equal(g.tabs.length, 1);
    assert.equal(g.tabs[0]!.kind, "browser");
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

  it("リモートを足すと、つながってから config.local.toml に書き、Dialog を閉じる。外すと config.local.toml から消し、接続を切る", async () => {
    const { f, serve, machines } = start({
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
    // localStorage でなく config.local.toml に書いた
    assert.deepEqual(machines, [{ ssh: "host1", name: null, local: true }]);
    // リモートのワークスペースも並ぶ。フォーカスは「ローカル」のまま
    assert.equal(f.workspaces.rows().length, 2);
    assert.deepEqual(f.workspaces.focus(), { target: LOCAL, id: "a" });
    assert.equal(serve("host1").workspaces.length, 1);

    f.sessions.removeFromSidebar("host1");
    await settle();
    assert.deepEqual(machines, []);
    assert.deepEqual(f.sessions.targets(), [LOCAL]);
    assert.equal(f.sessions.sessions().host1, undefined);
    assert.deepEqual(f.workspaces.focus(), { target: LOCAL, id: "a" });
  });

  it("config.local.toml に書けなければ、足す Dialog に理由を出して切る。名前を変える・外すも、理由を出して変えない", async () => {
    const { f, machines, edit } = start({
      serves: {
        [LOCAL]: { ids: ["a"], focus: "a" },
        host1: { ids: ["r"], focus: "r" },
      },
    });
    await settle();
    // 足す：書けなければ、Dialog は開いたまま理由を出し、一覧に入れず、接続を切る
    edit.fail = true;
    f.sessions.openAdd();
    f.sessions.submitAdd("host1", "");
    await settle();
    assert.equal(f.sessions.adding(), true);
    assert.equal(f.sessions.addPending(), null);
    assert.equal(
      f.sessions.addError(),
      "Could not write config.local.toml: /c/config.local.toml: 書けません",
    );
    assert.deepEqual(f.sessions.targets(), [LOCAL]);
    assert.equal(f.sessions.sessions().host1, undefined);
    assert.deepEqual(machines, []);

    // 書けるようになれば足せる
    edit.fail = false;
    f.sessions.submitAdd("host1", "");
    await settle();
    assert.equal(f.sessions.adding(), false);
    assert.deepEqual(f.sessions.targets(), [LOCAL, "host1"]);

    // 名前を変える：config.local.toml の名前が変わり、入力欄を閉じる
    f.sessions.openRename("host1");
    f.sessions.submitRename("host1", "ホスト");
    await settle();
    assert.equal(f.sessions.renaming(), null);
    assert.deepEqual(machines, [{ ssh: "host1", name: "ホスト", local: true }]);
    assert.equal(f.sessions.labelOf("host1"), "ホスト");
    // 書けなければ、入力欄に理由を出し、名前は変えない
    edit.fail = true;
    f.sessions.openRename("host1");
    f.sessions.submitRename("host1", "別");
    await settle();
    assert.equal(f.sessions.renaming(), "host1");
    assert.match(f.sessions.renameError() ?? "", /書けません/);
    assert.equal(f.sessions.labelOf("host1"), "ホスト");
    f.sessions.closeRename();

    // 外す：書けなければ、右下の知らせに理由を出し、一覧にも残し、接続も切らない
    f.sessions.removeFromSidebar("host1");
    await settle();
    assert.equal(f.focusError()?.title, "Could not remove ホスト");
    assert.match(f.focusError()?.error ?? "", /書けません/);
    assert.deepEqual(f.sessions.targets(), [LOCAL, "host1"]);
    assert.equal(f.sessions.states().host1?.kind, "connected");
    assert.equal(machines.length, 1);
  });

  it("ssh の質問の Dialog に出すマシンは、その質問を出した接続の行き先のマシン（サイドバーの名前・ssh の行き先・色）", async () => {
    const { f, ask } = start({
      serves: {
        [LOCAL]: { ids: ["a"], focus: "a" },
        host1: { ids: ["r"], focus: "r" },
      },
    });
    await settle();
    f.sessions.openAdd();
    f.sessions.submitAdd("host1", "本番");
    await settle();
    assert.deepEqual(f.sessions.targets(), [LOCAL, "host1"]);

    // 質問の文は、つなぎ先のサーバーが決められる（別のマシンの名前も書ける）。Dialog に出すマシンは、殻が渡した行き先で決まる
    ask({
      requestId: 1,
      conn: "c1",
      target: "host1",
      prompt: "(other-host) Password:",
    });
    const asked = f.sessions.asks()[0];
    assert.equal(asked?.prompt, "(other-host) Password:");
    assert.deepEqual(f.sessions.askMachine(asked!.target), {
      label: "本番",
      target: "host1",
      color: f.sessions.colors().host1,
    });
    assert.notEqual(f.sessions.colors().host1, undefined);

    // サイドバーにまだ無いマシン（足すためにつないでいる最中）の質問は、行き先をそのまま出す
    ask({ requestId: 2, conn: "c2", target: "host2", prompt: "Password:" });
    assert.deepEqual(f.sessions.askMachine(f.sessions.asks()[1]!.target), {
      label: "host2",
    });
  });

  it("マシンのターミナルの始め方を変えると config.local.toml に書き、次に作るターミナルから kisui serve に渡す（設定は作るたびに読み直す）", async () => {
    const cap = ["workspace.create.shell"];
    const { f, serve, machines, local, edit } = start({
      serves: {
        [LOCAL]: { ids: ["a"], focus: "a", capabilities: cap },
        host1: { ids: ["r"], focus: "r", capabilities: cap },
        old: { ids: ["o"], focus: "o" },
      },
    });
    await settle();
    for (const t of ["host1", "old"]) {
      f.sessions.openAdd();
      f.sessions.submitAdd(t, "");
      await settle();
    }
    // 何も書いていなければ、空で渡す（そのマシンの設定のまま）
    await f.workspaces.createWorkspace("host1");
    assert.deepEqual(serve("host1").created, [{ startDir: "", shell: "" }]);

    // リモート：[[gui.machines]] の項目に書く。前後の空白は除く
    await f.sessions.openTermEdit("host1");
    assert.deepEqual(f.sessions.termEditing(), { target: "host1", values: {} });
    f.sessions.submitTermEdit(" ~/work ", "/usr/bin/fish");
    await settle();
    assert.equal(f.sessions.termEditing(), null);
    assert.deepEqual(machines[0], {
      ssh: "host1",
      name: null,
      local: true,
      startDir: "~/work",
      shell: "/usr/bin/fish",
    });
    await f.workspaces.createWorkspace("host1");
    assert.deepEqual(serve("host1").created[1], {
      startDir: "~/work",
      shell: "/usr/bin/fish",
    });
    // 開き直すと、今の値が入っている。形の違う値は書かずに、理由を出す
    await f.sessions.openTermEdit("host1");
    assert.deepEqual(f.sessions.termEditing()?.values, {
      startDir: "~/work",
      shell: "/usr/bin/fish",
    });
    f.sessions.submitTermEdit("work", "");
    assert.match(f.sessions.termEditError() ?? "", /absolute path/);
    f.sessions.submitTermEdit("", "fish -l");
    assert.match(f.sessions.termEditError() ?? "", /absolute path/);
    assert.equal(machines[0].startDir, "~/work");
    // 空にすると消す
    f.sessions.submitTermEdit("", "");
    await settle();
    assert.equal(f.sessions.termEditing(), null);
    assert.deepEqual([machines[0].startDir, machines[0].shell], [null, null]);

    // ローカル：[server] に書く。殻が断れば（この PC で実行できない）、理由を出して Dialog を閉じない
    await f.sessions.openTermEdit(LOCAL);
    edit.fail = true;
    f.sessions.submitTermEdit("", "~/bin/none");
    await settle();
    assert.equal(f.sessions.termEditing()?.target, LOCAL);
    assert.equal(
      f.sessions.termEditError(),
      "~/bin/none is not a file that can be run on this computer",
    );
    edit.fail = false;
    f.sessions.submitTermEdit("~/src", "/bin/zsh");
    await settle();
    assert.equal(f.sessions.termEditing(), null);
    assert.deepEqual(local.terminal, { startDir: "~/src", shell: "/bin/zsh" });
    await f.workspaces.createWorkspace(LOCAL);
    assert.deepEqual(serve(LOCAL).created.at(-1), {
      startDir: "~/src",
      shell: "/bin/zsh",
    });
    // 設定ファイルを手で書き換えても、kisui serve を止めずに、次のターミナルから効く
    local.terminal = { shell: "/bin/bash" };
    await f.workspaces.createWorkspace(LOCAL);
    assert.deepEqual(serve(LOCAL).created.at(-1), {
      startDir: "",
      shell: "/bin/bash",
    });

    // 印の無い古い kisui serve には、設定があっても送らない
    await f.sessions.openTermEdit("old");
    f.sessions.submitTermEdit("~/work", "/bin/zsh");
    await settle();
    assert.equal(machines[1].shell, "/bin/zsh");
    await f.workspaces.createWorkspace("old");
    assert.deepEqual(serve("old").created, [{}]);
  });

  it("コマンドは、画面の側ですること（Dialog を出す・サイドバーの開閉）を CommandUi に頼む", async () => {
    const { f, ui } = start({
      serves: { [LOCAL]: { ids: ["a"], focus: "a" } },
    });
    await settle();
    ui.length = 0;
    f.commands.runCommand({ id: "machine.dialog" });
    f.commands.runCommand({ id: "workspace.switch" });
    f.commands.runCommand({ id: "workspace.switch", arg: "tab" });
    f.commands.runCommand({ id: "workspace.switch", arg: "newTab" });
    f.commands.runCommand({ id: "sidebar.toggle" });
    f.commands.runCommand({ id: "pane.resize" });
    f.commands.runCommand({ id: "help.keys" });
    assert.deepEqual(ui, [
      "openMachines",
      "openWorkspaceSwitcher ws",
      "openWorkspaceSwitcher tab",
      "openWorkspaceSwitcher newTab",
      "toggleSidebar",
      "toggleResizeMode",
      "openKeyList",
    ]);
    // できないことは、知らせに出す（ブラウザのタブを出していないときの o のコマンド）
    f.commands.runCommand({ id: "browser.reload" });
    assert.notEqual(f.focusError(), null);
  });

  const flow = (id: number, over: Partial<ProxyFlow> = {}): ProxyFlow => ({
    id,
    time: 0,
    method: "GET",
    scheme: "https",
    host: "example.com",
    path: "/",
    status: 200,
    state: "done",
    reqSize: 0,
    respSize: 2,
    durationMs: 1,
    ...over,
  });

  it("プロキシ：CLI（kisui proxy。#517）が指した、出していないタブは、通し始め・止め・やめても、キーを動かさない", async () => {
    const { f, ui, serve } = start({
      serves: {
        [LOCAL]: {
          ids: ["a", "b"],
          focus: "a",
          capabilities: ["proxy", "proxy.hold"],
        },
      },
    });
    await settle();
    const s = f.proxy.subjectOf({
      kind: "term",
      target: LOCAL,
      ws: "b",
      title: "",
    });
    assert.ok(s);
    const fails: unknown[] = [];
    const fail = (p: unknown) => void fails.push(p);
    // 通していないタブを止める・やめるのは、理由を返してできない
    assert.equal(await f.proxy.holdOf(s, true, fail), false);
    assert.equal(await f.proxy.stopOf(s, fail), false);
    assert.equal(fails.length, 2);
    assert.equal(f.focusError(), null, "Notice には出さない");
    ui.length = 0;
    assert.equal(await f.proxy.openPanelOf(s, fail), true);
    assert.deepEqual([...serve(LOCAL).proxy.keys()], ["ws:b"]);
    assert.deepEqual(f.proxy.stateOf(s), {
      port: 40000,
      holding: false,
      held: 0,
    });
    // 出しているのは a なので、パネルは出ず、キーも動かない
    assert.equal(f.proxy.panel(), undefined);
    assert.equal(await f.proxy.holdOf(s, true, fail), true);
    assert.equal(f.proxy.stateOf(s)?.holding, true);
    assert.equal(f.proxy.closePanelOf(s), true);
    await settle();
    assert.equal(f.proxy.stateOf(s)?.holding, false);
    assert.equal(await f.proxy.stopOf(s, fail), true);
    assert.equal(f.proxy.stateOf(s), undefined);
    assert.ok(!ui.includes("focusProxyPanel"));
    assert.ok(!ui.includes("focusTerminal"));
    assert.equal(fails.length, 2);
    // Database tab は通せない
    assert.equal(
      f.proxy.subjectOf({
        kind: "db",
        id: "d1",
        target: LOCAL,
        connection: "main",
      }),
      undefined,
    );
  });

  it("プロキシ：ターミナルのタブでパネルを開くと、そのワークスペースを通し始め、通信が一覧に出る。閉じても通したまま、やめると外れる", async () => {
    const { f, ui, serve } = start({
      serves: { [LOCAL]: { ids: ["a"], focus: "a", capabilities: ["proxy"] } },
    });
    await settle();
    assert.equal(f.proxy.panel(), undefined);
    ui.length = 0;
    f.commands.runCommand({ id: "proxy.panel" });
    await settle();
    assert.deepEqual([...serve(LOCAL).proxy.keys()], ["ws:a"]);
    const panel = f.proxy.panel();
    assert.ok(panel, "パネルが出ていない");
    assert.equal(panel.subject.kind, "term");
    assert.equal(panel.scope.port, 40000);
    assert.ok(ui.includes("focusProxyPanel"));
    // サイドバーのタブの行に、通している印が出る
    const proxiedRows = () =>
      f.workspaces.rows().flatMap((r) => r.tabs.items.map((t) => !!t.proxied));
    assert.deepEqual(proxiedRows(), [true]);
    // 通信の知らせが一覧に入り、同じ id は置き換わる
    serve(LOCAL).notify("proxy.flow", {
      scope: "ws:a",
      flow: flow(1, { state: "pending", status: 0 }),
    });
    serve(LOCAL).notify("proxy.flow", { scope: "ws:a", flow: flow(1) });
    // ほかの単位の知らせは入れない
    serve(LOCAL).notify("proxy.flow", { scope: "ws:zzz", flow: flow(9) });
    await settle();
    assert.deepEqual(
      f.proxy.panel()?.scope.flows.map((x) => [x.id, x.status]),
      [[1, 200]],
    );
    // 選ぶと中身を読む
    serve(LOCAL).proxy.get("ws:a")!.flows.push(flow(1));
    f.proxy.step("next");
    await settle();
    assert.equal(f.proxy.panel()?.selected, 1);
    assert.equal(f.proxy.panel()?.detail?.detail?.respBody.text, "ok");
    // もう開いているときは、キーを向けるだけ（通し直さない）
    const starts = () =>
      serve(LOCAL).methods.filter((m) => m === "proxy.start").length;
    assert.equal(starts(), 1);
    f.commands.runCommand({ id: "proxy.panel" });
    await settle();
    assert.equal(starts(), 1);
    // 閉じても、通したまま
    ui.length = 0;
    f.commands.runCommand({ id: "proxy.close" });
    assert.equal(f.proxy.panel(), undefined);
    assert.equal(f.proxy.proxied(), true);
    assert.ok(ui.includes("focusTerminal"));
    assert.ok(!serve(LOCAL).methods.includes("proxy.stop"));
    // やめる
    f.commands.runCommand({ id: "proxy.stop" });
    await settle();
    assert.equal(f.proxy.proxied(), false);
    assert.deepEqual(proxiedRows(), [false]);
    assert.equal(serve(LOCAL).proxy.get("ws:a")?.recording, false);
    assert.equal(f.focusError(), null);
    // 通していないタブで「やめる」は、できないと知らせる
    f.commands.runCommand({ id: "proxy.stop" });
    await settle();
    assert.notEqual(f.focusError(), null);
  });

  it("プロキシ：要求を止めるのを入れると、止まった要求が選ばれ、流す・書き換えて流す・捨てるを kisui serve に頼む。パネルを閉じると、止めるのをやめる（#411）", async () => {
    const { f, ui, serve } = start({
      serves: {
        [LOCAL]: {
          ids: ["a"],
          focus: "a",
          capabilities: ["proxy", "proxy.resend", "proxy.hold"],
        },
      },
    });
    await settle();
    // 通していないタブでは、できないと知らせる
    f.commands.runCommand({ id: "proxy.hold" });
    await settle();
    assert.notEqual(f.focusError(), null);
    assert.ok(!serve(LOCAL).methods.includes("proxy.hold"));

    f.commands.runCommand({ id: "proxy.panel" });
    await settle();
    f.commands.runCommand({ id: "proxy.close" });
    assert.equal(f.proxy.panel(), undefined);
    // パネルを閉じていても、リーダーから入れられる。入れると、パネルが開く
    ui.length = 0;
    f.commands.runCommand({ id: "proxy.hold" });
    await settle();
    const sc = serve(LOCAL).proxy.get("ws:a")!;
    assert.equal(sc.holding, true);
    assert.equal(f.proxy.panel()?.scope.holding, true);
    assert.ok(ui.includes("focusProxyPanel"));

    // 止まった要求が届くと、それが選ばれる
    const held = (id: number) => flow(id, { status: 0, state: "held" });
    const arrive = (id: number) => {
      sc.flows.push(held(id));
      serve(LOCAL).notify("proxy.flow", { scope: "ws:a", flow: held(id) });
    };
    arrive(1);
    await settle();
    assert.equal(f.proxy.panel()?.selected, 1);
    // 止めている要求を選んでいる間は、次に止まった要求に選び直さない
    arrive(2);
    arrive(3);
    await settle();
    assert.equal(f.proxy.panel()?.selected, 1);

    // そのまま流す。次に古い、止めている要求が選ばれる
    await f.proxy.releaseHeld("forward");
    await settle();
    assert.deepEqual(serve(LOCAL).released, [
      { scope: "ws:a", id: 1, action: "forward" },
    ]);
    assert.equal(f.proxy.panel()?.scope.flows[0]?.state, "pending");
    assert.equal(f.proxy.panel()?.selected, 2);

    // 書き換えて流す：欄を開いて送ると、送り直すのではなく、止めた要求を書き換えて流す
    await f.proxy.startEdit();
    assert.equal(f.proxy.panel()?.edit?.held, true);
    f.proxy.editDraft({ url: "https://example.com/edited" });
    await f.proxy.sendEdit();
    await settle();
    assert.deepEqual(serve(LOCAL).released[1], {
      scope: "ws:a",
      id: 2,
      action: "edit",
      method: "GET",
      url: "https://example.com/edited",
      headers: [["Accept", "*/*"]],
      body: "",
    });
    assert.ok(!serve(LOCAL).methods.includes("proxy.resend"));
    assert.equal(f.proxy.panel()?.edit, undefined);
    assert.equal(f.proxy.panel()?.scope.flows[1]?.edited, true);
    assert.equal(f.proxy.panel()?.selected, 3);

    // 捨てる。ほかに止めている要求が無ければ、選んだまま
    await f.proxy.releaseHeld("drop");
    await settle();
    assert.equal(serve(LOCAL).released[2]?.action, "drop");
    assert.equal(f.proxy.panel()?.selected, 3);
    assert.equal(f.proxy.panel()?.scope.flows[2]?.state, "failed");
    // 止めていない通信は、流せないと知らせる
    const before = f.focusError();
    await f.proxy.releaseHeld("forward");
    assert.notDeepEqual(f.focusError(), before);
    assert.equal(serve(LOCAL).released.length, 3);

    // パネルを閉じると、止めるのをやめる
    f.commands.runCommand({ id: "proxy.close" });
    await settle();
    assert.equal(sc.holding, false);
    f.commands.runCommand({ id: "proxy.panel" });
    await settle();
    assert.equal(f.proxy.panel()?.scope.holding, false);
  });

  it("プロキシ：ブラウザのタブでパネルを開くと、そのタブに待ち受け口が付く（画面が webview を作り直す）。タブを閉じると止める", async () => {
    const { f, serve } = start({
      serves: { [LOCAL]: { ids: ["a"], focus: "a", capabilities: ["proxy"] } },
      browser: true,
    });
    await settle();
    f.commands.runCommand({ id: "browser.new" });
    await settle();
    const tab = f.pages.shownBrowserTab()!;
    f.pages.submitUrlBar(tab.id, "https://example.com/");
    await settle();
    f.commands.runCommand({ id: "proxy.panel" });
    await settle();
    const scope = `browser:${tab.id}`;
    assert.deepEqual([...serve(LOCAL).proxy.keys()], [scope]);
    assert.deepEqual(f.pages.shownBrowserTab()?.proxy, { scope, port: 40000 });
    assert.equal(f.proxy.panel()?.subject.kind, "browser");
    // ターミナルのタブに移ると、そのタブのパネルは出ない（タブごとに開く）。戻ると出る
    const gid = f.workspaces.currentGws()!.id;
    f.tabs.goNthTab(0);
    await settle();
    assert.equal(f.pages.shownBrowserTab(), undefined);
    assert.equal(f.proxy.panel(), undefined);
    assert.equal(f.proxy.proxied(), false);
    f.tabs.goNthTab(1);
    await settle();
    assert.equal(f.workspaces.currentGws()!.id, gid);
    assert.ok(f.proxy.panel());
    // タブを閉じると、その単位を止める
    f.commands.runCommand({ id: "browser.close" });
    await settle();
    assert.equal(serve(LOCAL).proxy.size, 0);
    assert.equal(f.proxy.panel(), undefined);
  });

  it("プロキシ：やめると、ブラウザのタブから待ち受け口が外れる（画面がプロキシ無しで作り直す）", async () => {
    const { f, serve } = start({
      serves: { [LOCAL]: { ids: ["a"], focus: "a", capabilities: ["proxy"] } },
      browser: true,
    });
    await settle();
    f.commands.runCommand({ id: "browser.new" });
    await settle();
    f.commands.runCommand({ id: "proxy.panel" });
    await settle();
    assert.ok(f.pages.shownBrowserTab()?.proxy);
    f.commands.runCommand({ id: "proxy.stop" });
    await settle();
    assert.equal(f.pages.shownBrowserTab()?.proxy, undefined);
    assert.equal(serve(LOCAL).proxy.size, 0);
    assert.equal(f.proxy.panel(), undefined);
  });

  it("プロキシ：古い kisui serve（プロキシの印が無い）・通せるタブを出していないときは、できないと知らせる", async () => {
    const { f, serve } = start({
      serves: { [LOCAL]: { ids: ["a"], focus: "a" } },
    });
    await settle();
    f.commands.runCommand({ id: "proxy.panel" });
    await settle();
    assert.notEqual(f.focusError(), null);
    assert.ok(!serve(LOCAL).methods.includes("proxy.start"));
    assert.equal(f.proxy.panel(), undefined);
  });

  it("プロキシ：つないだとき、kisui serve が通しているワークスペースは通したまま戻り、前の Window のブラウザのタブの残りは止める", async () => {
    const { f, serve } = start({
      serves: { [LOCAL]: { ids: ["a"], focus: "a", capabilities: ["proxy"] } },
    });
    serve(LOCAL).proxy.set("ws:a", {
      port: 41000,
      recording: true,
      workspaceId: "a",
      flows: [flow(3)],
    });
    serve(LOCAL).proxy.set("browser:gone", {
      port: 41001,
      recording: true,
      flows: [],
    });
    await settle();
    assert.equal(f.proxy.proxied(), true);
    assert.deepEqual([...serve(LOCAL).proxy.keys()], ["ws:a"]);
    // パネルは閉じたまま。開くと、通し直さずに、記録が出る
    assert.equal(f.proxy.panel(), undefined);
    f.commands.runCommand({ id: "proxy.panel" });
    await settle();
    assert.ok(!serve(LOCAL).methods.includes("proxy.start"));
    assert.deepEqual(
      f.proxy.panel()?.scope.flows.map((x) => x.id),
      [3],
    );
  });

  it("プロキシ：記録を読んでいる間に届いた知らせは、答えの一覧より進んでいれば当てる", async () => {
    const { f, serve } = start({
      serves: { [LOCAL]: { ids: ["a"], focus: "a", capabilities: ["proxy"] } },
    });
    await settle();
    // 答えの一覧では「待っている」通信が、答えより先に届く知らせでは終わっている
    serve(LOCAL).proxy.set("ws:a", {
      port: 41000,
      recording: false,
      workspaceId: "a",
      flows: [flow(1, { state: "pending", status: 0 }), flow(2)],
    });
    serve(LOCAL).lateFlow = flow(1);
    f.commands.runCommand({ id: "proxy.panel" });
    await settle();
    assert.deepEqual(
      f.proxy.panel()?.scope.flows.map((x) => [x.id, x.state]),
      [
        [1, "done"],
        [2, "done"],
      ],
    );
    // 一覧より古い知らせ（答えより先に届いた「待っている」）では、戻さない
    f.commands.runCommand({ id: "proxy.stop" });
    await settle();
    serve(LOCAL).proxy.get("ws:a")!.flows = [flow(1)];
    serve(LOCAL).lateFlow = flow(1, { state: "pending", status: 0 });
    f.commands.runCommand({ id: "proxy.panel" });
    await settle();
    assert.deepEqual(
      f.proxy.panel()?.scope.flows.map((x) => [x.id, x.state]),
      [[1, "done"]],
    );
  });

  it("プロキシ：手元の kisui serve との接続が切れたら、通しているブラウザのタブをプロキシ無しに戻す", async () => {
    const { f } = start({
      serves: { [LOCAL]: { ids: ["a"], focus: "a", capabilities: ["proxy"] } },
      browser: true,
    });
    await settle();
    f.commands.runCommand({ id: "browser.new" });
    await settle();
    f.commands.runCommand({ id: "proxy.panel" });
    await settle();
    assert.ok(f.pages.shownBrowserTab()?.proxy);
    await f.sessions.disconnect(LOCAL);
    await settle();
    assert.notEqual(f.sessions.states()[LOCAL]?.kind, "connected");
    assert.equal(f.pages.shownBrowserTab()?.proxy, undefined);
    assert.equal(f.proxy.panel(), undefined);
  });
});
