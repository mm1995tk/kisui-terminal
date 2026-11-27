// 内蔵ブラウザのタブ（#202）を出す場所。グリッドの場所すべてを覆い、今のワークスペースで選んでいるタブのページを出す。
// ページそのものは、この場所に Tauri の子の webview を重ねて出す（browser.rs。外のサイトの多くは iframe に出せないため）。
// 子の webview は画面（DOM）より上に重なるので、ダイアログを出している間は隠し、ほかの重なるものは、それぞれが自分に付けた印
// （data-overlay・data-overlay-top。overlay.ts の OVERLAY_SELECTORS）のとおりに避ける。
// macOS は、浮かべるもの（Notice・リーダーの案内・メニュー・ページ内検索の欄・トースト。data-overlay）をページを縮めずに重ねる
// （画面をページより前に出し、ページはすりガラス越しに見える。操作はできない。殻の browser_layer）。
// 子の webview はタブごとに 1 つで、初めて出すときに作る。ほかのワークスペースに移る・グリッドに戻るときは隠すだけで、
// ページはそのまま残す（戻ったときに、読んでいた所から続けられる）。タブを閉じたら壊す。
import { T } from "../../../../i18n/index.ts";
import {
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  Show,
  untrack,
  type JSX,
} from "solid-js";

import type { InterceptKey } from "../../../../features/commands/commands.ts";
import { Button } from "../../../components/Button.tsx";
import { usePorts } from "../../../ports.ts";
import {
  floatsOver,
  mayFocusPage,
  OVERLAY_SELECTORS,
  pageBounds,
  placeIn,
  samePlace,
  type Bounds,
  type Placement,
} from "./overlay.ts";
import {
  isCertReason,
  reasonKey,
} from "../../../../features/browser/loadError.ts";
import { isNewTab } from "../../../../features/browser/newTab.ts";
import type { BrowserTab } from "../../../../features/browser/tabs.ts";
import "./browser.css";

/** 子の webview 1 つの様子。 */
interface View {
  state: "opening" | "open" | "failed";
  /** 作ったときの URL（開けなかったタブは、URL が変わったら作り直す） */
  url: string;
  /** 今見せている場所（殻に渡したもの）。隠していれば null */
  shown: Placement | null;
  /** 作ったときのプロキシの待ち受け口（#409。通していなければ undefined）。タブのものと違ったら、作り直す */
  proxy: number | undefined;
}

/** 殻が「まだ前の webview が残っている」と断ったときに、待って作り直す回数と間隔（プロキシを替えて作り直すとき）。 */
const REOPEN_TRIES = 20;
const REOPEN_WAIT_MS = 50;

