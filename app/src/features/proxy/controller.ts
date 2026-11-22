// プロキシのパネル（#409）の持ち物。今出しているタブ（ターミナルのタブか、内蔵ブラウザのタブ）の HTTP・HTTPS の通信を、
// kisui serve のプロキシ（proxy.*）に通し、一覧と、選んだ通信の中身を持つ。
// - パネルを開くと、そのタブを通し始める。ターミナルのタブは、そのマシンの kisui serve が、そのあとに開いたペインに
//   プロキシと認証局の環境変数を渡す。ブラウザのタブは、手元のマシンの kisui serve のプロキシに通す：タブに待ち受け口
//   （BrowserTab.proxy）を書くと、画面（BrowserArea）がその webview をプロキシ付きで作り直す（ページを読み直す）。
// - パネルを閉じても、通したまま記録を続ける。通すのをやめるのは別の操作（stopCurrent）。
// - 通しているかは kisui serve が持つ。つなぎ直したら一覧（proxy.list）で合わせる（ターミナルのタブは通したまま戻る。
//   kisui serve が作り直されていたら、ブラウザのタブはプロキシ無しで作り直す）。
// 画面にも Tauri にも触らない。キーを向けるのは、画面の側に頼む（focusPanel）。
import { T } from "../../i18n/index.ts";
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
} from "solid-js";

import {
  hasCapability,
  type ProxyFlow,
  type ProxyFlowDetail,
  type WorkspaceId,
} from "../../infrastructure/rpc/protocol.ts";
import type { Pages } from "../browser/pages.ts";
import { updateTab } from "../browser/tabs.ts";
import type { BrowserTabs } from "../browser/tabsStore.ts";
import type { DbTabs } from "../db/controller.ts";
import type { ReportProblem } from "../problem.ts";
import type { Sessions } from "../sessions/controller.ts";
import { LOCAL } from "../sessions/shell.ts";
import type { Workspaces } from "../workspaces/controller.ts";
import { browserKey, termKey } from "../workspaces/model.ts";
import {
  applyFlow,
  browserScope,
  scopeKey,
  stepSelection,
  wsScope,
} from "./model.ts";

/** 通す相手のタブ。 */
export interface ProxySubject {
  kind: "term" | "browser";
  /** プロキシを動かすマシン（ターミナルのタブはそのマシン、ブラウザのタブは手元のマシン） */
  target: string;
  scope: string;
  /** タブを指すキー（features/workspaces/model.ts の termKey・browserKey）。パネルを開いているかは、タブごとに覚える */
  tab: string;
  /** ターミナルのタブの、マシンのワークスペース */
  ws?: WorkspaceId;
  /** ブラウザのタブの id */
  browserTab?: string;
}

/** 通している単位 1 つの、画面が持つ分。 */
export interface ProxyScopeState {
  target: string;
  scope: string;
  /** 待ち受け口（そのマシンの 127.0.0.1 のポート） */
  port: number;
  /** 記録した通信（id の順） */
  flows: readonly ProxyFlow[];
}

/** 選んだ通信の中身。読んでいる間は detail も error も無い（前に読んだものがあれば、それを出したまま読み直す）。 */
export interface ProxyDetailState {
  id: number;
  detail?: ProxyFlowDetail;
  error?: string;
}

/** 中身の、出している側。 */
export type ProxySide = "request" | "response";

/** パネルに出すもの。 */
export interface ProxyPanelState {
  subject: ProxySubject;
  scope: ProxyScopeState;
  /** 選んでいる通信の id */
  selected: number | undefined;
  detail: ProxyDetailState | undefined;
  side: ProxySide;
}

