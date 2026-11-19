// 手元の設定ファイルに間違いがあるときの画面。場所・行・理由だけを出し、ほかは何もしない（どこにもつながない）。
// 直して GUI を起動し直す。
import { T } from "../../../i18n/index.ts";
import type { JSX } from "solid-js";

import "../../components/card.css";
import { CardBody, CardTitle, CardError } from "../../components/Card.tsx";

export function ConfigError(props: { message: string }): JSX.Element {
  return (
    <main class="config-error" role="alert" aria-label="shijimi-editor">
      <div class="card config-error-card">
        <CardBody>
          <CardTitle>{T("configError.title")}</CardTitle>
          <CardError>{props.message}</CardError>
          <p class="card-hint">{T("configError.hint")}</p>
        </CardBody>
      </div>
    </main>
  );
}
