// ファイルの欄（E1）。shj が送る Screen の files を描くだけで、編集の処理は shj がする。
// 1 行の並べ方は layout.ts、色は theme.ts、見た目は files.css（モック「案：フラットな一覧」に合わせる）。
//
// - 文字は等幅フォントのマス目に置く。区間ごとに幅をマス目（ch）で決めるので、全角の文字もずれない。
// - 欄の大きさが変わったら、入るマス目の桁数と行数を onResize で知らせる（呼ぶ側が view.resize を送る）。
// - キー・IME・マウス・貼り付けは onInput で shj に送る（E2）。キーは見えない textarea で受ける
//   （IME の変換と貼り付けを OS に任せるため）。変換中の文字は shj が下線付きで画面に入れて返す。
//   イベントの受け方は filesInput.ts、パラメータの作り方は input.ts、OS のクリップボードは clipboard.ts。
// - 上にペインごとのタイトル行、下に状態行（コマンド行が開いているときはコマンド行）を出す
//   （E3。BarsView.tsx、中身は bars.ts）。
// - 補完・ホバー・パレットなどのポップアップ（E4）を本文の上に重ねる（OverlayView.tsx、置き場所は
//   overlay.ts）。確認は状態行に出す。
// - 行番号の横の印・診断の波線と行末の文言・インデントガイド（E5）を描く（並べ方は layout.ts）。
// - 画像・プレビュー・差分（E6）を Pane.kind で描き分ける（部品は MediaView.tsx）。画像の実体は blob.get で
//   取る（blob.ts。blobs が無ければ画像は出さない）。差分は左右のペイン（1 列のときは 1 つ）が来て、
//   変更の後の側の右端に変更のバー（diff.ts）を重ねる。行の色分けは layout.ts。
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  onCleanup,
  onMount,
  Show,
  type JSX,
  untrack,
} from "solid-js";

import type { Line, Pane, Screen, Theme } from "../rpc/protocol.ts";
import { BottomBar, TitlesView } from "./BarsView.tsx";
import type { BlobSource } from "./blob.ts";
import type { OsClipboard } from "./clipboard.ts";
import {
  createKeyInput,
  createOrderedSend,
  createPointerInput,
  type SendInput,
} from "./filesInput.ts";
import { isMac } from "./input.ts";
import { OverlayLayer } from "./OverlayView.tsx";
import {
  cellsFor,
  gutterMark,
  gutterNumber,
  hasGutter,
  isCurrentLine,
  layoutLine,
  lineBg,
  lineKey,
  paneCells,
  type FilesSize,
  type LineOptions,
} from "./layout.ts";
import { ChangeBar, ImageBody, PreviewImages } from "./MediaView.tsx";
import { colorOf, filesVars, runStyle } from "./theme.ts";
import "./files.css";

export type { BlobSource, FilesSize, SendInput };

/**
 * ファイルの欄。screen（フォーカスしているマシンの画面）の files を、theme の色で描く。
 * screen が null のときと files が無いときは、空の欄だけを出す。
 * 欄の大きさが変わったら、入るマス目の桁数と行数を onResize で知らせる。
 */
