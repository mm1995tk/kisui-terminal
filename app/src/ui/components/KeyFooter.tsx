// 窓の下の段（共通フッタ）。ModalCard の footer に渡す。上から、理由などの知らせ（あれば）・今効く操作のキーのヒント。
// 見本（詰め中の要望「窓の操作を ? の一覧に隠さず、見てわかるように出す」）：
// どの窓でも同じキー（Enter・Esc・h j k l）は出さず、その窓だけの操作のうち、今効くものだけを出す。
// 操作は「何に効くか」でまとめ（groups）、まとまりごとに 1 行にする（行の頭に、何に効くかの見出し）。
import { For, Show, type JSX } from "solid-js";

import { CardBody } from "./Card.tsx";
import { KeyHints, type KeyHint } from "./KeyHints.tsx";
import "./key-footer.css";

/** 操作 1 つ。off なら今は効かない（下の段には出さない） */
export interface ActionItem extends KeyHint {
  off?: boolean;
}

/** 操作のまとまり。title は何に効くか（「選んでいる結果のタブ」など） */
export interface ActionGroup {
  title?: string;
  items: ActionItem[];
}

/** 窓の下の段の中身。 */
export function KeyFooter(props: {
  /** 基本操作のヒント（今効くキーだけ）。groups があれば使わない */
  items?: KeyHint[];
  /** 今できる操作のまとまり。効かない操作は出さない。操作が無いまとまりは見出しだけを出す（下の段は出たり消えたりしない） */
  groups?: ActionGroup[];
  /** ヒントの上に出す知らせ（できなかった理由など。ふつうは role を付けた CardText） */
  note?: JSX.Element;
}): JSX.Element {
  const groups = () =>
    (props.groups ?? [])
      .map((g) => ({ ...g, items: g.items.filter((a) => !a.off) }))
      .filter((g) => g.items.length > 0 || g.title);
  return (
    <CardBody>
      {props.note}
      <Show
        when={props.groups}
        fallback={<KeyHints items={props.items ?? []} />}
      >
        <div class="key-footer-groups">
          <For each={groups()}>
            {(g) => (
              <div class="key-footer-group">
                <Show when={g.title}>
                  {(t) => <span class="key-footer-title">{t()}</span>}
                </Show>
                <KeyHints items={g.items} />
              </div>
            )}
          </For>
        </div>
      </Show>
    </CardBody>
  );
}
