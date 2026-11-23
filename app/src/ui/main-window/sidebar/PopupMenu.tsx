// サイドバーの右クリックのメニュー（ワークスペースの帯・「+」のメニュー）。
import { isComposingKey } from "../../../features/commands/ime.ts";
import { For, onCleanup, onMount, Show, type JSX } from "solid-js";

/**
 * 右クリックのメニュー（マシンの見出し・ワークスペースの帯）。開いたら最初の項目にキーを向ける。
 * 項目を選ぶ・メニューの外を押す・Esc・スクロール・窓が見えなくなる、のどれかで閉じる。
 * note があれば、項目の下に理由などを出す。
 */
export function PopupMenu(props: {
  x: number;
  y: number;
  /** メニューの名前（読み上げ用） */
  label: string;
  items: { label: string; run: () => void; disabled?: boolean }[];
  note?: string;
  onClose: () => void;
}): JSX.Element {
  let el!: HTMLDivElement;
  onMount(() => {
    const close = () => props.onClose();
    const down = (e: Event) => {
      if (!el.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => {
      if (isComposingKey(e)) return;
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
    run();
    props.onClose();
  };
  return (
    <div
      class="machine-menu"
      role="menu"
      data-overlay=""
      aria-label={props.label}
      ref={el}
      style={{ left: `${props.x}px`, top: `${props.y}px` }}
    >
      <For each={props.items}>
        {(it) => (
          <button
            type="button"
            role="menuitem"
            class="machine-menu-item"
            disabled={it.disabled}
            onClick={choose(it.run)}
          >
            {it.label}
          </button>
        )}
      </For>
      <Show when={props.note}>
        {(n) => <p class="machine-menu-note">{n()}</p>}
      </Show>
    </div>
  );
}
