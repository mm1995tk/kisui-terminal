// 自動更新の知らせ（C8）。起動したら 1 度だけ新しい版があるかを殻に聞き、あれば右下の知らせ（connect/Notices.tsx）に積む。
// 入れ替えは「更新して再起動」を押したときだけ行う（編集中に勝手に起動し直さないため）。
// 自動更新は AppImage と .dmg の版だけが持つ。Nix で作る版では殻がいつも「無い」と答えるので、何も出ない。
import { invoke } from "@tauri-apps/api/core";
import { createSignal, onMount, Show, type JSX } from "solid-js";

import "../connect/card.css";

/** 殻（src-tauri/src/update.rs の UpdateInfo）が返す新しい版。 */
type UpdateInfo = { current: string; version: string; notes: string | null };

export function UpdateBar(): JSX.Element {
  const [info, setInfo] = createSignal<UpdateInfo | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  onMount(() => {
    invoke<UpdateInfo | null>("update_check").then(setInfo, () => {
      // 調べられないのはネットにつながっていないだけのことが多い。知らせない
    });
  });

  async function install() {
    setBusy(true);
    setError("");
    try {
      // うまくいけば起動し直すので、ここには戻らない
      await invoke("update_install");
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <Show when={info()}>
      {(u) => (
        <aside class="card card-notice" role="status" aria-label="新しい版">
          <div class="card-body">
            <h2 class="card-title">新しい版 {u().version} があります</h2>
            <p class="card-text">
              今は {u().current} です。更新すると、入れ替えて起動し直します。
            </p>
            <Show when={error()}>
              <pre class="card-error" role="alert">
                {error()}
              </pre>
            </Show>
          </div>
          <div class="card-actions">
            <button
              type="button"
              class="card-button"
              disabled={busy()}
              onClick={() => setInfo(null)}
            >
              あとで
            </button>
            <button
              type="button"
              class="card-button primary"
              disabled={busy()}
              onClick={() => void install()}
            >
              {busy() ? "更新しています…" : "更新して再起動"}
            </button>
          </div>
        </aside>
      )}
    </Show>
  );
}
