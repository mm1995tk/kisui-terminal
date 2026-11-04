// 右下に積む知らせのカード。後ろの画面は触れたまま、閉じるまで残す。
// つながらない（failed）・別の GUI に移った（C7）・ワークスペースに移れなかった、と、
// 新しい版の知らせ（C8。update/UpdateBar.tsx。children で受ける）。
import { For, Show, type JSX } from "solid-js";

import "./card.css";

/** 知らせ 1 つ。 */
export interface Notice {
  title: string;
  text?: string;
  /** 等幅で出す長いエラー */
  error?: string;
  /** 主ボタン（右端） */
  primary?: { label: string; run: () => void };
  /** ほかのボタン（主ボタンの左） */
  secondary?: { label: string; run: () => void }[];
}

/**
 * notices を右下に上から積み、その下に children（新しい版の知らせ）を置く。
 * 知らせは閉じるまで残り、後ろの画面は触れたまま。同じ Notice のオブジェクトは描き直さないので、
 * 渡す側は、中身が変わらない知らせには同じオブジェクトを渡す（読み上げ直しとフォーカスの喪失を避ける）。
 */
export function Notices(props: {
  notices: Notice[];
  children?: JSX.Element;
}): JSX.Element {
  return (
    <div class="card-notices">
      <For each={props.notices}>
        {(n) => (
          <aside class="card card-notice" role="alert" aria-label={n.title}>
            <div class="card-body">
              <h2 class="card-title">{n.title}</h2>
              <Show when={n.text}>
                <p class="card-text">{n.text}</p>
              </Show>
              <Show when={n.error}>
                <pre class="card-error">{n.error}</pre>
              </Show>
            </div>
            <div class="card-actions">
              <For each={n.secondary ?? []}>
                {(b) => (
                  <button type="button" class="card-button" onClick={b.run}>
                    {b.label}
                  </button>
                )}
              </For>
              <Show when={n.primary}>
                {(b) => (
                  <button
                    type="button"
                    class="card-button primary"
                    onClick={b().run}
                  >
                    {b().label}
                  </button>
                )}
              </Show>
            </div>
          </aside>
        )}
      </For>
      {props.children}
    </div>
  );
}
