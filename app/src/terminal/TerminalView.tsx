import { Terminal } from "coneko-term";
import {
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";

import { monoFontsReady } from "../fonts.ts";
import type { TermLink, TermSink } from "./link.ts";
import { planWrite, readableMimes, supportsLocation } from "./clipboard.ts";
import { availableOs, readFirstOs, writeOs } from "./clipboardOs.ts";
import { askClipboardRead } from "./clipboardPrompt.ts";
import { createTransfer } from "./transfer.ts";
import { tauriTransferOs } from "./transferOs.ts";
import { askTransfer } from "./transferPrompt.ts";
import {
  collectDrop,
  locate,
  offeredMimes,
  resolveRequest,
  type DropItem,
} from "./dnd.ts";
import {
  notificationSupportFor,
  shouldNotify,
  toOsNotification,
} from "./notify.ts";
import { showOsNotification } from "./notifyOs.ts";
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
    term.replyNotificationQuery(
      id,
      notificationSupportFor(navigator.userAgent),
    ),
  );
  // 出した通知の取り消し関数。欄が無くなったら、あとで返ってきても欄を触らない
  const notifyCancels = new Set<() => void>();
  onCleanup(() => notifyCancels.forEach((c) => c()));
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
        const cancel = await showOsNotification(
          toOsNotification(n),
          n.actions.focus,
          (kind) => {
            notifyCancels.delete(cancel);
            if (kind === "activated") {
              // 欄を前に出す（窓は Rust 側が前に出す）。a=focus が無い通知は、欄を動かさない
              if (n.actions.focus) {
                props.onFocus?.();
                term.focus();
              }
              if (n.actions.report) term.notificationActivated(n.id);
            } else if (n.reportClose) {
              term.notificationClosed(n.id);
            }
          },
        );
        notifyCancels.add(cancel);
      } catch {
        // 通知を出せなくても、ターミナルの動きには関わらない
      }
    })();
  });

  // ターミナルのクリップボード（kitty の OSC 5522）を OS につなぐ。primary selection は扱えないので対応しないと答える
  const pendingReads = new Set<() => void>();
  term.onClipboardWrite((r) => {
    const plan = supportsLocation(r.location) ? planWrite(r.items) : undefined;
    if (!plan) return term.replyClipboardWrite(r.id, "ENOSYS");
    void writeOs(plan).then(
      () => term.replyClipboardWrite(r.id),
      () => term.replyClipboardWrite(r.id, "EIO"),
    );
  });
  term.onClipboardRead((r) => {
    if (!supportsLocation(r.location)) {
      return term.replyClipboardReadError(r.id, "ENOSYS");
    }
    // 種類の一覧は中身を渡さないので、許可は求めない（仕様）
    if (r.list) {
      void availableOs().then(
        (mimes) => term.replyClipboardReadTypes(r.id, mimes),
        () => term.replyClipboardReadError(r.id, "EBUSY"),
      );
      return;
    }
    const ask = askClipboardRead(r.mimes);
    pendingReads.add(ask.cancel);
    void (async () => {
      try {
        if (!(await ask.allowed)) {
          return term.replyClipboardReadError(r.id, "EPERM");
        }
        const item = await readFirstOs(readableMimes(r.mimes));
        term.replyClipboardReadData(r.id, item ? [item] : []);
      } catch {
        term.replyClipboardReadError(r.id, "EBUSY");
      } finally {
        pendingReads.delete(ask.cancel);
      }
    })();
  });
  onCleanup(() => pendingReads.forEach((cancel) => cancel()));

  // ターミナルのファイル転送（kitty の OSC 5113）を OS につなぐ。聞いてから、許された範囲だけ読み書きする（transfer.ts）
  const transfer = createTransfer(
    term,
    tauriTransferOs,
    askTransfer,
    `v${++viewSeq}`,
  );
  term.onFileTransfer((e) => transfer.handle(e));
  onCleanup(() => transfer.dispose());

  // ターミナルのドロップ（kitty の drag and drop protocol）を、WebView の HTML5 DnD につなぐ。
  // プログラムが受け付けると言っていない間は何もしない（今の動きを変えない）。
  // 受けるのは OS から落とされたテキストとファイルの中身だけ。ファイルは頼まれたときに読む（落としたものだけ）。
  // プログラムが始めるドラッグを OS に出すのはここではしない（Tauri に始める口が無い）
  let dropped: DropItem[] = [];
  // プログラムが、今の位置では受けないと答えたか（dropResponse の operation が null）
  let dropRefused = false;
  const dropPoint = (e: DragEvent) => {
    const cell = term.cellSize;
    if (!cell) return undefined;
    return locate(
      host.getBoundingClientRect(),
      cell,
      { cols: term.cols, rows: term.rows },
      { x: e.clientX, y: e.clientY },
    );
  };
  term.onDnd((e) => {
    if (e.type === "dropDisabled" || e.type === "dropFinished") dropped = [];
    if (e.type === "dropResponse") dropRefused = e.operation === null;
    if (e.type !== "dropRequest") return;
    const req = e.request;
    const r = resolveRequest(req, dropped);
    if (r.kind === "error") return term.replyDropError(req, r.error);
    if (r.kind === "data") {
      void r.item.read().then(
        (data) => term.replyDropData(req, { kind: "mime" }, data),
        () => term.replyDropError(req, "EIO"),
      );
    }
  });
  const onDragOver = (e: DragEvent) => {
    const dt = e.dataTransfer;
    if (!dt || !term.dropAccepting) return;
    const at = dropPoint(e);
    if (!at) return;
    e.preventDefault();
    dt.dropEffect = dropRefused ? "none" : "copy";
    term.dropMove(at, offeredMimes(dt.types, Array.from(dt.items)), {
      copy: true,
    });
  };
  const onDragLeave = (e: DragEvent) => {
    if (e.relatedTarget instanceof Node && host.contains(e.relatedTarget)) {
      return;
    }
    dropRefused = false;
    term.dropLeave();
  };
  const onDrop = (e: DragEvent) => {
    const dt = e.dataTransfer;
    if (!dt || !term.dropAccepting) return;
    e.preventDefault();
    const at = dropPoint(e);
    const refused = dropRefused;
    dropRefused = false;
    const items = refused ? [] : collectDrop(dt);
    if (!at || items.length === 0) {
      term.dropLeave();
      return;
    }
    const sent = term.dropDrop(
      at,
      items.map((i) => i.mime),
      { copy: true },
    );
    // 送れなかった（受け付けをやめた直後など）ときは、ファイルを持ち越さない
    dropped = sent ? items : [];
  };

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
    host.addEventListener("dragenter", onDragOver);
    host.addEventListener("dragover", onDragOver);
    host.addEventListener("dragleave", onDragLeave);
    host.addEventListener("drop", onDrop);
    onCleanup(() => props.focusRef?.(undefined));
    const ro = new ResizeObserver(() => refit());
    onCleanup(() => {
      host.removeEventListener("dragenter", onDragOver);
      host.removeEventListener("dragover", onDragOver);
      host.removeEventListener("dragleave", onDragLeave);
      host.removeEventListener("drop", onDrop);
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

// 欄ごとの印。ファイル転送のセッションの鍵が、欄どうしで混ざらないようにする
let viewSeq = 0;
