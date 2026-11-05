// 左の一覧（D1）：つないだマシンごとに見出しとワークスペースの帯を出す。帯を押すとフォーカスを移す。
// フォーカスしているワークスペースの帯の下にはツリーを出す（D2、描くのは tree/TreeView.tsx）。
// スクロールしても、上にフォーカスしているマシンの見出し → 帯 → 親フォルダを、下にそれより後ろの帯を固定する（D3）。
// マシンごとの色（D4）は section の --machine-color に入れ、見出しと帯の左端の線とアイコンに使う。
// 見出しには接続の状態（丸と、その下の短い 1 行。言葉は connect/status.ts）と、今すぐつなぐ・つなぎ直す・切るボタンを出す（切るボタンはローカルには出さない。ローカルは切る理由が無い）。
// つながっているマシンの見出しの右には [+] を置き、押すと onCreate を呼ぶ（フォルダ未定のワークスペースができる）。
// 帯の右の [×] は、押すと onClose を呼ぶ（ワークスペースを閉じる。確認は App が窓で出す）。
// 一覧の一番下には「+ リモートを足す」を置き、押すと onAddMachine を呼ぶ（窓は connect/AddMachine.tsx）。
// 足したマシンの見出しを右クリックすると「名前を変える」「外す」のメニューを出す（onRename・onRemove）。
// 組み立ては model.ts、色の決め方は colors.ts、見た目は sidebar.css。
import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";

import type { MachineStatus } from "../connect/status.ts";
import type { WorkspaceId } from "../rpc/protocol.ts";
import type { TreeRow } from "../tree/model.ts";
import { TreeView } from "../tree/TreeView.tsx";
import {
  splitAtFocus,
  type Band,
  type Health,
  type MachineGroup,
} from "./model.ts";
import "./sidebar.css";

const healthLabel: Record<Health, string> = {
  up: "つながっています",
  pending: "つないでいます",
  down: "つながっていません",
};

interface Handlers {
  onFocus: (target: string, id: WorkspaceId) => void;
  /** ツリーの行。まだ取っていなければ undefined */
  treeOf?: (target: string, id: WorkspaceId) => TreeRow[] | undefined;
  onToggle?: (target: string, id: WorkspaceId, path: string) => void;
  /** 見出しの下の 1 行とボタン。省くと出さない */
  statusOf?: (target: string) => MachineStatus;
  /** 見出しのそばの「今すぐつなぐ」「つなぎ直す」 */
  onRetry?: (target: string) => void;
  /** 見出しのそばの「切る」 */
  onDisconnect?: (target: string) => void;
  /** 見出しの [+]（ワークスペースを作る）。省くと出さない */
  onCreate?: (target: string) => void;
  /** 帯の [×]（ワークスペースを閉じる）。省くと出さない */
  onClose?: (target: string, id: WorkspaceId) => void;
  /** ツリーのファイルの行を押した */
  onOpen?: (target: string, id: WorkspaceId, path: string) => void;
  /** ファイルの欄で開いているファイル（ツリーで強調する行の path）。無ければ undefined */
  currentOf?: (target: string, id: WorkspaceId) => string | undefined;
}

/**
 * 左の一覧。つないだマシンごとに見出しとワークスペースの帯を出し、帯を押すと onFocus を呼ぶ。
 * フォーカスしている帯の下に treeOf のツリーを出し、フォルダを押すと onToggle、ファイルを押すと onOpen を呼ぶ。
 *
 * 上下の固定（D3）は CSS の sticky で、要素の組み方で止まるところを決める:
 * フォーカスしているマシンの見出しはそのマシンの要素（帯はフォーカスしている帯まで）の中で、
 * 帯はツリーと一緒の要素の中で、フォルダの行は中身と一緒の要素の中で止まる。
 * それより後ろの帯とマシンは 1 つの要素にまとめ、一覧の下に固定する。
 */
