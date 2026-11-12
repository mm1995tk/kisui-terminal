// ツリーの行を右クリックしたときのメニュー。見た目は見出しのメニュー（sidebar.css の .machine-menu）と同じ。
// 開いたら最初の項目にキーを向ける。項目を選ぶ・メニューの外を押す・Esc・スクロール・窓が見えなくなる、のどれかで閉じる。
import { For, onCleanup, onMount, type JSX } from "solid-js";

import { treeMenuLabels, type TreeMenuAction } from "./menu.ts";

export function TreeMenu(props: {
  x: number;
  y: number;
  items: TreeMenuAction[];
  /** 行の名前（読み上げ用） */
  label: string;
  onChoose: (action: TreeMenuAction) => void;
  onClose: () => void;
}): JSX.Element {
  let el!: HTMLDivElement;
  onMount(() => {
    // キー（. か Menu キー）で開いたとき、閉じたらその行にキーを戻す（ほかにフォーカスが移っていなければ）
    const opener = document.activeElement as HTMLElement | null;
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
      setTimeout(() => {
        if (
          opener?.isConnected &&
          opener.matches(".tree-row") &&
          (document.activeElement === document.body ||
            document.activeElement === null)
        )
          opener.focus({ preventScroll: true });
      }, 0);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("contextmenu", down, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    });
  });
  return (
    <div
      class="machine-menu"
      role="menu"
      aria-label={props.label}
      ref={el}
      style={{ left: `${props.x}px`, top: `${props.y}px` }}
    >
      <For each={props.items}>
        {(a) => (
          <button
            type="button"
            role="menuitem"
            class="machine-menu-item"
            onClick={() => {
              // 親の <Show> の値は onClose で消えるので、選んだものを先に渡す
              props.onChoose(a);
              props.onClose();
            }}
          >
            {treeMenuLabels[a]}
          </button>
        )}
      </For>
    </div>
  );
}
