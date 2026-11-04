// ファイルの欄のタイトル行・状態行・コマンド行（E3）。中身を決めるのは bars.ts、置くのは FilesView.tsx。
// 画面がまだ無いときも 2 つの行の高さは取っておく（行が出たり消えたりして欄の大きさが変わり、
// view.resize を出し直さないように）。
// 行を押してもキーを受ける textarea（E2）からフォーカスを外さないよう、onMouseDown を呼ぶ側から受ける。
import { createMemo, For, Index, Show, type JSX } from "solid-js";

import type {
  Cmdline,
  Files,
  Overlay,
  Pane,
  Screen,
  Status,
  Theme,
} from "../rpc/protocol.ts";
import {
  cmdlineText,
  modeLabel,
  statusLeft,
  statusRight,
  textCells,
  titleText,
  type StatusItem,
} from "./bars.ts";
import { paneCells } from "./layout.ts";
import { confirmOf } from "./overlay.ts";
import { colorOf } from "./theme.ts";

/** タイトル行の並び。ペインごとのタイトルを、本文と同じ幅で左右に並べる。files が無ければ空の行。 */
export function TitlesView(props: {
  files: Files | undefined;
  theme: Theme | null;
  onMouseDown: (e: MouseEvent) => void;
}): JSX.Element {
  return (
    <div class="files-titles" onMouseDown={props.onMouseDown}>
      <Index each={props.files?.panes ?? []}>
        {(p, i) => (
          <>
            <Show when={i > 0}>
              <div class="files-split" aria-hidden="true" />
            </Show>
            <TitleView
              pane={p()}
              active={i === props.files?.active}
              theme={props.theme}
            />
          </>
        )}
      </Index>
    </div>
  );
}

/**
 * 欄の下の行。コマンド行が開いていればコマンド行、そうでなければ状態行。どちらも無ければ空の状態行。
 * cols は欄の桁数（コマンド行の入る幅に使う）。
 */
export function BottomBar(props: {
  screen: Screen | null;
  cols: number;
  theme: Theme | null;
  onMouseDown: (e: MouseEvent) => void;
}): JSX.Element {
  return (
    <Show
      when={props.screen?.cmdline}
      fallback={
        <StatusView
          status={props.screen?.status ?? null}
          confirm={confirmOf(props.screen?.overlay)}
          theme={props.theme}
          onMouseDown={props.onMouseDown}
        />
      }
    >
      {(c) => (
        <CmdlineView
          cmdline={c()}
          cols={props.cols}
          theme={props.theme}
          onMouseDown={props.onMouseDown}
        />
      )}
    </Show>
  );
}

/**
 * ペインのタイトル行。名前の欄（ファイル名、変更あり、読み取り専用、差分の数と注記）と、右にパスと差分の相手。
 * 幅はペインと同じマス目にする（左右に並べたペインの上にそろえる）。
 */
function TitleView(props: {
  pane: Pane;
  active: boolean;
  theme: Theme | null;
}): JSX.Element {
  const t = () => props.pane.title ?? { text: "" };
  const text = createMemo(() => titleText(t()));
  const color = (name: string) => colorOf(props.theme, name);
  const diff = () => (t().added ?? 0) + (t().deleted ?? 0) > 0;
  return (
    <div
      class="files-title"
      data-active={props.active ? "" : undefined}
      style={{ width: `${paneCells(props.pane)}ch` }}
    >
      <Show when={text().name}>
        <div class="files-title-name" title={t().text}>
          <span class="files-title-text">{text().name}</span>
          <Show when={t().dirty}>
            <span style={{ color: color("dirty") }} aria-label="変更あり">
              ●
            </span>
          </Show>
          <Show when={t().readOnly}>
            <svg
              class="files-title-lock"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              role="img"
              aria-label="読み取り専用"
            >
              <rect x="5" y="11" width="14" height="10" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
          </Show>
          <Show when={diff()}>
            <span style={{ color: color("git.added") }}>+{t().added ?? 0}</span>
            <span style={{ color: color("git.deleted") }}>
              -{t().deleted ?? 0}
            </span>
          </Show>
          <Show when={t().note}>
            <span
              style={{
                color: color(t().noteWarn ? "diag.warn" : "git.renamed"),
              }}
            >
              {t().note}
            </span>
          </Show>
        </div>
      </Show>
      <div class="files-title-path">
        <Show when={text().path}>
          <span>{text().path}</span>
        </Show>
        <Show when={t().peer}>
          <span>↔ {t().peer}</span>
        </Show>
      </div>
    </div>
  );
}

/** 状態行。左にモード・ブランチ・診断・メッセージ、右に位置・字下げ・言語・版。 */
function StatusView(props: {
  status: Status | null;
  /** 確認（E4）。出ていれば状態行に問いを出す */
  confirm?: Overlay;
  theme: Theme | null;
  onMouseDown: (e: MouseEvent) => void;
}): JSX.Element {
  const color = (name: string | undefined) => colorOf(props.theme, name);
  const item = (it: StatusItem) => (
    <span class="files-status-item" style={{ color: color(it.style) }}>
      {it.text}
    </span>
  );
  return (
    <div
      class="files-status"
      role="status"
      aria-label="状態行"
      onMouseDown={props.onMouseDown}
    >
      <Show when={props.status}>
        {(s) => (
          <>
            <Show when={modeLabel(s())}>
              {(label) => (
                <span
                  class="files-status-mode"
                  style={{
                    background: color(s().style || "mode.normal"),
                    color: color("status.fg"),
                  }}
                >
                  {label()}
                </span>
              )}
            </Show>
            <For each={statusLeft(s(), props.confirm)}>{item}</For>
            <span class="files-status-right">
              <For each={statusRight(s(), props.confirm)}>{item}</For>
            </span>
          </>
        )}
      </Show>
    </div>
  );
}

/** `:` と `/` の入力行（検索バーも）。cols は欄の桁数で、入らない分はカーソルが見えるように切る。 */
function CmdlineView(props: {
  cmdline: Cmdline;
  cols: number;
  theme: Theme | null;
  onMouseDown: (e: MouseEvent) => void;
}): JSX.Element {
  const color = (name: string) => colorOf(props.theme, name);
  const parts = createMemo(() => {
    const c = props.cmdline;
    // 左右の余白（1 マス目ずつ）と、ラベル・案内の幅を除いた分に入れる
    const hint = c.hint ? textCells(c.hint) + 1 : 0;
    const cells = Math.max(1, props.cols - 2 - textCells(c.prefix) - hint);
    return cmdlineText(c, cells);
  });
  return (
    <div
      class="files-cmdline"
      aria-label="コマンド行"
      onMouseDown={props.onMouseDown}
    >
      <span
        class="files-cmdline-prefix"
        style={{ color: props.cmdline.hint ? color("heading") : undefined }}
      >
        {props.cmdline.prefix}
      </span>
      <span class="files-cmdline-text">
        {parts().before}
        <span
          class="files-cmdline-cursor"
          style={{
            color: color("cursor.fg"),
            background: color("cursor"),
          }}
        >
          {parts().at}
        </span>
        {parts().after}
      </span>
      <Show when={props.cmdline.hint}>
        <span class="files-cmdline-hint">{props.cmdline.hint}</span>
      </Show>
    </div>
  );
}