export function Sidebar(
  props: Handlers & {
    groups: MachineGroup[];
    /** 一覧の要素（スクロールの位置を覚えて戻すのに使う） */
    ref?: (el: HTMLElement) => void;
    /** 一番下の「+ リモートを足す」 */
    onAddMachine?: () => void;
    /** 見出しのメニューの「名前を変える」 */
    onRename?: (target: string) => void;
    /** 見出しのメニューの「外す」 */
    onRemove?: (target: string) => void;
  },
): JSX.Element {
  // 見出しの右クリックのメニュー（足したマシンだけ）。出している間は、押す・Esc・スクロール・窓の切り替えで閉じる
  const [menu, setMenu] = createSignal<{
    target: string;
    fixed: boolean;
    x: number;
    y: number;
  } | null>(null);
  const split = createMemo(() => splitAtFocus(props.groups));
  const hasAfter = () =>
    split().after.rest.length > 0 || split().after.groups.length > 0;
  let nav!: HTMLElement;
  const openMenu = (target: string, x: number, y: number, fixed: boolean) =>
    setMenu({ target, fixed, x, y });

  // 固定されているものに data-stuck を付ける（背景と影をモックに合わせる）。
  // 上に固定するものは、sticky の位置（一覧の上端から top）にいて、親の要素の上端より下にずれていれば
  // 固定されている（中身を通り過ぎて押し出された行は sticky の位置より上にいるので外れる）。
  // 下の要素は、一覧の終わりまでスクロールしていなければ固定されている。
  // 影（data-shadow）は、上に固定されたものの一番下と、下の要素に付ける
  onMount(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      let last: HTMLElement | null = null;
      for (const el of nav.querySelectorAll<HTMLElement>("[data-sticky]")) {
        const bottom = el.dataset.sticky === "bottom";
        let stuck: boolean;
        if (bottom) {
          stuck = nav.scrollTop + nav.clientHeight < nav.scrollHeight - 0.5;
        } else {
          const parent = el.parentElement;
          const top = el.getBoundingClientRect().top;
          const at =
            nav.getBoundingClientRect().top +
            nav.clientTop +
            (parseFloat(getComputedStyle(el).top) || 0);
          stuck =
            parent !== null &&
            Math.abs(top - at) < 0.5 &&
            top > parent.getBoundingClientRect().top + 0.5;
          if (stuck) last = el;
        }
        el.toggleAttribute("data-stuck", stuck);
        el.toggleAttribute("data-shadow", bottom && stuck);
      }
      last?.setAttribute("data-shadow", "");
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    nav.addEventListener("scroll", schedule, { passive: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(nav);
    // 行が増減した・フォーカスが移った（属性は見ないので、data-stuck を付けても回らない）
    const mutation = new MutationObserver(schedule);
    mutation.observe(nav, { childList: true, subtree: true });
    schedule();
    onCleanup(() => {
      nav.removeEventListener("scroll", schedule);
      resize.disconnect();
      mutation.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    });
  });

  return (
    <div class="sidebar-column">
      <nav
        class="sidebar"
        aria-label="マシンとワークスペース"
        ref={(el) => {
          nav = el;
          props.ref?.(el);
        }}
      >
        <For each={split().before}>
          {(g) => <Machine group={g} onMenu={openMenu} {...handlers(props)} />}
        </For>
        <Show when={split().focused}>
          {(g) => (
            <Machine
              group={g()}
              sticky
              onMenu={openMenu}
              {...handlers(props)}
            />
          )}
        </Show>
        <Show when={hasAfter()}>
          <div class="sidebar-after" data-sticky="bottom">
            <Show when={split().after.rest.length > 0}>
              {/* 見出しの無いマシンの要素にして、マシンの色（--machine-color）を同じにする */}
              <section
                class="machine machine-rest"
                style={{ "--machine-color": split().after.color }}
                data-target={split().after.target}
                aria-label={split().after.label}
              >
                <ul class="bands">
                  <For each={split().after.rest}>
                    {(b) => (
                      <BandItem
                        target={split().after.target}
                        band={b}
                        {...handlers(props)}
                      />
                    )}
                  </For>
                </ul>
              </section>
            </Show>
            <For each={split().after.groups}>
              {(g) => (
                <Machine group={g} onMenu={openMenu} {...handlers(props)} />
              )}
            </For>
          </div>
        </Show>
      </nav>
      <Show when={menu()}>
        {(m) => (
          <MachineMenu
            x={m().x}
            y={m().y}
            fixed={m().fixed}
            onRename={() => props.onRename?.(m().target)}
            onRemove={() => props.onRemove?.(m().target)}
            onClose={() => setMenu(null)}
          />
        )}
      </Show>
      <div class="sidebar-foot">
        <button
          type="button"
          class="add-machine"
          onClick={() => props.onAddMachine?.()}
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
          リモートを足す
        </button>
      </div>
    </div>
  );
}

/** 子に渡す処理だけを取り出す（getter にして、props の追跡を保つ）。 */
function handlers(props: Handlers): Handlers {
  return {
    get onFocus() {
      return props.onFocus;
    },
    get treeOf() {
      return props.treeOf;
    },
    get onToggle() {
      return props.onToggle;
    },
    get statusOf() {
      return props.statusOf;
    },
    get onRetry() {
      return props.onRetry;
    },
    get onDisconnect() {
      return props.onDisconnect;
    },
    get onCreate() {
      return props.onCreate;
    },
    get onClose() {
      return props.onClose;
    },
    get onOpen() {
      return props.onOpen;
    },
    get currentOf() {
      return props.currentOf;
    },
  };
}

/** マシン 1 台分。sticky なら見出しを上に固定する（フォーカスしているマシン）。 */
function Machine(
  props: Handlers & {
    group: MachineGroup;
    sticky?: boolean;
    /** 見出しを右クリックした（足したマシンだけ） */
    onMenu?: (target: string, x: number, y: number, fixed: boolean) => void;
  },
): JSX.Element {
  const g = () => props.group;
  const status = () => props.statusOf?.(g().target);
  return (
    <section
      class="machine"
      style={{ "--machine-color": g().color }}
      data-target={g().target}
      aria-label={g().label}
    >
      {/* 見出しの行。見出し（h2）の名前がマシンの名前だけになるよう、ボタンと丸は h2 の外に置く */}
      <div
        class="machine-heading"
        data-sticky={props.sticky ? "top" : undefined}
        onContextMenu={(e) => {
          if (!g().removable || !props.onMenu) return;
          e.preventDefault();
          props.onMenu(g().target, e.clientX, e.clientY, g().fixed);
        }}
      >
        <h2 class="machine-name" title={status()?.title || undefined}>
          {g().label}
        </h2>
        <Show when={status()?.retry}>
          {(r) => {
            const label = () =>
              r() === "now"
                ? `${g().label} に今すぐつなぐ`
                : `${g().label} につなぎ直す`;
            return (
              <button
                type="button"
                class="machine-action"
                aria-label={label()}
                title={label()}
                onClick={() => props.onRetry?.(g().target)}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path d="M20 12a8 8 0 1 1-2.34-5.66" />
                  <path d="M20 4v5h-5" />
                </svg>
              </button>
            );
          }}
        </Show>
        <Show when={props.onCreate && g().health === "up"}>
          <button
            type="button"
            class="machine-action"
            aria-label={`${g().label} にワークスペースを作る`}
            title={`${g().label} にワークスペースを作る`}
            onClick={() => props.onCreate?.(g().target)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </Show>
        <Show when={props.onDisconnect && g().removable}>
          <button
            type="button"
            class="machine-action"
            aria-label={`${g().label} を切る`}
            title={`${g().label} を切る`}
            onClick={() => props.onDisconnect?.(g().target)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </Show>
        <span
          class="health"
          data-health={g().health}
          role="img"
          aria-label={healthLabel[g().health]}
          title={healthLabel[g().health]}
        />
      </div>
      <Show when={status()?.text}>
        {(t) => (
          <p class="machine-status" title={status()?.title || undefined}>
            {/* 読み上げは状態が変わったときだけにし、毎秒動く残り秒数は live region の外に出す */}
            <span role="status">{t()}</span>
            <Show when={status()?.countdown}>
              {(c) => <span aria-hidden="true">・{c()}</span>}
            </Show>
          </p>
        )}
      </Show>
      <Show
        when={g().bands.length > 0}
        fallback={<p class="no-workspace">ワークスペースはありません</p>}
      >
        <ul class="bands">
          <For each={g().bands}>
            {(b) => (
              <BandItem target={g().target} band={b} {...handlers(props)} />
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}

/** 帯 1 つ。フォーカスしていれば帯を上に固定し、下にツリーを出す。 */
function BandItem(
  props: Handlers & { target: string; band: Band },
): JSX.Element {
  const b = () => props.band;
  return (
    <li>
      {/* 帯は行にして、中の 2 つのボタン（フォーカスを移す・閉じる）を並べる（ボタンの中にボタンは置けない） */}
      <div
        class="band"
        aria-current={b().focused ? "true" : undefined}
        data-sticky={b().focused ? "top" : undefined}
        title={b().root || undefined}
      >
        <button
          type="button"
          class="band-main"
          onClick={() => props.onFocus(props.target, b().id)}
        >
          <svg
            class="band-icon"
            width="16"
            height="16"
            viewBox="0 0 16 16"
            aria-hidden="true"
          >
            <path d="M8 2l6 3-6 3-6-3z" />
            <path d="M2 8l6 3 6-3" />
            <path d="M2 11l6 3 6-3" />
          </svg>
          <span
            class="band-title"
            classList={{ path: b().path, unset: b().unset }}
          >
            {b().title}
          </span>
          <Show when={b().detail}>
            <span class="band-detail">{b().detail}</span>
          </Show>
        </button>
        <Show when={props.onClose}>
          <button
            type="button"
            class="band-close"
            aria-label={`${b().title} を閉じる`}
            title="ワークスペースを閉じる"
            onClick={() => props.onClose?.(props.target, b().id)}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </Show>
      </div>
      <Show when={b().focused && props.treeOf?.(props.target, b().id)}>
        {(rows) => (
          <TreeView
            rows={rows()}
            label={`${b().title} のファイル`}
            onToggle={(p) => props.onToggle?.(props.target, b().id, p)}
            onOpen={(p) => props.onOpen?.(props.target, b().id, p)}
            current={props.currentOf?.(props.target, b().id)}
          />
        )}
      </Show>
    </li>
  );
}

/**
 * 見出しの右クリックのメニュー。開いたら最初の項目にキーを向ける。
 * 項目を選ぶ・メニューの外を押す・Esc・スクロール・窓が見えなくなる、のどれかで閉じる。
 */
function MachineMenu(props: {
  x: number;
  y: number;
  /** 設定ファイルで決めたマシン（項目は押せず、理由を出す） */
  fixed: boolean;
  onRename: () => void;
  onRemove: () => void;
  onClose: () => void;
}): JSX.Element {
  let el!: HTMLDivElement;
  onMount(() => {
    const close = () => props.onClose();
    const down = (e: Event) => {
      if (!el.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = [
          ...el.querySelectorAll<HTMLElement>("[role=menuitem]:not(:disabled)"),
        ];
        const i = items.indexOf(document.activeElement as HTMLElement);
        const step = e.key === "ArrowDown" ? 1 : -1;
        items[(i + step + items.length) % items.length]?.focus();
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("contextmenu", down, true);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    // 画面の端ではみ出す分だけ、左・上にずらす
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(0, Math.min(props.x, window.innerWidth - r.width))}px`;
    el.style.top = `${Math.max(0, Math.min(props.y, window.innerHeight - r.height))}px`;
    el.querySelector<HTMLElement>("[role=menuitem]:not(:disabled)")?.focus();
    onCleanup(() => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("contextmenu", down, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    });
  });
  const choose = (run: () => void) => () => {
    props.onClose();
    run();
  };
  return (
    <div
      class="machine-menu"
      role="menu"
      aria-label="マシン"
      ref={el}
      style={{ left: `${props.x}px`, top: `${props.y}px` }}
    >
      <button
        type="button"
        role="menuitem"
        class="machine-menu-item"
        disabled={props.fixed}
        onClick={choose(props.onRename)}
      >
        名前を変える
      </button>
      <button
        type="button"
        role="menuitem"
        class="machine-menu-item"
        disabled={props.fixed}
        onClick={choose(props.onRemove)}
      >
        外す
      </button>
      <Show when={props.fixed}>
        <p class="machine-menu-note">
          設定ファイル（config.toml の
          [[gui.machines]]）で決めたマシンです。変えるには設定ファイルを直してください。
        </p>
      </Show>
    </div>
  );
}
