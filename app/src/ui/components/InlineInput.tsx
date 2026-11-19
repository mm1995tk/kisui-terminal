// その場の入力欄。一覧の行の名前を、窓を出さずにその行の中で入力欄にして変える（ワークスペース・タブ・マシンの名前、ファイルツリーの名前）。
// Enter で onSubmit、Esc で onCancel(true)、フォーカスが外れたら onCancel(false)。断られたら、呼んだ側が error を渡し、入力欄は開けたままにする。
// キーは入力欄の外に伝えない（一覧のキー j・k などが、打った字で動かないように）。リーダーのキーは window で先に受けるので、そのまま効く。
import { Show, type JSX } from "solid-js";

import { inlineKeyAction } from "./inlineInputKeys.ts";
import "./inline-input.css";

/**
 * その場の入力欄 1 つと、断られた理由。開くと 1 拍置いてフォーカスを取り、selection の範囲（省けば全部）を選ぶ。
 * 値は開いたときの value から始まり、打った字は入力欄の中だけに持つ（決めたときに onSubmit に渡す）。
 */
export function InlineInput(props: {
  /** 入力欄の初めの値 */
  value: string;
  /** 読み上げの名前 */
  label: string;
  /** 空のときに出す字（空にして決めたときに戻る名前など） */
  placeholder?: string;
  /** 断られた理由。あれば入力欄の下に出す */
  error?: string;
  /** 理由を別の所に出すとき、縁だけを断られた色にする */
  invalid?: boolean;
  /** 開いたときに選んでおく範囲を返す。省くと全部を選ぶ */
  selection?: (value: string) => [number, number];
  onSubmit: (value: string) => void;
  /** byKey は Esc で閉じたとき（キーを元の所へ戻すかを、呼んだ側が決める） */
  onCancel: (byKey: boolean) => void;
}): JSX.Element {
  return (
    <div class="inline-edit">
      <input
        class="inline-input"
        type="text"
        aria-label={props.label}
        aria-invalid={props.error || props.invalid ? "true" : undefined}
        placeholder={props.placeholder}
        value={props.value}
        onClick={(e) => e.stopPropagation()}
        onDblClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          const a = inlineKeyAction(e);
          if (!a) return;
          e.preventDefault();
          if (a === "submit") props.onSubmit(e.currentTarget.value);
          else props.onCancel(true);
        }}
        onBlur={() => {
          // ほかのアプリに切り替えただけ（窓が外れた）では、打ちかけの名前を消さない
          if (document.hasFocus()) props.onCancel(false);
        }}
        ref={(el) =>
          // リーダーの後でターミナルにフォーカスが戻るのと競らないよう、1 拍置いて取る
          setTimeout(() => {
            el.focus();
            const [from, to] = props.selection?.(el.value) ?? [
              0,
              el.value.length,
            ];
            el.setSelectionRange(from, to);
          })
        }
      />
      <Show when={props.error}>
        {(e) => (
          <span class="inline-error" role="alert">
            {e()}
          </span>
        )}
      </Show>
    </div>
  );
}
