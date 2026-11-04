import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";

import { monoFontsReady } from "../fonts.ts";
import type { TermLink, TermSink } from "./link.ts";
import "./terminal.css";

const encoder = new TextEncoder();

/**
 * ターミナル 1 つの欄（F1）。xterm.js で描き、shj とのやりとりは TermLink に任せる。
 * 大きさは欄に合わせ（FitAddon）、変わったら term.resize を送る。並べ方は TerminalGrid（F4）が決める。
 */
export function TerminalView(props: {
  /** 描くターミナル */
  link: TermLink | undefined;
  /** 今使っているターミナルか（F4。並べたときに印を付ける） */
  active?: boolean;
  /** 隠すか。IDE モードでは active の 1 つだけを見せる（隠しても中身は動き続ける） */
  hidden?: boolean;
  /** 欄の位置（CSS grid の grid-area） */
  area?: string;
  /** 欄がフォーカスを受けた（押した・キーを向けた） */
  onFocus?: () => void;
}): JSX.Element {
  let host!: HTMLDivElement;
  // 親 #271 のモック（案：フラットな一覧）の右下の文字と色に合わせる
  const term = new Terminal({
    fontFamily:
      "'JetBrains Mono', ui-monospace, Menlo, Consolas, 'DejaVu Sans Mono', monospace",
    fontSize: 13,
    // 行の高さはモックの 21px に近づける（xterm.js は文字の高さ（約 1.2 倍）に掛ける）
    lineHeight: 21 / 13 / 1.2,
    cursorBlink: true,
    scrollback: 5000,
    theme: {
      background: "#0f1114",
      foreground: "#c9ced6",
      cursor: "#c9ced6",
      selectionBackground: "#2c3442",
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  const sink: TermSink = {
    write: (data, done) => term.write(data, done),
    notice: (text) => term.write(text),
    reset: () => term.reset(),
  };

  // 入力は今つないでいる link に送る
  let current: TermLink | undefined;
  term.onData((s) => current?.input(encoder.encode(s)));
  // マウスの報告など、UTF-8 でない 1 バイトずつの列
  term.onBinary((s) =>
    current?.input(Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff)),
  );

  function refit() {
    if (!host.isConnected || host.clientWidth === 0) return;
    fit.fit();
    current?.resize(term.cols, term.rows);
  }

  // 開いて欄に合わせ終えたか。それまでは link に大きさを送らず、bind もしない
  // （xterm.js の既定の 80×24 を送ると、動いているシェルが一度縮んでしまう）
  const [opened, setOpened] = createSignal(false);

  onMount(() => {
    // xterm.js は open のときに字の幅を測るので、JetBrains Mono を読み終えてから開く
    // （先に開くと代わりの字で測ってしまい、字の間が合わない）
    let disposed = false;
    const ro = new ResizeObserver(() => refit());
    onCleanup(() => {
      disposed = true;
      ro.disconnect();
    });
    void monoFontsReady.then(() => {
      if (disposed) return;
      term.open(host);
      refit();
      ro.observe(host);
      setOpened(true);
    });
  });

  createEffect(() => {
    const link = props.link;
    if (!opened()) return;
    if (link === current) return;
    current?.unbind();
    current = link;
    if (!link) {
      term.reset();
      return;
    }
    link.resize(term.cols, term.rows);
    link.bind(sink);
  });

  onCleanup(() => {
    current?.unbind();
    current = undefined;
    term.dispose();
  });

  return (
    <div
      class="terminal-cell"
      data-active={props.active ? "" : undefined}
      hidden={props.hidden}
      style={props.area ? { "grid-area": props.area } : undefined}
      onFocusIn={() => props.onFocus?.()}
    >
      <div class="terminal-host" ref={host} />
    </div>
  );
}
