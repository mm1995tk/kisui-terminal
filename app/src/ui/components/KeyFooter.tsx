// Dialog の Key footer（共通フッタ）。ModalCard の footer に渡す。上から、理由などの知らせ（あれば）・今効く操作の行。
// 行（rows）は、何に効くかでまとめた今効く操作（作るのは features/commands/placeKeys.ts の placeItem を使う各 Dialog）。行の頭に見出しを置き、操作は右に流す。
// 効かない操作と、どの Dialog でも同じ意味のキー（Enter・Esc・h j k l・`?`）は、渡す側が入れない。操作が無い行も見出しは出す（Key footer は出たり消えたりしない）。
// 状態で行の数が変わる Dialog は、lines に一番多いときの行の数を渡す。そのときは操作の無い行を出さず（関係ないものは見せない）、
// lines 行ぶんの高さを空けておく（行の数が変わるたびに Key footer の高さが変わり、上の中身が伸び縮みしないように）。
// まだ行の形にしていない Dialog（クリップボードの履歴・DB の履歴・DB の権限を強める Dialog）は、基本操作の並び（items。placeKeys.ts の basicHints）を渡す。
// 決まりは docs/design/design-system.md の「共通フッタ」と docs/design/ui-ux-review.md の「ヒントとヘルプ」。
import { For, Show, type JSX } from "solid-js";

import { CardBody } from "./Card.tsx";
import { KeyHints, type KeyHint } from "./KeyHints.tsx";
import "./key-footer.css";

/** Key footer の 1 行（features/commands/placeKeys.ts の FooterRow と同じ形。部品は機能の知識を持たないので、形だけを書く）。 */
export interface FooterRow<A extends string = never> {
  /** 何に効くか（説明の文） */
  title: string;
  /** 今効く操作。act のある項目は押せるボタンにする */
  items: readonly { keys: string[]; label: string; act?: A }[];
}

/** Dialog の Key footer の中身。rows か items のどちらかを渡す。 */
export function KeyFooter<A extends string = never>(props: {
  /** 今効く操作の行（何に効くかの見出し付き） */
  rows?: readonly FooterRow<A>[];
  /** 押せるボタンにする項目（act の付いた項目）を押した */
  onPress?: (act: A) => void;
  /** 基本操作のヒント（まだ行の形にしていない Dialog） */
  items?: KeyHint[];
  /** ヒントの上に出す知らせ（できなかった理由など。ふつうは role を付けた CardText） */
  note?: JSX.Element;
  /** 空けておく行の数（一番多いときの行の数）。渡すと、操作の無い行は出さず、この行の数ぶんの高さを保つ */
  lines?: number;
}): JSX.Element {
  const hints = (r: FooterRow<A>): KeyHint[] =>
    r.items.map((i) => {
      const act = i.act;
      return {
        keys: i.keys,
        label: i.label,
        ...(act !== undefined && props.onPress
          ? { onPress: () => props.onPress?.(act) }
          : {}),
      };
    });
  return (
    <CardBody
      class="key-footer"
      style={
        props.lines === undefined
          ? undefined
          : { "--key-footer-lines": String(props.lines) }
      }
    >
      {props.note}
      <Show when={props.rows} fallback={<KeyHints items={props.items ?? []} />}>
        {(rows) => (
          <div class="key-footer-rows">
            <For
              each={
                props.lines === undefined
                  ? rows()
                  : rows().filter((r) => r.items.length > 0)
              }
            >
              {(r) => (
                <div class="key-footer-row">
                  <span class="key-footer-title">{r.title}</span>
                  <KeyHints items={hints(r)} />
                </div>
              )}
            </For>
          </div>
        )}
      </Show>
    </CardBody>
  );
}
