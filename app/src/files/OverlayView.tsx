// ファイルの欄のポップアップ（E4）。shj が送る Screen.overlay を、本文の上に重ねて描くだけ。
// キーは今までどおり本文の textarea が受けて shj に送り、選択やスクロールは shj が決めて送り直す。
// 置き場所と大きさは overlay.ts、色はテーマ（theme.ts の --files-pop-*）、見た目は files.css。
//
// - 箱はマス目（桁は ch、行は LINE_HEIGHT）で置く。本文の 1 行目は上の余白（PAD_Y）の下。
// - 確認（confirm）は箱にせず、状態行に出す（BarsView.tsx）。
// - レビューカードの中の画像（images）は、行の上に重ねる（E6。MediaView.tsx の PreviewImages）。
// - 押しても shj には送らず、キーを受ける textarea からフォーカスを外さない。
import { createMemo, For, Index, Show, type JSX } from "solid-js";

import type { Files, Item, Line, Overlay, Theme } from "../rpc/protocol.ts";
import { cmdlineText, textCells } from "./bars.ts";
import type { BlobSource } from "./blob.ts";
import { LINE_HEIGHT, PAD_Y } from "./layout.ts";
import { PreviewImages } from "./MediaView.tsx";
import {
  COMPLETION_KIND_W,
  composeRows,
  isComposer,
  itemLine,
  menuLayout,
  overlayBox,
  overlayRuns,
  paletteLabel,
  scrollIndicator,
  textLine,
  type Area,
  type Box,
} from "./overlay.ts";
import { colorOf, runStyle } from "./theme.ts";

