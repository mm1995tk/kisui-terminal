// 自動更新の知らせ（C8）。起動したら 1 度だけ新しい版があるかを殻に聞き（`kisui update` でも調べ直す。store.ts）、あれば右下の知らせ（connect/Notices.tsx）に積む。
// 入れ替えは「更新して再起動」を押したときだけ行う（編集中に勝手に起動し直さないため）。
// 自動更新は AppImage と .dmg の版だけが持つ。Nix で作る版では殻がいつも「無い」と答えるので、何も出ない。
import { onMount, Show, type JSX } from "solid-js";

import "../connect/card.css";
import {
  checkOnStart,
  dismissUpdate,
  installUpdate,
  updateBusy,
  updateError,
  updateInfo,
} from "./store.ts";

export function UpdateBar(): JSX.Element {
  onMount(checkOnStart);

  return (
    <Show when={updateInfo()}>
      {(u) => (
        <aside class="card card-notice" role="status" aria-label="新しい版">
          <div class="card-body">
            <h2 class="card-title">新しい版 {u().version} があります</h2>
            <p class="card-text">
              今は {u().current}{" "}
              です。更新すると、入れ替えて起動し直します（リーダーの n u
              でも更新できます）。
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
              あとで
            </button>
            <button
              type="button"
              class="card-button primary"
              disabled={updateBusy()}
              onClick={() => void installUpdate()}
            >
              {updateBusy() ? "更新しています…" : "更新して再起動"}
            </button>
          </div>
        </aside>
      )}
    </Show>
  );
}
