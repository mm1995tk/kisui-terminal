import {
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";

import type { ExtraPane } from "../rpc/protocol.ts";
import { boundsOf, normalizeUrl, sameBounds, type Bounds } from "./browser.ts";
import {
  closeBrowser,
  goBrowser,
  moveBrowser,
  navBrowser,
  onBrowserUrl,
  openBrowser,
  openExternally,
  showBrowser,
} from "./browserOs.ts";

let seq = 0;

/** 窓のカード（ModalCard。ssh の質問など）が出ているか。子の webview は HTML の上に出るので、出ている間は隠す。 */
function createModalOpen(): () => boolean {
  const [open, setOpen] = createSignal(false);
  const check = () => setOpen(document.querySelector("dialog[open]") !== null);
  check();
  const mo = new MutationObserver(check);
  mo.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["open"],
  });
  onCleanup(() => mo.disconnect());
  return open;
}

/**
 * ブラウザの欄（#556）。ターミナルの欄と同じ升目に並ぶ（TerminalGrid）。見出しに戻る・進む・再読み込み・URL・閉じる、
 * 残りの本文は空の箱で、ページ自体はその位置に Tauri の別の webview を重ねて出す（browser.rs。外のサイトの多くは
 * iframe に出せないため）。重ねた webview は HTML より上に出るので、欄を隠すとき・窓のカードが出ているときは隠す。
 * リモートのマシンでは、localhost などを ssh のポート転送越しに開く（URL 欄には打った形のまま出る）。
 * 欄を選ぶとキーはこの欄の枠に向き、GUI のショートカットが効く。ページを操作するには、ページを押す。
 */
export function BrowserView(props: {
  pane: ExtraPane;
  /** この欄を開いたマシン（ssh のホスト名か @local）。localhost のページをどこのものとして開くかを決める */
  target: string;
  active?: boolean;
  /** 隠すか（ほかの欄を隠しているとき） */
  hidden?: boolean;
  /** 欄の位置（CSS grid の grid-area） */
  area?: string;
  /** 欄がフォーカスを受けた */
  onFocus?: () => void;
  onClose: () => void;
  /** この欄にキーを向ける関数を受け取る（欄が無くなるとき undefined で呼ぶ） */
  focusRef?: (focus: (() => void) | undefined) => void;
}): JSX.Element {
  const key = `bv${++seq}`;
  let cell!: HTMLDivElement;
  let body!: HTMLDivElement;
  const [url, setUrl] = createSignal(props.pane.url ?? "");
  const [draft, setDraft] = createSignal<string | undefined>();
  const [error, setError] = createSignal<string | undefined>();
  const [state, setState] = createSignal<"opening" | "open" | "failed">(
    "opening",
  );
  const modal = createModalOpen();
  let disposed = false;
  let last: Bounds | undefined;

  props.focusRef?.(() => cell.focus());
  onCleanup(() => props.focusRef?.(undefined));

  const fail = (e: unknown) =>
    setError(e instanceof Error ? e.message : `${e}`);

  const rect = () => boundsOf(body.getBoundingClientRect());

  /** 子の webview を作る。最初の URL は shj が頼んだもの、失敗したあとは URL 欄に打ったもの。 */
  async function open(u: string) {
    setError(undefined);
    setState("opening");
    last = rect();
    try {
      await openBrowser(key, props.target, u, last);
    } catch (e) {
      if (!disposed) {
        setState("failed");
        fail(e);
      }
      return;
    }
    if (disposed) {
      void closeBrowser(key).catch(() => {});
      return;
    }
    setState("open");
    setUrl(u);
  }

  onMount(() => {
    void open(props.pane.url ?? "");
    let off: (() => void) | undefined;
    void onBrowserUrl(key, (u) => {
      setUrl(u);
      setDraft(undefined);
    }).then((f) => (disposed ? f() : (off = f)));
    // 位置が変わるのは、大きさの変化（ResizeObserver）のほかに、升目の並び替え・サイドバーの幅の変更でもある。
    // 毎フレーム見て、変わったときだけ送る（見えているときだけ）
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (state() !== "open" || !shown()) return;
      const b = rect();
      if (sameBounds(last, b)) return;
      last = b;
      void moveBrowser(key, b).catch(() => {});
    };
    raf = requestAnimationFrame(tick);
    onCleanup(() => {
      disposed = true;
      cancelAnimationFrame(raf);
      off?.();
      void closeBrowser(key).catch(() => {});
    });
  });

  const shown = () => !props.hidden && !modal();

  createEffect(() => {
    if (state() !== "open") return;
    const v = shown();
    if (v) {
      last = rect();
      void moveBrowser(key, last).catch(() => {});
    }
    void showBrowser(key, v).catch(() => {});
  });

  function go(e: Event) {
    e.preventDefault();
    const u = normalizeUrl(draft() ?? url());
    if (!u) {
      setError("開けるのは http と https のアドレスだけです");
      return;
    }
    setDraft(undefined);
    if (state() === "failed") return void open(u);
    setError(undefined);
    goBrowser(key, props.target, u).catch(fail);
  }

  const nav = (a: "back" | "forward" | "reload") =>
    navBrowser(key, a).catch(fail);

  return (
    <div
      class="terminal-cell browser-cell"
      data-active={props.active ? "" : undefined}
      hidden={props.hidden}
      style={props.area ? { "grid-area": props.area } : undefined}
      tabindex="-1"
      ref={cell}
      onFocusIn={() => props.onFocus?.()}
      onPointerDown={() => props.onFocus?.()}
    >
      <form class="browser-head" onSubmit={go}>
        <button
          type="button"
          class="browser-button"
          aria-label="戻る"
          title="戻る"
          disabled={state() !== "open"}
          onClick={() => void nav("back")}
        >
          ←
        </button>
        <button
          type="button"
          class="browser-button"
          aria-label="進む"
          title="進む"
          disabled={state() !== "open"}
          onClick={() => void nav("forward")}
        >
          →
        </button>
        <button
          type="button"
          class="browser-button"
          aria-label="再読み込み"
          title="再読み込み"
          disabled={state() !== "open"}
          onClick={() => void nav("reload")}
        >
          ↻
        </button>
        <input
          class="browser-url"
          type="text"
          spellcheck={false}
          aria-label="アドレス"
          value={draft() ?? url()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button
          type="button"
          class="browser-button"
          aria-label="外部ブラウザで開き直す"
          title="外部ブラウザで開き直す（パスキーなど、欄では使えないとき）"
          disabled={state() !== "open"}
          onClick={() => openExternally(key).catch(fail)}
        >
          ↗
        </button>
        <button
          type="button"
          class="video-close"
          aria-label="ブラウザの欄を閉じる"
          title="閉じる"
          onClick={() => props.onClose()}
        >
          ×
        </button>
      </form>
      <Show when={error()}>
        {(m) => (
          <p class="video-note browser-error" role="alert">
            {m()}
          </p>
        )}
      </Show>
      <div class="browser-body" ref={body}>
        <Show when={state() === "opening"}>
          <p class="video-note" role="status">
            開いています…
          </p>
        </Show>
      </div>
    </div>
  );
}