export function FilesView(props: {
  screen: Screen | null;
  theme: Theme | null;
  onResize: (size: FilesSize) => void;
  /** 入力の送り先。省くと送らない */
  onInput?: SendInput;
  /** OS のクリップボード（貼り付けのキーで読む）。省くと貼り付けない */
  clipboard?: OsClipboard;
  /** 画像の取り先（blob.get）。省くと画像を出さない */
  blobs?: BlobSource;
}): JSX.Element {
  let body: HTMLDivElement | undefined;
  let measure: HTMLSpanElement | undefined;
  let ime: HTMLTextAreaElement | undefined;
  let last: FilesSize | undefined;
  // 欄の桁数と行数（コマンド行の入る幅と、ポップアップの置き場所に使う）
  const [size, setSize] = createSignal<FilesSize>({ cols: 0, rows: 0 });
  const cols = () => size().cols;

  /** 等幅のマス目 1 つの幅（px）。 */
  function cellWidth(): number {
    if (!measure) return 8;
    return measure.getBoundingClientRect().width / measure.textContent!.length;
  }

  function report() {
    if (!body || !measure) return;
    // 欄を出していない（ファイルを開いていない IDE モード。app.css）あいだは知らせない。
    // shj には前の大きさのままにしておき、欄を出したら測り直して知らせる
    if (body.clientWidth === 0 || body.clientHeight === 0) return;
    const size = cellsFor(body.clientWidth, body.clientHeight, cellWidth());
    if (last && last.cols === size.cols && last.rows === size.rows) return;
    last = size;
    setSize(size);
    props.onResize(size);
  }
  onMount(() => {
    const ro = new ResizeObserver(report);
    ro.observe(body!);
    onCleanup(() => ro.disconnect());
    // 等幅フォントを読み込み終えたら、マス目の幅が変わることがある
    void document.fonts?.ready.then(() => {
      last = undefined;
      report();
    });
    // ホイールで欄そのものがスクロールしないよう、passive にしない
    body!.addEventListener("wheel", pointer.onWheel, { passive: false });
    onCleanup(() => body?.removeEventListener("wheel", pointer.onWheel));
  });

  const files = () => props.screen?.files;

  // ---- 入力（E2） ----

  const send = createOrderedSend(() => props.onInput);
  const focusIme = () => ime?.focus({ preventScroll: true });
  // タイトル行・状態行を押しても、キーを受ける textarea からフォーカスを外さない
  const keepFocus = (e: MouseEvent) => {
    e.preventDefault();
    focusIme();
  };
  const keys = createKeyInput({
    send,
    clipboard: () => props.clipboard,
    mac: isMac(navigator.platform || navigator.userAgent),
    ime: () => ime,
    body: () => body,
  });
  const pointer = createPointerInput({
    send,
    clipboard: () => props.clipboard,
    files,
    cellWidth,
    focus: focusIme,
  });

  // 画面が出たとき、ほかに何もフォーカスしていなければキーを受ける
  createEffect(() => {
    if (!files()) return;
    if (!document.activeElement || document.activeElement === document.body)
      focusIme();
  });

  return (
    <section class="files" aria-label="ファイル" style={filesVars(props.theme)}>
      <TitlesView files={files()} theme={props.theme} onMouseDown={keepFocus} />
      <div
        class="files-body"
        ref={body}
        onMouseDown={pointer.onMouseDown}
        onContextMenu={(e) => e.preventDefault()}
        // 本文はスクロールさせない（行の位置は shj が決める）。IME のキャレットなどでずれたら戻す
        onScroll={(e) => {
          e.currentTarget.scrollTop = 0;
          e.currentTarget.scrollLeft = 0;
        }}
      >
        <span class="files-measure" ref={measure} aria-hidden="true">
          {"0".repeat(64)}
        </span>
        <textarea
          class="files-ime"
          ref={ime}
          aria-label="ファイルの欄への入力"
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          onKeyDown={keys.onKeyDown}
          onPaste={keys.onPaste}
          onCompositionStart={keys.onCompositionStart}
          onCompositionEnd={keys.onCompositionEnd}
          onInput={keys.onInput}
          onFocus={keys.onFocus}
        />
        <Show when={files()}>
          {(f) => (
            // 位置で使い回す（ペインが新しいオブジェクトになっても PaneView と変わらない行の DOM を残す）
            <Index each={f().panes}>
              {(p, i) => (
                <>
                  {/* 左右に並べたペインの間の線（E7）。割り方は shj が決め、ペインの幅は viewport で来る */}
                  <Show when={i > 0}>
                    <div class="files-split" aria-hidden="true" />
                  </Show>
                  <PaneView
                    pane={p()}
                    active={i === f().active}
                    theme={props.theme}
                    blobs={props.blobs}
                  />
                </>
              )}
            </Index>
          )}
        </Show>
        <OverlayLayer
          overlays={props.screen?.overlay}
          files={files()}
          area={size()}
          theme={props.theme}
          blobs={props.blobs}
          onMouseDown={keepFocus}
        />
      </div>
      <BottomBar
        screen={props.screen}
        cols={cols()}
        theme={props.theme}
        onMouseDown={keepFocus}
      />
    </section>
  );
}

