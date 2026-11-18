// 手元の設定ファイルに間違いがあるときの画面。場所・行・理由だけを出し、ほかは何もしない（どこにもつながない）。
// 直して GUI を起動し直す。
import { T } from "../../../i18n/index.ts";
import type { JSX } from "solid-js";

import "../../components/card.css";

export function ConfigError(props: { message: string }): JSX.Element {
  return (
    <main class="config-error" role="alert" aria-label="shijimi-editor">
      <div class="card config-error-card">
        <div class="card-body">
          <h1 class="card-title">{T("configError.title")}</h1>
          <pre class="card-error">{props.message}</pre>
          <p class="card-hint">{T("configError.hint")}</p>
        </div>
      </div>
    </main>
  );
}
