// 窓の下の段（共通フッタ）。ModalCard の footer に渡す。上から、理由などの知らせ（あれば）・基本操作のキーのヒント。
// 出すのは基本操作（選ぶ・移る・決める・`?`・やめる／閉じる）だけで、詳しい操作は `?` の一覧に出す。
// やめる・閉じるだけのボタンは置かない（Esc で閉じる窓の閉じ方は、ヒントの `Esc` で案内する）。
// 何をどの順に出すかは呼ぶ側が渡す（features/commands/placeKeys.ts の basicHints が順と字をそろえる）。決まりは docs/design/design-system.md の「共通フッタ」。
import { type JSX } from "solid-js";

import { CardBody } from "./Card.tsx";
import { KeyHints, type KeyHint } from "./KeyHints.tsx";

/** 窓の下の段の中身。 */
export function KeyFooter(props: {
  /** 基本操作のヒント（今効くキーだけ） */
  items: KeyHint[];
  /** ヒントの上に出す知らせ（できなかった理由など。ふつうは role を付けた CardText） */
  note?: JSX.Element;
}): JSX.Element {
  return (
    <CardBody>
      {props.note}
      <KeyHints items={props.items} />
    </CardBody>
  );
}