function PaneView(props: {
  pane: Pane;
  active: boolean;
  theme: Theme | null;
  blobs?: BlobSource;
}): JSX.Element {
  const opts = createMemo<LineOptions>(() => ({ cursor: props.active }));
  const gutter = () => hasGutter(props.pane);
  const image = () => props.pane.kind === "image";
  const preview = () =>
    props.pane.kind === "preview" ? props.pane.preview : undefined;
  // 変更のバーは変更の後の側（右か 1 列）に出す
  const diff = () =>
    props.pane.kind === "diff" && props.pane.diff?.side !== "old"
      ? props.pane.diff
      : undefined;
  return (
    <div
      class="files-pane"
      role="region"
      aria-label={props.pane.title?.text || props.pane.id}
      data-kind={props.pane.kind}
      data-pane-id={props.pane.id}
      data-active={props.active ? "" : undefined}
      style={{ width: `${paneCells(props.pane)}ch` }}
    >
      <Show when={image()}>
        <ImageBody
          caption={props.pane.caption}
          image={props.pane.image}
          rows={props.pane.viewport.rows}
          blobs={props.blobs}
        />
      </Show>
      <Show when={!image()}>
        <For each={props.pane.lines ?? []}>
          {(line) => (
            <LineView
              line={line}
              pane={props.pane}
              opts={opts()}
              gutter={gutter()}
              theme={props.theme}
            />
          )}
        </For>
      </Show>
      <Show when={preview()}>
        {(pv) => (
          <PreviewImages
            images={pv().images}
            top={pv().top}
            cols={props.pane.viewport.cols}
            blobs={props.blobs}
          />
        )}
      </Show>
      <Show when={diff()}>
        {(d) => (
          <ChangeBar
            diff={d()}
            rows={props.pane.viewport.rows}
            theme={props.theme}
          />
        )}
      </Show>
    </div>
  );
}

function LineView(props: {
  line: Line;
  pane: Pane;
  opts: LineOptions;
  gutter: boolean;
  theme: Theme | null;
}): JSX.Element {
  // ペインが変わっても、この行を描くのに使う項目が同じなら描き直さない（key は文字列なので、同じなら先へ伝わらない）
  const key = createMemo(() => lineKey(props.line, props.pane, props.opts));
  const runs = createMemo(() => {
    key();
    return untrack(() => layoutLine(props.line, props.pane, props.opts));
  });
  const bg = createMemo(() => {
    key();
    return untrack(() => lineBg(props.line, props.pane));
  });
  const total = createMemo(() => props.pane.viewport.total);
  const mark = createMemo(() => gutterMark(props.line));
  const current = () => isCurrentLine(props.line, props.pane);
  return (
    <div class="files-line" style={{ background: colorOf(props.theme, bg()) }}>
      <Show when={props.gutter}>
        <span
          class="files-gutter"
          data-current={current() ? "" : undefined}
          aria-hidden="true"
        >
          <span
            class="files-gutter-mark"
            style={{ color: colorOf(props.theme, mark()?.style) }}
          >
            {mark()?.ch ?? " "}
          </span>
          {gutterNumber(props.line.no, total())}
        </span>
      </Show>
      <For each={runs()}>
        {(r) => (
          <span
            class="files-run"
            data-cursor={r.cursor ? "" : undefined}
            style={runStyle(props.theme, r)}
          >
            {r.text}
          </span>
        )}
      </For>
    </div>
  );
}
