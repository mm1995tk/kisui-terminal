// ワークスペースの帯のヘッダー（名前と切り替え・「+」・鉛筆・✕）。名前をその場で変える入力欄と、フォーカスしているワークスペースが無いときのヘッダーも持つ。
import { T } from "../../../../i18n/index.ts";
import { Show, type JSX } from "solid-js";

import { leaderKeyName } from "../../../../features/commands/commands.ts";
import { IS_MAC } from "../../../../features/commands/guiKeys.ts";
import type { Row } from "../../../../features/workspaces/rows.ts";
import type { Handlers } from "../handlers.ts";
import { ICON } from "../icons.ts";
import { renameKeyAction } from "../renameInput.ts";
import { Nf } from "./parts.tsx";

/**
 * 名前をその場で変える入力欄（Enter で onRenameSubmit、Esc・フォーカスが外れたら onRenameCancel）。
 * 入力欄はボタンの中に置けないので、名前を変えている間は、フォーカスを移すボタンの所がこの div になる。
 */
function BandRenameInput(
  props: Handlers & { edit: NonNullable<Handlers["renaming"]> },
): JSX.Element {
  return (
    <div class="band-main">
      <input
        class="band-rename"
        type="text"
        aria-label={T("sidebar.nameLabel")}
        aria-invalid={props.edit.error ? "true" : undefined}
        placeholder={T("sidebar.namePlaceholder", { auto: props.edit.auto })}
        value={props.edit.current}
        onKeyDown={(e) => {
          const a = renameKeyAction(e);
          if (!a) return;
          e.preventDefault();
          e.stopPropagation();
          if (a === "submit") props.onRenameSubmit?.(e.currentTarget.value);
          else props.onRenameCancel?.(true);
        }}
        onBlur={() => {
          // ほかのアプリに切り替えただけ（窓が外れた）では、打ちかけの名前を消さない
          if (document.hasFocus()) props.onRenameCancel?.();
        }}
        ref={(el) =>
          // リーダーの後でターミナルにフォーカスが戻るのと競らないよう、1 拍置いて取る
          setTimeout(() => {
            el.focus();
            el.select();
          })
        }
      />
    </div>
  );
}

/**
 * フォーカスしているワークスペースが無いとき（1 つも無いときなど）のヘッダー。切り替えのポップアップを開くボタンと、「+ ワークスペースを作る」だけを置く。
 * ワークスペースが 1 つも無ければ、ポップアップを開くボタンは出さない（開いても何も無い）。
 */
export function EmptyHeader(props: {
  onSwitch?: () => void;
  onNew?: () => void;
  total: number;
}): JSX.Element {
  return (
    <div class="sidebar-empty">
      <Show when={props.total > 0 && props.onSwitch}>
        <button
          type="button"
          class="band-btn-wide band-switch"
          aria-haspopup="dialog"
          title={switchTip()}
          onClick={() => props.onSwitch?.()}
        >
          <span class="band-title">{T("sidebar.noFocus")}</span>
          <SwitchIcon />
        </button>
      </Show>
      <button
        type="button"
        class="new-workspace"
        onClick={() => props.onNew?.()}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          aria-hidden="true"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
        {T("sidebar.newWorkspace")}
      </button>
    </div>
  );
}

/** 切り替えのボタンのツールチップ：「Switch workspace」と、窓を開くキー（リーダーの後の w。#296） */
function switchTip(): string {
  return T("sidebar.switchWorkspace", { leader: leaderKeyName(IS_MAC) });
}

/** 切り替えのボタンの印：双方向の矢印（⇄。GitHub のダッシュボードの切り替えと同じ印） */
function SwitchIcon(): JSX.Element {
  return (
    <svg
      class="band-swap"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M2 5.5h11M10.5 3l2.5 2.5-2.5 2.5M14 10.5H3M5.5 8 3 10.5 5.5 13" />
    </svg>
  );
}

/**
 * 帯のヘッダー（名前と切り替え・「+」・鉛筆・✕）。上に固定する。
 * 名前のボタンは、押すと切り替えのポップアップを開く（名前の右に ⇄。名前から ⇄ までが 1 つのボタンで、右の「+」・鉛筆・✕とは線で区切る）。
 * ヘッダーは行にして、ボタンを並べる。名前を変えている間は、名前のボタンの所が入力欄の div になる（ボタンの中に入力欄もボタンも置けない）。
 */
export function BandHeader(
  props: Handlers & {
    row: Row;
    editing: Handlers["renaming"];
  },
): JSX.Element {
  const b = () => props.row.band;
  const editing = () => props.editing ?? undefined;
  return (
    <div class="band-slot" data-sticky="top">
      <div
        class="band"
        aria-current="true"
        title={b().root || undefined}
        onContextMenu={(e) => {
          if (!props.onBandMenu) return;
          e.preventDefault();
          props.onBandMenu(props.row.gws, e.clientX, e.clientY);
        }}
      >
        <Show
          when={editing()}
          fallback={
            <button
              type="button"
              class="band-main band-switch"
              aria-haspopup="dialog"
              aria-label={T("sidebar.switchWorkspaceFrom", {
                title: b().title,
              })}
              title={switchTip()}
              onClick={() => props.onSwitch?.()}
            >
              <span class="band-title">{b().title}</span>
              <SwitchIcon />
            </button>
          }
        >
          {(r) => <BandRenameInput {...props} edit={r()} />}
        </Show>
        <Show when={props.onAddMenu}>
          <button
            type="button"
            class="band-btn band-add"
            aria-haspopup="menu"
            aria-label={T("sidebar.addTabTo", { title: b().title })}
            title={T("sidebar.addTab")}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              props.onAddMenu?.(props.row.gws, r.left, r.bottom);
            }}
          >
            <Nf c={ICON.plus} />
          </button>
        </Show>
        <button
          type="button"
          class="band-btn band-close band-edit"
          data-off={props.onRenameWorkspace && !editing() ? undefined : ""}
          aria-label={T("sidebar.renameBand", { title: b().title })}
          title={T("sidebar.rename")}
          onClick={() => props.onRenameWorkspace?.(props.row.gws)}
        >
          <Nf c={ICON.pencil} />
        </button>
        <button
          type="button"
          class="band-btn band-close"
          data-off={props.onClose ? undefined : ""}
          aria-label={T("sidebar.closeBand", { title: b().title })}
          title={T("sidebar.closeWorkspace")}
          onClick={() => props.onClose?.(props.row.gws)}
        >
          <Nf c={ICON.close} />
        </button>
      </div>
    </div>
  );
}
