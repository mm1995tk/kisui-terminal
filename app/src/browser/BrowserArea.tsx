// 内蔵ブラウザのタブ（#202）を出す場所。グリッドの場所すべてを覆い、今のワークスペースで選んでいるタブのページを出す。
// ページそのものは、この場所に Tauri の子の webview を重ねて出す（browser.rs。外のサイトの多くは iframe に出せないため）。
// 子の webview は画面（DOM）より上に重なるので、ダイアログを出している間は隠し、お知らせ・リーダーの案内などが重なるときは
// ページの下の端を上げる（overlay.ts）。
// 子の webview はタブごとに 1 つで、初めて出すときに作る。ほかのワークスペースに移る・グリッドに戻るときは隠すだけで、
// ページはそのまま残す（戻ったときに、読んでいた所から続けられる）。タブを閉じたら壊す。
import { T } from "../i18n/index.ts";
import {
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  Show,
  untrack,
  type JSX,
} from "solid-js";

import type { InterceptKey } from "../commands.ts";
import {
  closeTabView,
  focusTab,
  moveTab,
  openTab,
  showTabView,
  zoomTab,
} from "./browserOs.ts";
import { pageBounds, sameBounds, toLogical, type Bounds } from "./overlay.ts";
import type { BrowserTab } from "./tabs.ts";
import "./browser.css";

/** 上に出ていて、ページが避けるもの（右下のお知らせ・リーダーの案内とキャラクター・右クリックのメニュー・data-overlay を付けたページ内検索の欄とトースト） */
const OVERLAY_SELECTOR =
  ".card-notices > *, [data-overlay], .machine-menu, [role='menu']";

/** 子の webview 1 つの様子。 */
interface View {
  state: "opening" | "open" | "failed";
  /** 作ったときの URL（開けなかったタブは、URL が変わったら作り直す） */
  url: string;
  /** 今見せている四角（論理ピクセル）。隠していれば null */
  shown: Bounds | null;
}

function rectOf(el: Element): Bounds {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
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
  /** ページにキーがあっても受けるキー（リーダーと近道） */
  keys: () => InterceptKey[];
  /**
   * タブの URL（元の URL）から、ページに実際に開かせる URL を得る（リモートのマシンの localhost 系は `kisui relay` の中継の URL。#203）
   */
  resolve: (tab: BrowserTab, url: string) => Promise<string>;
  /** ページを開けなかった */
  onError: (title: string, error: string) => void;
  /** 今出しているタブのページにキーを向ける関数を受け取る */
  focusRef: (focus: () => void) => void;
  /** ページの上に重ねて出すもの（ページ内検索の欄。#205）。data-overlay を付ければ、ページはその上まで縮む */
  children?: JSX.Element;
}): JSX.Element {
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

  /** 今の様子で、ページを置く四角（論理ピクセル）。隠すなら null。 */
  function bounds(): Bounds | null {
    const overlays = [...document.querySelectorAll(OVERLAY_SELECTOR)].map(
      rectOf,
    );
    const modal = document.querySelector("dialog[open]") !== null;
    const b = pageBounds(rectOf(area), overlays, modal);
    return b && toLogical(b, props.zoom());
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

  async function create(tab: BrowserTab, b: Bounds | null) {
    const v: View = { state: "opening", url: tab.url, shown: null };
    views.set(tab.id, v);
    refreshStatus();
    // 隠すときも、いったん場所の四角で作る（次の見回りで隠す）
    const at = b ?? toLogical(rectOf(area), props.zoom());
    try {
      const url = await props.resolve(tab, tab.url);
      if (disposed || views.get(tab.id) !== v) return;
      await openTab(tab.id, url, props.keys(), !!tab.incognito, at);
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
    v.shown = at;
    // 覚えていた表示の大きさ（#205）。作っている間に変えたものも、ここで当てる
    const zoom = untrack(() => props.tabs.find((t) => t.id === tab.id)?.zoom);
    if (zoom !== undefined && zoom !== 1)
      void zoomTab(tab.id, zoom).catch(() => {});
    // 作っている間に出すタブが替わった（o j で先へ進んだ・グリッドに戻った）なら、隠す。
    // 子の webview は見える状態で作られ、見回り（tick）は今出しているタブしか見ないので、ここで隠さないとグリッドを覆ったまま残る
    if (untrack(() => props.shown?.id) !== tab.id) hide(tab.id, v);
    refreshStatus();
  }

  // 閉じたタブの webview を壊す。殻がもう作ってあるタブ（ページが開いた新しい窓。#204）は、作らずにそのまま使う
  // （殻は隠して渡すので、出すタブなら見回り（tick）が置いて見せる）
  createEffect(() => {
    for (const t of props.tabs)
      if (t.made && !views.has(t.id))
        views.set(t.id, { state: "open", url: t.url, shown: null });
    refreshStatus();
    const alive = new Set(props.tabs.map((t) => t.id));
    for (const [id, v] of [...views]) {
      if (alive.has(id)) continue;
      views.delete(id);
      if (v.state === "open") void closeTabView(id).catch(() => {});
      if (wantFocus === id) wantFocus = null;
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
    if (v?.state === "open" && v.shown !== null) {
      wantFocus = null;
      focusNow(id);
    } else wantFocus = id;
  });

  // 位置が変わるのは、大きさの変化のほかに、サイドバーの幅の変更・お知らせの出し入れなどもある。
  // 出している間は毎フレーム見て、変わったときだけ殻に送る
  onMount(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const tab = props.shown;
      if (!tab) return;
      const b = bounds();
      setHidden(b === null);
      const v = views.get(tab.id);
      // 開けなかったタブは、URL を書き換えたら（o u）作り直す
      if (!v || (v.state === "failed" && v.url !== tab.url)) {
        void create(tab, b);
        return;
      }
      if (v.state !== "open") return;
      if (b === null) {
        hide(tab.id, v);
        return;
      }
      const wasHidden = v.shown === null;
      if (!sameBounds(v.shown, b)) {
        void moveTab(tab.id, b).catch(() => {});
        v.shown = b;
      }
      if (wasHidden) {
        void showTabView(tab.id, true).catch(() => {});
        // ダイアログを閉じたあと、画面のどこにもキーが無ければ、ページに戻す
        if (wantFocus === null && nothingFocused()) wantFocus = tab.id;
      }
      if (wantFocus === tab.id) {
        wantFocus = null;
        focusNow(tab.id);
      }
    };
    raf = requestAnimationFrame(tick);
    onCleanup(() => {
      disposed = true;
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
          <p class="browser-note" role="status">
            {status() === "opening"
              ? T("browser.opening", { url: t().url })
              : status() === "failed"
                ? T("browser.failed", { url: t().url })
                : hidden()
                  ? T("browser.hidden")
                  : ""}
          </p>
        )}
      </Show>
      {props.children}
    </div>
  );
}