/** createProxy が返す持ち物。 */
export type Proxy = ReturnType<typeof createProxy>;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** プロキシのパネルの持ち物を作る。 */
export function createProxy(deps: {
  sessions: Pick<Sessions, "sessions" | "states" | "workspaces" | "labelOf">;
  workspaces: Pick<Workspaces, "focus" | "currentEmpty" | "cannot">;
  pages: Pick<Pages, "shownBrowserTab">;
  db: Pick<DbTabs, "shownDbTab">;
  browserTabs: Pick<BrowserTabs, "tabs" | "setTabs">;
  setFocusError: ReportProblem;
  /** 今使っているペイン（ブラウザのタブを出していればそのページ）にキーを向ける */
  focusTerminal: () => void;
  /** ページから押したときに覚えた「キーを戻す先」を捨てる */
  forgetPageReturn: () => void;
  /** パネルにキーを向ける（描かれたあとで） */
  focusPanel: () => void;
}) {
  const { cannot } = deps.workspaces;
  const { tabs, setTabs } = deps.browserTabs;
  // 通している単位（scopeKey → 画面が持つ分）
  const [scopes, setScopes] = createSignal<Record<string, ProxyScopeState>>({});
  // パネルを開いているタブ（タブのキー → true）
  const [open, setOpen] = createSignal<Record<string, true>>({});
  // 単位ごとの、選んでいる通信と、その中身
  const [selected, setSelected] = createSignal<Record<string, number>>({});
  const [details, setDetails] = createSignal<Record<string, ProxyDetailState>>(
    {},
  );
  const [side, setSide] = createSignal<ProxySide>("request");
  /** 通し始めている途中の単位（2 回始めない・途中の単位を「使っていない」と見て止めない） */
  const starting = new Set<string>();

  /** 今出しているタブ。通せるタブ（ターミナルのタブ・ブラウザのタブ）を出していなければ undefined。 */
  const subject = createMemo<ProxySubject | undefined>(() => {
    const b = deps.pages.shownBrowserTab();
    if (b)
      return {
        kind: "browser",
        target: LOCAL,
        // ページが開いた新しい窓のタブは、開いた元のタブと同じ単位
        scope: b.proxy?.scope ?? browserScope(b.id),
        tab: browserKey(b.id),
        browserTab: b.id,
      };
    if (deps.db.shownDbTab() || deps.workspaces.currentEmpty())
      return undefined;
    const f = deps.workspaces.focus();
    if (!f) return undefined;
    return {
      kind: "term",
      target: f.target,
      scope: wsScope(f.id),
      tab: termKey(f.target, f.id),
      ws: f.id,
    };
  });

  /** 今出しているタブのパネル。開いていなければ undefined。 */
  const panel = createMemo<ProxyPanelState | undefined>(() => {
    const s = subject();
    if (!s || !open()[s.tab]) return undefined;
    const key = scopeKey(s.target, s.scope);
    const scope = scopes()[key];
    if (!scope) return undefined;
    return {
      subject: s,
      scope,
      selected: selected()[key],
      detail: details()[key],
      side: side(),
    };
  });

  /** 今出しているタブを通しているか。 */
  const proxied = createMemo(() => {
    const s = subject();
    return !!s && !!scopes()[scopeKey(s.target, s.scope)];
  });

  function without<V>(r: Record<string, V>, key: string): Record<string, V> {
    if (!(key in r)) return r;
    const next = { ...r };
    delete next[key];
    return next;
  }

  /** 単位を、画面の持ち物から外す。その単位に通していたブラウザのタブは、プロキシ無しに戻す（webview を作り直す）。 */
  function dropScope(target: string, scope: string) {
    const key = scopeKey(target, scope);
    batch(() => {
      setScopes((s) => without(s, key));
      setSelected((s) => without(s, key));
      setDetails((s) => without(s, key));
      if (target === LOCAL)
        for (const t of untrack(tabs).tabs)
          if (t.proxy?.scope === scope)
            setTabs((s) => updateTab(s, t.id, { proxy: undefined }));
    });
  }

  /** マシン target につながっていて、kisui serve がプロキシを持つなら、その接続。無ければ理由を知らせて undefined。 */
  function sessionFor(target: string, quiet = false) {
    const session = untrack(deps.sessions.sessions)[target];
    const st = untrack(deps.sessions.states)[target];
    const machine = deps.sessions.labelOf(target);
    if (!session || st?.kind !== "connected") {
      if (!quiet)
        cannot(
          T("cannot.proxy.title"),
          T("cannot.proxy.disconnected", { machine }),
        );
      return undefined;
    }
    if (!hasCapability(st.hello, "proxy")) {
      if (!quiet)
        cannot(T("cannot.proxy.title"), T("cannot.proxy.old", { machine }));
      return undefined;
    }
    return session;
  }

  /** タブ s を通し始める。始められたら true。 */
  async function start(s: ProxySubject): Promise<boolean> {
    const key = scopeKey(s.target, s.scope);
    if (starting.has(key)) return false;
    const session = sessionFor(s.target);
    if (!session) return false;
    starting.add(key);
    try {
      const r = await session.request(
        "proxy.start",
        s.kind === "term" ? { workspaceId: s.ws } : { scope: s.scope },
      );
      batch(() => {
        setScopes((all) => ({
          ...all,
          [key]: {
            target: s.target,
            scope: r.scope,
            port: r.port,
            flows: r.flows,
          },
        }));
        if (s.browserTab !== undefined)
          setTabs((t) =>
            updateTab(t, s.browserTab!, {
              proxy: { scope: r.scope, port: r.port },
            }),
          );
      });
      return true;
    } catch (e) {
      deps.setFocusError({ title: T("err.proxy.start"), error: message(e) });
      return false;
    } finally {
      starting.delete(key);
    }
  }

  /**
   * 今出しているタブのパネルを開く（リーダーの `x p`）。まだ通していなければ、通し始める。もう開いていれば、キーを向けるだけ。
   */
  async function openPanel() {
    const s = untrack(subject);
    if (!s) {
      cannot(T("cannot.proxy.title"), T("cannot.proxy.noTab"));
      return;
    }
    if (!untrack(scopes)[scopeKey(s.target, s.scope)] && !(await start(s)))
      return;
    setOpen((o) => ({ ...o, [s.tab]: true }));
    // 始めている間にほかのタブへ移っていたら、キーは動かさない（戻ったときにパネルは出ている）
    if (untrack(subject)?.tab !== s.tab) return;
    deps.forgetPageReturn();
    deps.focusPanel();
  }

  /** 今出しているタブのパネルを閉じる（リーダーの `x c`・パネルの `q`）。通したまま、記録は続ける。 */
  function closePanel() {
    const s = untrack(subject);
    if (!s || !untrack(open)[s.tab]) return;
    setOpen((o) => without(o, s.tab));
    deps.focusTerminal();
  }

  /** 今出しているタブを通すのをやめる（リーダーの `x s`）。パネルも閉じる。 */
  async function stopCurrent() {
    const s = untrack(subject);
    if (!s || !untrack(scopes)[scopeKey(s.target, s.scope)]) {
      cannot(T("cannot.proxy.title"), T("cannot.proxy.notOn"));
      return;
    }
    const session = sessionFor(s.target);
    if (!session) return;
    try {
      await session.request("proxy.stop", { scope: s.scope });
    } catch (e) {
      deps.setFocusError({ title: T("err.proxy.stop"), error: message(e) });
      return;
    }
    batch(() => {
      dropScope(s.target, s.scope);
      setOpen((o) => without(o, s.tab));
    });
    deps.focusTerminal();
  }

  /** 単位 key で選んでいる通信の中身を読む（読み直す）。 */
  async function loadDetail(key: string, id: number) {
    const st = untrack(scopes)[key];
    const session = st && sessionFor(st.target, true);
    if (!st || !session) return;
    // 同じ通信を読み直す間は、前に読んだ中身を出したままにする
    setDetails((d) => (d[key]?.id === id ? d : { ...d, [key]: { id } }));
    let next: ProxyDetailState;
    try {
      next = {
        id,
        detail: await session.request("proxy.detail", { scope: st.scope, id }),
      };
    } catch (e) {
      next = { id, error: message(e) };
    }
    // 読んでいる間に、ほかの通信を選んだ・単位が無くなった
    if (untrack(selected)[key] !== id || !untrack(scopes)[key]) return;
    setDetails((d) => ({ ...d, [key]: next }));
  }

  /** パネルで通信 id を選ぶ（中身を読む）。 */
  function select(id: number) {
    const p = untrack(panel);
    if (!p) return;
    const key = scopeKey(p.scope.target, p.scope.scope);
    if (untrack(selected)[key] === id) return;
    setSelected((s) => ({ ...s, [key]: id }));
    void loadDetail(key, id);
  }

  /** パネルで選ぶ通信を動かす（`j` `k` `g` `G`）。 */
  function step(to: "next" | "prev" | "first" | "last") {
    const p = untrack(panel);
    if (!p) return;
    const id = stepSelection(p.scope.flows, p.selected, to);
    if (id !== undefined) select(id);
  }

  // 接続ごとに、通信の知らせ（proxy.flow）を受ける
  const offs = new Map<string, () => void>();
  createEffect(() => {
    const all = deps.sessions.sessions();
    for (const [target, off] of [...offs])
      if (!all[target]) {
        off();
        offs.delete(target);
      }
    for (const [target, session] of Object.entries(all)) {
      if (offs.has(target)) continue;
      offs.set(
        target,
        session.onProxyFlow((n) => {
          const key = scopeKey(target, n.scope);
          if (!untrack(scopes)[key]) return;
          setScopes((s) => {
            const st = s[key];
            return st
              ? { ...s, [key]: { ...st, flows: applyFlow(st.flows, n.flow) } }
              : s;
          });
          // 選んでいる通信が進んだら（応答が来た・終わった）、中身を読み直す
          if (untrack(selected)[key] === n.flow.id)
            void loadDetail(key, n.flow.id);
        }),
      );
    }
  });
  onCleanup(() => {
    for (const off of offs.values()) off();
    offs.clear();
  });

  /**
   * マシン target の kisui serve が通している単位に、画面の持ち物を合わせる（つないだ・つなぎ直したとき）。
   * - 通しているワークスペース：画面が知らなければ、記録を読んで持つ（窓を開き直しても、通したまま戻る）
   * - 画面が持つのに kisui serve に無い単位（kisui serve が作り直された）：外す
   * - どのタブも使っていないブラウザのタブの単位（前の窓の残り）：止める
   */
  async function sync(target: string) {
    const session = sessionFor(target, true);
    if (!session) return;
    let list;
    try {
      list = (await session.request("proxy.list", {})).scopes;
    } catch {
      return;
    }
    const live = new Set(
      list.filter((sc) => sc.recording).map((sc) => sc.scope),
    );
    for (const st of Object.values(untrack(scopes)))
      if (
        st.target === target &&
        !live.has(st.scope) &&
        !starting.has(scopeKey(target, st.scope))
      )
        dropScope(target, st.scope);
    for (const sc of list) {
      const key = scopeKey(target, sc.scope);
      if (!sc.recording || starting.has(key)) continue;
      const used =
        sc.workspaceId !== undefined ||
        (target === LOCAL &&
          untrack(tabs).tabs.some((t) => t.proxy?.scope === sc.scope));
      if (!used) {
        void session.request("proxy.stop", { scope: sc.scope }).catch(() => {});
        continue;
      }
      try {
        const { flows } = await session.request("proxy.flows", {
          scope: sc.scope,
        });
        setScopes((s) => ({
          ...s,
          [key]: { target, scope: sc.scope, port: sc.port, flows },
        }));
      } catch {
        // 読めなければ、次につないだときに合わせる
      }
    }
  }
  const connected = new Set<string>();
  createEffect(() => {
    const states = deps.sessions.states();
    for (const [target, st] of Object.entries(states)) {
      const up = st.kind === "connected";
      if (up && !connected.has(target)) {
        connected.add(target);
        void untrack(() => sync(target));
      } else if (!up) connected.delete(target);
    }
  });

  // 閉じたブラウザのタブの単位を止める（どのタブも使わなくなったら）
  createEffect(() => {
    const used = new Set(
      tabs()
        .tabs.map((t) => t.proxy?.scope)
        .filter((s) => s !== undefined),
    );
    for (const st of Object.values(untrack(scopes))) {
      if (st.target !== LOCAL || st.scope.startsWith("ws:")) continue;
      if (used.has(st.scope) || starting.has(scopeKey(LOCAL, st.scope)))
        continue;
      dropScope(LOCAL, st.scope);
      void sessionFor(LOCAL, true)
        ?.request("proxy.stop", { scope: st.scope })
        .catch(() => {});
    }
  });

  // 閉じたターミナルのタブ（マシンのワークスペース）の単位を外す（待ち受け口は kisui serve が閉じる）
  createEffect(() => {
    const lists = deps.sessions.workspaces();
    for (const st of Object.values(untrack(scopes))) {
      if (!st.scope.startsWith("ws:")) continue;
      const list = lists[st.target];
      // 一覧が分からない間（つながっていない）は、そのままにする
      if (
        !list ||
        untrack(deps.sessions.states)[st.target]?.kind !== "connected"
      )
        continue;
      if (!list.some((w) => wsScope(w.id) === st.scope))
        dropScope(st.target, st.scope);
    }
  });

  return {
    /** 今出しているタブのパネル（開いていなければ undefined） */
    panel,
    /** 今出しているタブを通しているか */
    proxied,
    /** ターミナルのタブ（マシン target のワークスペース ws）を通しているか（サイドバーのタブの行の札） */
    isProxiedTerm: (target: string, ws: WorkspaceId) =>
      !!scopes()[scopeKey(target, wsScope(ws))],
    openPanel,
    closePanel,
    stopCurrent,
    select,
    step,
    /** 中身の「要求」と「応答」を切り替える（side を渡せばその側に） */
    toggleSide(to?: ProxySide) {
      setSide((s) => to ?? (s === "request" ? "response" : "request"));
    },
  };
}
