// 右下に積む知らせのカード。後ろの画面は触れたまま、閉じるまで残す。
// ただし内蔵ブラウザのページの上では、浮かべるもの（data-overlay。ui/main-window/content/browser/overlay.ts）として重ねる。
// macOS では、閉じるまでページを操作できない（#439）。
// つながらない（failed）・別の GUI に移った（C7）・ワークスペースに移れなかった、と、
// 新しい版の知らせ（C8。ui/main-window/notifications/UpdateBar.tsx。children で受ける）。
import { For, Show, type JSX } from "solid-js";

import "../../components/card.css";
import { Button } from "../../components/Button.tsx";
import {
  CardBody,
  CardTitle,
  CardText,
  CardError,
  CardActions,
} from "../../components/Card.tsx";

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
  /** 閉じる（リーダーの `i d`）。閉じるボタンの動きと同じ */
  dismiss?: () => void;
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
    <div class="card-notices" data-overlay="">
      <For each={props.notices}>
        {(n) => (
          <aside class="card card-notice" role="alert" aria-label={n.title}>
            <CardBody>
              <CardTitle level={2}>{n.title}</CardTitle>
              <Show when={n.text}>
                <CardText>{n.text}</CardText>
              </Show>
              <Show when={n.error}>
                <CardError>{n.error}</CardError>
              </Show>
            </CardBody>
            <CardActions>
              <For each={n.secondary ?? []}>
                {(b) => <Button onClick={b.run}>{b.label}</Button>}
              </For>
              <Show when={n.primary}>
                {(b) => (
                  <Button variant="primary" onClick={b().run}>
                    {b().label}
                  </Button>
                )}
              </Show>
            </CardActions>
          </aside>
        )}
      </For>
      {props.children}
    </div>
  );
}