function rectOf(el: Element): Bounds {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** 四角（rectOf で測ったもの）を、殻に渡す場所にする。四角を数えた viewport の、今の大きさを添える */
function placeOf(b: Bounds, zoom: number): Placement {
  return placeIn(b, { w: window.innerWidth, h: window.innerHeight }, zoom);
}

/** 画面（メインの webview）のどこにもキーが無いか。 */
const nothingFocused = () =>
  document.activeElement === null || document.activeElement === document.body;

/**
 * 今のワークスペースで出しているタブのページを、グリッドの場所すべてに出す（子の webview を重ねる）。
 * タブごとの子の webview を、初めて出すときに作り、出さないときは隠し、閉じたタブのものは壊す。
 */
export function BrowserArea(props: {
  /** 開いているタブ全部（無くなったタブの webview を壊すため） */
  tabs: readonly BrowserTab[];
  /** 今のワークスペースで出しているタブ。グリッドを出していれば undefined */
  shown: BrowserTab | undefined;
  /** 画面全体の大きさ（webview の zoom。CSS ピクセルを論理ピクセルにする） */
  zoom: () => number;
  /** ページにキーがあっても受けるキー（リーダーと Shortcut） */
  keys: () => InterceptKey[];
  /**
   * タブの URL（元の URL）から、ページに実際に開かせる URL を得る（リモートのマシンの localhost 系は `kisui relay` の中継の URL。#203）
   */
  resolve: (tab: BrowserTab, url: string) => Promise<string>;
  /** 読み込みが失敗したタブの「もう一度開く」（#432。開けなかった URL を開き直す。features/browser/pages.ts の navPage） */
  onRetry: (tab: string) => void;
  /** ページを開けなかった */
  onError: (title: string, error: string) => void;
  /** 今出しているタブのページにキーを向ける関数を受け取る */
  focusRef: (focus: () => void) => void;
  /** リーダーに入っているか。入っている間は、ページにキーを向けない（向けると画面がキーを失い、リーダーが閉じる。#256）。出たら向ける */
  leaderOpen: () => boolean;
  /** ページの上に重ねて出すもの（ページ内検索の欄。#205）。data-overlay を付ければ、浮かべるものとして重なる */
  children?: JSX.Element;
}): JSX.Element {
  const {
    closeTabView,
    enableOverlay,
    focusTab,
    layerTab,
    moveTab,
    openTab,
    showTabView,
    zoomTab,
  } = usePorts().browser;
  let area!: HTMLDivElement;
  const views = new Map<string, View>();
  const [hidden, setHidden] = createSignal(false);
  // 出しているタブの webview の様子（案内の文に使う）
  const [status, setStatus] = createSignal<View["state"] | undefined>();
  const refreshStatus = () => {
    const id = untrack(() => props.shown?.id);
    setStatus(id === undefined ? undefined : views.get(id)?.state);
  };
  /** 出したらキーを向けるタブ（作っている途中・隠している間に頼まれた） */
  let wantFocus: string | null = null;
  let disposed = false;

  /** ページの上に浮かべるものを、縮めずに重ねられるか（macOS。殻が答える）。分かるまでは false（縮めて避ける） */
  let native = false;
  /** 今、前に出している層（画面か、そのタブのページか）。殻に頼んでいる間・出していなければ null */
  let layer: { tab: string; front: "ui" | "page" } | null = null;
  /** 見回り（tick）が最後に見た、浮かべるものがページに重なっているか（重なっている間は、ページにキーを向けない） */
  let floatingNow = false;
  let layerBusy = false;
  /** releaseLayer のたびに増やす（頼んでいる間に放した古い答えを捨てる） */
  let layerGen = 0;

  /**
   * 今の様子で、ページを置く場所（殻に渡す形。隠すなら null）と、浮かべるものがページに重なっているか。
   * 重ねられる OS では、浮かべるものでページを縮めない（重なっているかだけ返す）。
   */
  function bounds(): { b: Placement | null; floating: boolean } {
    const floats = [...document.querySelectorAll(OVERLAY_SELECTORS.float)].map(
      rectOf,
    );
    const modal = document.querySelector("dialog[open]") !== null;
    const areaRect = rectOf(area);
    const bar = document.querySelector(OVERLAY_SELECTORS.top);
    const barRect = bar ? rectOf(bar) : null;
    const top = barRect ? barRect.y + barRect.h - areaRect.y : 0;
    const b = pageBounds(areaRect, native ? [] : floats, modal, top);
    return {
      b: b && placeOf(b, props.zoom()),
      floating: native && b !== null && floatsOver(areaRect, floats),
    };
  }

  /** 画面を前に出している間だけ、ページの場所を透かして、すりガラスの色をかぶせる（browser.css） */
  function setFrost(on: boolean) {
    const root = document.documentElement;
    if (on) root.dataset.pageOverlay = "";
    else delete root.dataset.pageOverlay;
  }

  /**
   * 前に出す層を、floating に合わせる。殻の切り替えが済んでから、見た目（透かし）を替える
   * （先に替えると、切り替わるまでの間、ページの場所が空いて見える）。
   */
  function setLayer(id: string, floating: boolean) {
    const front = floating ? "ui" : "page";
    if (!native || layerBusy || (layer?.tab === id && layer.front === front))
      return;
    layerBusy = true;
    const gen = layerGen;
    layerTab(id, floating)
      .then(() => {
        if (gen !== layerGen) return;
        layer = { tab: id, front };
        setFrost(floating);
        // 画面を前に出した（キーも画面に向いた）あと、ページを前に戻すとき、画面のどこにもキーが無ければ、ページに戻す
        if (!floating && wantFocus === null && nothingFocused()) wantFocus = id;
      })
      .catch(() => {})
      .finally(() => (layerBusy = false));
  }

  /** ページを出さない間（グリッド・新しいタブのページ・隠している間）は、透かしをやめる。次に出すとき、層を決め直す */
  function releaseLayer() {
    if (!native) return;
    layer = null;
    floatingNow = false;
    layerGen++;
    setFrost(false);
  }

  function hide(id: string, v: View) {
    if (v.state !== "open" || v.shown === null) return;
    v.shown = null;
    void showTabView(id, false).catch(() => {});
  }

  function focusNow(id: string) {
    // 画面の中でキーを持っていた所（隠れたターミナルなど）から外す。外さないと、ページから戻ったキーがそこへ行く
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
    void focusTab(id).catch(() => {});
  }

  async function create(tab: BrowserTab, b: Placement | null, reopen = false) {
    const proxy = tab.proxy?.port;
    const v: View = { state: "opening", url: tab.url, shown: null, proxy };
    views.set(tab.id, v);
    refreshStatus();
    // 隠すときも、いったん場所の四角で作る（次の見回りで隠す）
    const at = b ?? placeOf(rectOf(area), props.zoom());
    try {
      const url = await props.resolve(tab, tab.url);
      if (disposed || views.get(tab.id) !== v) return;
      for (let tries = 1; ; tries++) {
        try {
          await openTab(tab.id, url, props.keys(), !!tab.incognito, at, proxy);
          break;
        } catch (e) {
          // 作り直すとき、殻が前の webview を壊し終えるまで少しかかる。その間は「もう開いている」と断られるので、待って試し直す
          if (!reopen || tries >= REOPEN_TRIES) throw e;
          await new Promise((r) => setTimeout(r, REOPEN_WAIT_MS));
          if (disposed || views.get(tab.id) !== v) return;
        }
      }
    } catch (e) {
      if (views.get(tab.id) !== v) return;
      v.state = "failed";
      refreshStatus();
      props.onError(
        T("err.page.open"),
        e instanceof Error ? e.message : String(e),
      );
      return;
    }
    if (disposed || views.get(tab.id) !== v) {
      void closeTabView(tab.id).catch(() => {});
      return;
    }
    v.state = "open";
    // 作り直した webview は前に来る。層を決め直させる
    layer = null;
    v.shown = at;
    // 覚えていた表示の大きさ（#205）。作っている間に変えたものも、ここで当てる
    const zoom = untrack(() => props.tabs.find((t) => t.id === tab.id)?.zoom);
    if (zoom !== undefined && zoom !== 1)
      void zoomTab(tab.id, zoom).catch(() => {});
    // 作っている間に出すタブが替わった（t j で先へ進んだ・グリッドに戻った）なら、隠す。
    // 子の webview は見える状態で作られ、見回り（tick）は今出しているタブしか見ないので、ここで隠さないとグリッドを覆ったまま残る
    if (untrack(() => props.shown?.id) !== tab.id) hide(tab.id, v);
    refreshStatus();
    // 作っている間に、タブのプロキシ（#409）が替わった（通すのをやめた・kisui serve が止まった）。下の作り直しの
    // createEffect は、作っている途中のタブを飛ばすので、ここで作り直す
    const now = untrack(() => props.tabs.find((t) => t.id === tab.id));
    if (now && now.proxy?.port !== proxy) void recreate(now, v.shown);
  }

  /**
   * タブのプロキシ（#409）が替わった（通し始めた・やめた）。webview を壊して、新しいプロキシで作り直す（ページを読み直す）。
   * プロキシは webview を作るときにしか決められない。
   */
  async function recreate(tab: BrowserTab, b: Placement | null) {
    // 壊している間、見回り（tick）が触らないよう、先に「開いている途中」にする（create が自分の View に置き換える）
    const closing: View = {
      state: "opening",
      url: tab.url,
      shown: null,
      proxy: tab.proxy?.port,
    };
    views.set(tab.id, closing);
    refreshStatus();
    await closeTabView(tab.id).catch(() => {});
    if (disposed || views.get(tab.id) !== closing) return;
    await create(tab, b, true);
  }

  // 閉じたタブの webview を壊す。殻がもう作ってあるタブ（ページが開いた新しい Window。#204）は、作らずにそのまま使う
  // （殻は隠して渡すので、出すタブなら見回り（tick）が置いて見せる）
  createEffect(() => {
    for (const t of props.tabs)
      if (t.made && !views.has(t.id))
        views.set(t.id, {
          state: "open",
          url: t.url,
          shown: null,
          proxy: t.proxy?.port,
        });
    refreshStatus();
    const alive = new Set(props.tabs.map((t) => t.id));
    for (const [id, v] of [...views]) {
      if (alive.has(id)) continue;
      views.delete(id);
      if (v.state === "open") void closeTabView(id).catch(() => {});
      if (wantFocus === id) wantFocus = null;
    }
  });

  // タブのプロキシ（#409）が替わった（通し始めた・やめた・kisui serve が止まった）ら、すぐに作り直す（ページを読み直す）。
  // 出していないタブも作り直す（作ったあと隠す）。見回り（tick）に任せると、作り直すのは今出しているタブだけで、しかも
  // Window が隠れている間は WebView が requestAnimationFrame を止めて、見回りが動かない
  createEffect(() => {
    for (const t of props.tabs) {
      const v = views.get(t.id);
      if (v?.state !== "open" || v.proxy === t.proxy?.port) continue;
      untrack(() => {
        const shown = props.shown?.id === t.id;
        if (shown) releaseLayer();
        void recreate(t, shown ? bounds().b : null);
      });
    }
  });

  // 出すタブが替わったら、前のタブは隠す
  createEffect((prev: string | undefined) => {
    const id = props.shown?.id;
    if (prev !== undefined && prev !== id) {
      const v = views.get(prev);
      if (v) hide(prev, v);
      if (wantFocus === prev) wantFocus = null;
    }
    refreshStatus();
    return id;
  }, undefined);

  props.focusRef(() => {
    const id = untrack(() => props.shown?.id);
    if (!id) return;
    const v = views.get(id);
    if (
      v?.state === "open" &&
      v.shown !== null &&
      mayFocusPage(floatingNow, untrack(props.leaderOpen))
    ) {
      wantFocus = null;
      focusNow(id);
    } else wantFocus = id; // 重ねている間とリーダーの間は、重なりが消える・リーダーを出るのを待ち、見回りが向けられるようになってから向ける
  });

  // 位置が変わるのは、大きさの変化のほかに、サイドバーの幅の変更・Notice の出し入れなどもある。
  // 出している間は毎フレーム見て、変わったときだけ殻に送る。Window の形だけが変わったとき（測った場所は同じ）は、
  // 殻（macOS）が自分でページを追従させるので、送り直さない（#442。src-tauri/src/browser_frame.rs）
  onMount(() => {
    let raf = 0;
    // 浮かべるものを縮めずに重ねられるか。答えが来るまで、また重ねられない OS では、これまでどおり縮めて避ける
    void enableOverlay()
      .then((ok) => (native = ok && !disposed))
      .catch(() => {});
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const tab = props.shown;
      if (!tab) {
        releaseLayer();
        return;
      }
      // 新しいタブのページ（URL が空。#238）は、画面（NewTabPage）が描く。webview は、何かを開いて URL が決まってから作る
      if (isNewTab(tab)) {
        releaseLayer();
        setHidden(false);
        return;
      }
      const { b, floating } = bounds();
      floatingNow = floating;
      setHidden(b === null);
      const v = views.get(tab.id);
      // 開けなかったタブは、URL を書き換えたら（URL バー）・プロキシを替えたら、作り直す
      if (
        !v ||
        (v.state === "failed" &&
          (v.url !== tab.url || v.proxy !== tab.proxy?.port))
      ) {
        void create(tab, b);
        return;
      }
      if (v.state !== "open") return;
      // 読み込みが、ページが出る前に失敗したタブ（#432）は、ページを隠して、失敗の表示（下）を見せる。前のページが残って見えない
      if (tab.loadError) {
        releaseLayer();
        hide(tab.id, v);
        return;
      }
      if (b === null) {
        releaseLayer();
        hide(tab.id, v);
        return;
      }
      const wasHidden = v.shown === null;
      if (!samePlace(v.shown, b)) {
        void moveTab(tab.id, b).catch(() => {});
        v.shown = b;
      }
      if (wasHidden) {
        void showTabView(tab.id, true).catch(() => {});
        // ダイアログを閉じたあと、画面のどこにもキーが無ければ、ページに戻す
        if (wantFocus === null && nothingFocused()) wantFocus = tab.id;
      }
      setLayer(tab.id, floating);
      if (wantFocus === tab.id && mayFocusPage(floating, props.leaderOpen())) {
        wantFocus = null;
        focusNow(tab.id);
      }
    };
    raf = requestAnimationFrame(tick);
    onCleanup(() => {
      disposed = true;
      native = false;
      setFrost(false);
      cancelAnimationFrame(raf);
      for (const [id, v] of views)
        if (v.state === "open") void closeTabView(id).catch(() => {});
      views.clear();
    });
  });

  return (
    <div class="browser-area" ref={area} hidden={!props.shown}>
      <Show when={props.shown}>
        {(t) => (
          <Show
            when={t().loadError}
            fallback={
              <p class="browser-note" role="status">
                {status() === "opening"
                  ? T("browser.opening", { url: t().url })
                  : status() === "failed"
                    ? T("browser.failed", { url: t().url })
                    : hidden()
                      ? T("browser.hidden")
                      : ""}
              </p>
            }
          >
            {(e) => (
              // 読み込みが、ページが出る前に失敗した（#432）。ページ（子の webview）は隠してあり、開こうとした URL と理由を出す。
              // 文字は、そのまま文字として出す（URL・OS の説明に、ページが選んだ文字が入ることがあるため）
              <div class="browser-load-error" role="alert">
                <h2>{T("browser.loadFailed.title")}</h2>
                <p class="browser-load-error-url">{e().url}</p>
                <p>{T(reasonKey(e().reason))}</p>
                <Show when={isCertReason(e().reason)}>
                  <p class="browser-note">{T("browser.loadFailed.certNote")}</p>
                </Show>
                <Show when={e().detail}>
                  <p class="browser-note">{e().detail}</p>
                </Show>
                <Button variant="primary" onClick={() => props.onRetry(t().id)}>
                  {T("browser.loadFailed.retry")}
                </Button>
              </div>
            )}
          </Show>
        )}
      </Show>
      {props.children}
    </div>
  );
}
