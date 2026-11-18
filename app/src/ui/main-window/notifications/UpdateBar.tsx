// 自動更新の知らせ（C8）。起動したら 1 度だけ新しい版があるかを殻に聞き（`kisui update` でも調べ直す。store.ts）、あれば右下の知らせ（ui/main-window/notifications/Notices.tsx）に積む。
// 入れ替えは「更新して再起動」を押したときだけ行う（編集中に勝手に起動し直さないため）。
// 自動更新は AppImage と .dmg の版だけが持つ。Nix で作る版では殻がいつも「無い」と答えるので、何も出ない。
import { T } from "../../../i18n/index.ts";
import { onMount, Show, type JSX } from "solid-js";

import "../../components/card.css";
import { IS_MAC } from "../../../features/commands/guiKeys.ts";
import { leaderKeyName } from "../../../features/commands/commands.ts";
import type { Updates } from "../../../features/updates/store.ts";
import { Button } from "../../components/Button.tsx";
import {
  CardBody,
  CardTitle,
  CardText,
  CardError,
  CardActions,
} from "../../components/Card.tsx";

export function UpdateBar(props: { updates: Updates }): JSX.Element {
  const u = props.updates;
  onMount(() => u.checkOnStart());

  return (
    <Show when={u.info()}>
      {(info) => (
        <aside
          class="card card-notice"
          role="status"
          aria-label={T("update.label")}
        >
          <CardBody>
            <CardTitle level={2}>
              {T("update.title", { version: info().version })}
            </CardTitle>
            <CardText>
              {T("update.text", {
                current: info().current,
                leader: leaderKeyName(IS_MAC),
              })}
            </CardText>
            <Show when={u.error()}>
              <CardError role="alert">{u.error()}</CardError>
            </Show>
          </CardBody>
          <CardActions>
            <Button disabled={u.busy()} onClick={() => u.dismiss()}>
              {T("update.later")}
            </Button>
            <Button
              variant="primary"
              busy={u.busy()}
              onClick={() => void u.install()}
            >
              {u.busy() ? T("update.busy") : T("update.install")}
            </Button>
          </CardActions>
        </aside>
      )}
    </Show>
  );
}
