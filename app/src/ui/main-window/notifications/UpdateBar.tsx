// 自動更新の知らせ（C8）。起動したら 1 度だけ新しい版があるかを殻に聞き（`kisui update` でも調べ直す。store.ts）、あれば右下の知らせ（connect/Notices.tsx）に積む。
// 入れ替えは「更新して再起動」を押したときだけ行う（編集中に勝手に起動し直さないため）。
// 自動更新は AppImage と .dmg の版だけが持つ。Nix で作る版では殻がいつも「無い」と答えるので、何も出ない。
import { T } from "../../../i18n/index.ts";
import { onMount, Show, type JSX } from "solid-js";

import "../../components/card.css";
import { IS_MAC } from "../../../features/commands/guiKeys.ts";
import { leaderKeyName } from "../../../features/commands/commands.ts";
import {
  checkOnStart,
  dismissUpdate,
  installUpdate,
  updateBusy,
  updateError,
  updateInfo,
} from "../../../features/updates/store.ts";

export function UpdateBar(): JSX.Element {
  onMount(checkOnStart);

  return (
    <Show when={updateInfo()}>
      {(u) => (
        <aside
          class="card card-notice"
          role="status"
          aria-label={T("update.label")}
        >
          <div class="card-body">
            <h2 class="card-title">
              {T("update.title", { version: u().version })}
            </h2>
            <p class="card-text">
              {T("update.text", {
                current: u().current,
                leader: leaderKeyName(IS_MAC),
              })}
            </p>
            <Show when={updateError()}>
              <pre class="card-error" role="alert">
                {updateError()}
              </pre>
            </Show>
          </div>
          <div class="card-actions">
            <button
              type="button"
              class="card-button"
              disabled={updateBusy()}
              onClick={dismissUpdate}
            >
              {T("update.later")}
            </button>
            <button
              type="button"
              class="card-button primary"
              disabled={updateBusy()}
              onClick={() => void installUpdate()}
            >
              {updateBusy() ? T("update.busy") : T("update.install")}
            </button>
          </div>
        </aside>
      )}
    </Show>
  );
}
