import { Terminal } from "coneko-term";
import {
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

import { monoFontsReady } from "../fonts.ts";
import type { TermLink, TermSink } from "./link.ts";
import {
  notificationSupport,
  shouldNotify,
  toOsNotification,
} from "./notify.ts";
import "./terminal.css";

/**
 * ターミナル 1 つの欄（F1）。coneko-term で描き、shj とのやりとりは TermLink に任せる。
 * 大きさは欄に合わせ（term.fit）、変わったら term.resize を送る。並べ方は TerminalGrid（F4）が決める。
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
  /** この欄にキーを向ける関数を受け取る（欄が無くなるとき undefined で呼ぶ） */
  focusRef?: (focus: (() => void) | undefined) => void;
}): JSX.Element {
  let host!: HTMLDivElement;
  // 親 #271 のモック（案：フラットな一覧）の右下の文字と色に合わせる
  const term = new Terminal({
    fontFamily:
      "'JetBrains Mono', ui-monospace, Menlo, Consolas, 'DejaVu Sans Mono', monospace",
    fontSize: 13,
    // 行の高さはモックの 21px に近づける（coneko-term は文字の高さ（約 1.2 倍）に掛ける）
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

  const sink: TermSink = {
    write: (data, done) => term.write(data, done),
    notice: (text) => term.write(text),
    reset: () => term.reset(),
  };

  // 入力は今つないでいる link に送る
  let current: TermLink | undefined;
  // キー・貼り付け・マウスの報告・問い合わせへの返事は、どれもバイト列で出てくる
  term.onData((b) => current?.input(b));

  // ターミナルの通知（kitty の OSC 99）を OS の通知につなぐ。何に対応すると答えるかは notify.ts
  term.onNotificationQuery((id) =>
    term.replyNotificationQuery(id, notificationSupport),
  );
  term.onNotification((n) => {
    if (
      !shouldNotify(n.when, {
        windowFocused: document.hasFocus(),
        cellVisible: !props.hidden,
        pageVisible: document.visibilityState === "visible",
      })
    )
      return;
    void (async () => {
      try {
        if (await notifyPermission()) sendNotification(toOsNotification(n));
      } catch {
        // 通知を出せなくても、ターミナルの動きには関わらない
      }
    })();
  });

  function refit() {
    if (!host.isConnected || host.clientWidth === 0) return;
    term.fit();
    current?.resize(term.cols, term.rows);
  }

  // 開いて欄に合わせ終えたか。それまでは link に大きさを送らず、bind もしない
  // （coneko-term の既定の 80×24 を送ると、動いているシェルが一度縮んでしまう）
  const [opened, setOpened] = createSignal(false);

  onMount(() => {
    // coneko-term は open のときに字の幅を測るので、JetBrains Mono を読み終えてから開く
    // （先に開くと代わりの字で測ってしまい、字の間が合わない）
    let disposed = false;
    props.focusRef?.(() => term.focus());
    onCleanup(() => props.focusRef?.(undefined));
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

// 通知の許可。全部の欄で 1 つの Promise にまとめ、許可のダイアログを同時に複数出さない。
// 拒否されたら、このセッションでは求め直さない
let permission: Promise<boolean> | undefined;
function notifyPermission(): Promise<boolean> {
  permission ??= (async () => {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  })();
  return permission;
}
