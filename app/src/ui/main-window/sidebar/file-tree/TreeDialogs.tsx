// ツリーの右クリックから開く、削除の確認の窓。名前を入れる操作は窓を出さず、ツリーの中のその場の入力欄で行う（TreeView.tsx）。
// 窓は ModalCard（ui/components/Card.tsx）。決めたあとの処理は onYes が返す Promise で、断られたら窓を開いたまま理由を出す。
import { T } from "../../../../i18n/index.ts";
import { createSignal, Show, type JSX } from "solid-js";

import { Button } from "../../../components/Button.tsx";
import {
  ModalCard,
  CardBody,
  CardTitle,
  CardError,
  CardActions,
  CardText,
} from "../../../components/Card.tsx";

/** 窓に出す理由（Error の message か文字列）。 */
function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
    <ModalCard
      label={T("deleteDialog.label")}
      onCancel={props.onCancel}
      focusSelf
      header={
        <CardTitle>{T("deleteDialog.title", { path: props.path })}</CardTitle>
      }
      footer={
        <CardActions>
          <Button onClick={props.onCancel}>{T("button.cancelAlt")}</Button>
          <Button variant="primary" busy={busy()} onClick={() => void yes()}>
            {T("deleteDialog.yes")}
          </Button>
        </CardActions>
      }
    >
      <CardBody>
        <CardText>
          {props.dir ? T("deleteDialog.dir") : T("deleteDialog.file")}
        </CardText>
        <Show when={error()}>
          {(e) => <CardError role="alert">{e()}</CardError>}
        </Show>
      </CardBody>
    </ModalCard>
  );
}
