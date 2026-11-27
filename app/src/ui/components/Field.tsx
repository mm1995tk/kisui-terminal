// 入力欄（ラベル付き）。Dialog の本文（CardBody）の中に置く。見た目は card.css の .card-field・.card-input。
// 入力に失敗したときの伝え方は未確定（docs/design/design-system.md の「後に回したもの」）なので、今の見た目のまま形だけを部品にした。
// 失敗の理由は、入力欄の下に CardError（Card.tsx）で出す。
import { splitProps, type JSX } from "solid-js";

import "./card.css";

/** ラベルと、その中の入力欄（Input）。ラベルの字を先に、入力欄を children に渡す。 */
export function Field(
  props: JSX.LabelHTMLAttributes<HTMLLabelElement>,
): JSX.Element {
  const [own, rest] = splitProps(props, ["class"]);
  return (
    <label
      {...rest}
      class={own.class ? `card-field ${own.class}` : "card-field"}
    />
  );
}

/** 1 行の入力欄。属性（value・placeholder・onInput・onKeyDown など）はそのまま input に渡す。 */
export function Input(
  props: JSX.InputHTMLAttributes<HTMLInputElement>,
): JSX.Element {
  const [own, rest] = splitProps(props, ["class"]);
  return (
    <input
      {...rest}
      class={own.class ? `card-input ${own.class}` : "card-input"}
    />
  );
}