/** ポップアップを重ねる層。area は本文のマス目の数。 */
export function OverlayLayer(props: {
  overlays: readonly Overlay[] | null | undefined;
  files: Files | undefined;
  area: Area;
  theme: Theme | null;
  /** レビューカードの画像の取り先 */
  blobs?: BlobSource;
  onMouseDown: (e: MouseEvent) => void;
}): JSX.Element {
  return (
    <div class="files-overlay">
      <For each={props.overlays ?? []}>
        {(ov) => (
          <OverlayBox
            overlay={ov}
            files={props.files}
            area={props.area}
            theme={props.theme}
            blobs={props.blobs}
            onMouseDown={props.onMouseDown}
          />
        )}
      </For>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  completion: "補完",
  hover: "ホバー",
  signature: "シグネチャ",
  palette: "パレット",
  menu: "メニュー",
  reviewCard: "レビュー",
};

function OverlayBox(props: {
  overlay: Overlay;
  files: Files | undefined;
  area: Area;
  theme: Theme | null;
  blobs?: BlobSource;
  onMouseDown: (e: MouseEvent) => void;
}): JSX.Element {
  const box = createMemo(() =>
    overlayBox(props.overlay, props.files, props.area),
  );
  return (
    <Show when={box()}>
      {(b) => (
        <div
          class="files-pop"
          role="dialog"
          aria-label={props.overlay.title || KIND_LABEL[props.overlay.kind]}
          data-kind={props.overlay.kind}
          style={boxStyle(b())}
          onMouseDown={(e) => {
            e.stopPropagation();
            props.onMouseDown(e);
          }}
        >
          <OverlayBody
            overlay={props.overlay}
            box={b()}
            theme={props.theme}
            blobs={props.blobs}
          />
        </div>
      )}
    </Show>
  );
}

function boxStyle(b: Box): Record<string, string> {
  return {
    left: `${b.x}ch`,
    top: `${PAD_Y + b.y * LINE_HEIGHT}px`,
    width: `${b.w}ch`,
    height: `${b.h * LINE_HEIGHT}px`,
  };
}

function OverlayBody(props: {
  overlay: Overlay;
  box: Box;
  theme: Theme | null;
  blobs?: BlobSource;
}): JSX.Element {
  const ov = () => props.overlay;
  switch (props.overlay.kind) {
    case "completion":
      return <CompletionBody overlay={ov()} cols={props.box.w} />;
    case "hover":
      return <ScrollBody overlay={ov()} box={props.box} theme={props.theme} />;
    case "signature":
      return (
        <div class="files-pop-row files-pop-pad">
          <LineRuns
            line={ov().lines?.[0]}
            cols={props.box.w - 2}
            theme={props.theme}
          />
        </div>
      );
    case "reviewCard":
      return isComposer(props.overlay) ? (
        <ComposerBody
          overlay={ov()}
          box={props.box}
          theme={props.theme}
          blobs={props.blobs}
        />
      ) : (
        <ScrollBody
          overlay={ov()}
          box={props.box}
          theme={props.theme}
          blobs={props.blobs}
        />
      );
    case "menu":
      return <MenuBody overlay={ov()} box={props.box} theme={props.theme} />;
    case "palette":
      return <PaletteBody overlay={ov()} box={props.box} theme={props.theme} />;
    default:
      return null;
  }
}

/** 区間の並びで来た 1 行（ホバー・カード・シグネチャ・プレビュー）。 */
function LineRuns(props: {
  line: Line | undefined;
  cols: number;
  theme: Theme | null;
}): JSX.Element {
  const runs = createMemo(() =>
    props.line ? overlayRuns(props.line, props.cols) : [],
  );
  return (
    <For each={runs()}>
      {(r) => (
        <span class="files-run" style={runStyle(props.theme, r)}>
          {r.text}
        </span>
      )}
    </For>
  );
}

/** 補完の候補。名前と、右に種類。 */
function CompletionBody(props: {
  overlay: Overlay;
  cols: number;
}): JSX.Element {
  return (
    <div role="listbox">
      <Index each={props.overlay.items ?? []}>
        {(it, i) => (
          <div
            class="files-pop-row files-pop-item"
            role="option"
            aria-selected={i === props.overlay.active}
            data-active={i === props.overlay.active ? "" : undefined}
          >
            <span class="files-pop-label">
              <LineRuns
                line={textLine([{ text: ` ${it().label}` }])}
                cols={props.cols - COMPLETION_KIND_W}
                theme={null}
              />
            </span>
            <span
              class="files-pop-dim"
              style={{ width: `${COMPLETION_KIND_W}ch`, flex: "none" }}
            >
              {" "}
              {it().kind ?? ""}
            </span>
          </div>
        )}
      </Index>
    </div>
  );
}

/**
 * ホバーとレビューカード。行（見えている分だけ）と、枠の下の案内と位置。
 * ホバーは上の行の右端に「コピー」を出す（押すところは shj のキーで、ここでは文言だけ）。
 */
function ScrollBody(props: {
  overlay: Overlay;
  box: Box;
  theme: Theme | null;
  blobs?: BlobSource;
}): JSX.Element {
  const ov = () => props.overlay;
  const cols = () => Math.max(1, props.box.w - 2);
  const indicator = createMemo(() => scrollIndicator(ov()));
  const color = (name: string | undefined) => colorOf(props.theme, name);
  return (
    <>
      <Show when={ov().kind === "hover"}>
        <div class="files-pop-row files-pop-pad files-pop-head">
          <span class="files-pop-dim">{ov().copyLabel ?? ""}</span>
        </div>
      </Show>
      <div class="files-pop-lines">
        <For each={ov().lines ?? []}>
          {(l) => (
            <div
              class="files-pop-row files-pop-pad"
              style={{ background: color(l.band) }}
            >
              <Show
                when={!l.rule}
                fallback={<span class="files-pop-rule" aria-hidden="true" />}
              >
                <LineRuns line={l} cols={cols()} theme={props.theme} />
              </Show>
            </div>
          )}
        </For>
        <PreviewImages
          images={ov().images}
          top={ov().view?.top ?? 0}
          cols={cols()}
          left={1}
          blobs={props.blobs}
        />
      </div>
      <div class="files-pop-row files-pop-pad files-pop-foot">
        <span class="files-pop-dim files-pop-label">{ov().hint ?? ""}</span>
        <span class="files-pop-dim">{indicator()}</span>
      </div>
    </>
  );
}

/** 入力欄の文字。カーソルの文字を cursor の色で塗る。全角の幅は本文と同じく区間の幅（ch）でそろえる。 */
function FieldText(props: {
  text: string;
  cursor: number;
  cells: number;
  placeholder?: string;
}): JSX.Element {
  const parts = createMemo(() =>
    cmdlineText(
      { prefix: "", text: props.text, cursor: props.cursor },
      Math.max(1, props.cells),
    ),
  );
  const big = 1 << 16;
  return (
    <span class="files-pop-field">
      <LineRuns
        line={textLine([{ text: parts().before }])}
        cols={big}
        theme={null}
      />
      <span
        class="files-run files-pop-cursor"
        data-cursor=""
        style={{ width: `${textCells(parts().at)}ch` }}
      >
        {parts().at}
      </span>
      <LineRuns
        line={textLine([{ text: parts().after }])}
        cols={big}
        theme={null}
      />
      <Show when={!props.text && props.placeholder}>
        <span class="files-pop-dim">{props.placeholder}</span>
      </Show>
    </span>
  );
}

/** コマンドパレット。見出しと入力欄、項目、候補が無いときの案内。 */
function PaletteBody(props: {
  overlay: Overlay;
  box: Box;
  theme: Theme | null;
}): JSX.Element {
  const ov = () => props.overlay;
  const label = () => paletteLabel(ov().title, ov().field?.prefix ?? ">");
  return (
    <>
      <div class="files-pop-row files-pop-input">
        <span class="files-pop-accent">{label()}</span>
        <FieldText
          text={ov().field?.text ?? ""}
          cursor={ov().field?.cursor ?? 0}
          cells={props.box.w - textCells(label()) - 1}
          placeholder={ov().field?.placeholder}
        />
      </div>
      <div role="listbox">
        <Index each={ov().items ?? []}>
          {(it, i) => (
            <div
              class="files-pop-row files-pop-item files-pop-pad"
              role="option"
              aria-selected={i === ov().active}
              data-active={i === ov().active ? "" : undefined}
            >
              <span style={{ width: "1ch", flex: "none" }} />
              <span class="files-pop-label">
                <LineRuns
                  line={itemLine(it())}
                  cols={props.box.w - 3}
                  theme={props.theme}
                />
              </span>
            </div>
          )}
        </Index>
      </div>
      <Show when={ov().hint}>
        <div class="files-pop-row files-pop-pad files-pop-dim">{ov().hint}</div>
      </Show>
    </>
  );
}

/** メニュー（スペースキーの後など）。見出しと、キーと名前の並び（1 列か 2 列）。 */
function MenuBody(props: {
  overlay: Overlay;
  box: Box;
  theme: Theme | null;
}): JSX.Element {
  const items = () => props.overlay.items ?? [];
  const m = createMemo(() => menuLayout(items(), props.box.w));
  const rows = createMemo(() =>
    Array.from({ length: m().per }, (_, r) =>
      Array.from(
        { length: m().cols },
        (_, c) => items()[c * m().per + r],
      ).filter((it): it is Item => !!it),
    ),
  );
  return (
    <>
      <div class="files-pop-row files-pop-pad files-pop-accent">
        {props.overlay.title ?? ""}
      </div>
      <For each={rows()}>
        {(row) => (
          <div class="files-pop-row files-pop-pad files-pop-menu-row">
            <For each={row}>
              {(it) => (
                <span
                  class="files-pop-menu-item"
                  style={{ width: `${m().cellW}ch` }}
                >
                  <LineRuns
                    line={textLine([
                      {
                        text: it.detail ?? "",
                        style: "palette.hi",
                        bold: true,
                      },
                      { text: ` ${it.label}` },
                    ])}
                    cols={m().cellW}
                    theme={props.theme}
                  />
                </span>
              )}
            </For>
          </div>
        )}
      </For>
    </>
  );
}

/** レビューのコメントの入力欄。見出し、入力（カーソル付き）、案内、プレビュー。 */
function ComposerBody(props: {
  overlay: Overlay;
  box: Box;
  theme: Theme | null;
  blobs?: BlobSource;
}): JSX.Element {
  const ov = () => props.overlay;
  const cols = () => Math.max(1, props.box.w - 2);
  const input = createMemo(() =>
    composeRows(ov().compose?.text ?? "", ov().compose?.cursor.line ?? 0),
  );
  return (
    <>
      <div class="files-pop-row files-pop-pad files-pop-accent">
        {ov().title ?? ""}
      </div>
      <div class="files-pop-compose">
        <Index each={input().rows}>
          {(text, i) => (
            <div class="files-pop-row files-pop-pad">
              <Show
                when={input().first + i === ov().compose?.cursor.line}
                fallback={
                  <LineRuns
                    line={textLine([{ text: text() }])}
                    cols={cols()}
                    theme={null}
                  />
                }
              >
                <FieldText
                  text={text()}
                  cursor={ov().compose?.cursor.col ?? 0}
                  cells={cols()}
                />
              </Show>
            </div>
          )}
        </Index>
      </div>
      <div class="files-pop-row files-pop-pad files-pop-foot">
        <span class="files-pop-dim files-pop-label">{ov().hint ?? ""}</span>
      </div>
      <Show when={ov().compose?.previewLabel}>
        <div class="files-pop-row files-pop-pad files-pop-dim">
          {ov().compose?.previewLabel}
        </div>
        <div class="files-pop-lines">
          <For each={ov().lines ?? []}>
            {(l) => (
              <div class="files-pop-row files-pop-pad">
                <LineRuns line={l} cols={cols()} theme={props.theme} />
              </div>
            )}
          </For>
          <PreviewImages
            images={ov().images}
            top={0}
            cols={cols()}
            left={1}
            blobs={props.blobs}
          />
        </div>
      </Show>
    </>
  );
}
