// ツリーの右クリックから開く窓：名前を入れる窓（新しいファイル・新しいフォルダ・名前の変更）と、削除の確認の窓。
// 窓は ModalCard（connect/Card.tsx）。決めたあとの処理は onSubmit / onYes が返す Promise で、断られたら窓を開いたまま理由を出す。
import { createSignal, Show, type JSX } from "solid-js";

import { ModalCard } from "../connect/Card.tsx";

/** 窓に出す理由（Error の message か文字列）。 */
function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 名前（ルートからの相対パス）を入れる窓。Enter か「決める」で onSubmit。成功したら呼んだ側が窓を閉じる。 */
export function NameDialog(props: {
  title: string;
  /** 入力欄の見出し */
  field: string;
  initial: string;
  submit: string;
  /** 欄の最後の "/" より後ろだけを選んでおく（名前の変更で拡張子ごと打ち直せるように） */
  selectName?: boolean;
  onSubmit: (value: string) => Promise<void>;
  onCancel: () => void;
}): JSX.Element {
  const [value, setValue] = createSignal(props.initial);
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const submit = async () => {
    if (busy()) return;
    setBusy(true);
    setError(undefined);
    try {
      await props.onSubmit(value());
    } catch (e) {
      setError(reason(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModalCard label={props.title} onCancel={props.onCancel}>
      <div class="card-body">
        <h1 class="card-title">{props.title}</h1>
        <label class="card-field">
          {props.field}
          <input
            class="card-input"
            type="text"
            value={value()}
            onInput={(e) => setValue(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.isComposing) return;
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
            ref={(el) =>
              queueMicrotask(() => {
                el.focus();
                if (props.selectName) {
                  el.setSelectionRange(
                    el.value.lastIndexOf("/") + 1,
                    el.value.length,
                  );
                } else {
                  el.setSelectionRange(el.value.length, el.value.length);
                }
              })
            }
            autofocus
          />
        </label>
        <Show when={error()}>
          {(e) => (
            <pre class="card-error" role="alert">
              {e()}
            </pre>
          )}
        </Show>
      </div>
      <div class="card-actions">
        <button type="button" class="card-button" onClick={props.onCancel}>
          キャンセル
        </button>
        <button
          type="button"
          class="card-button primary"
          disabled={busy()}
          onClick={() => void submit()}
        >
          {props.submit}
        </button>
      </div>
    </ModalCard>
  );
}

/** 削除の確認の窓（TUI の y で削除と同じ）。誤って打っていた Enter が押さないよう、フォーカスは窓そのものに置く。 */
export function DeleteDialog(props: {
  /** ルートからの相対パス */
  path: string;
  dir: boolean;
  onYes: () => Promise<void>;
  onCancel: () => void;
}): JSX.Element {
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const yes = async () => {
    if (busy()) return;
    setBusy(true);
    setError(undefined);
    try {
      await props.onYes();
    } catch (e) {
      setError(reason(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModalCard label="削除の確認" onCancel={props.onCancel} focusSelf>
      <div class="card-body">
        <h1 class="card-title">{props.path} を削除しますか？</h1>
        <p class="card-text">
          {props.dir
            ? "フォルダの中身も全部消えます。元には戻せません。"
            : "元には戻せません。"}
        </p>
        <Show when={error()}>
          {(e) => (
            <pre class="card-error" role="alert">
              {e()}
            </pre>
          )}
        </Show>
      </div>
      <div class="card-actions">
        <button type="button" class="card-button" onClick={props.onCancel}>
          やめる
        </button>
        <button
          type="button"
          class="card-button primary"
          disabled={busy()}
          onClick={() => void yes()}
        >
          削除する
        </button>
      </div>
    </ModalCard>
  );
}
