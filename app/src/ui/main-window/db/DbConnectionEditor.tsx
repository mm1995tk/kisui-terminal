// この PC の DB の接続を足す・直す・消す窓（接続を選ぶ窓の a・e・d で、その上に出す。#486）。
// 足す・直すは入力欄（名前・種類・ホスト・ポート・ユーザー・データベース・TLS・認証局・読み取り専用）。パスワードの欄は無い（つなぐときに聞く）。
// 空の欄は書かない（kisui の既定になる）。「Save」「Remove」で呼んだ側が config.local.toml に書き、書けたら窓を閉じる。
// 書けなければ理由（kisui の確かめと同じキーと理由）を出して、直して保存し直せるようにする。決まりは features/db/connectionForm.ts。
import { isComposingKey } from "../../../features/commands/ime.ts";
import { T } from "../../../i18n/index.ts";
import { createSignal, For, Show, type JSX } from "solid-js";

import type { DbConnForm } from "../../../features/db/connectionController.ts";
import type { DbConnectionFields } from "../../../features/db/connectionForm.ts";
import { Button } from "../../components/Button.tsx";
import {
  CardActions,
  CardBody,
  CardError,
  CardText,
  CardTitle,
  ModalCard,
} from "../../components/Card.tsx";
import { Field, Input } from "../../components/Field.tsx";

const TLS_MODES = ["prefer", "disable", "require", "verify"] as const;
const TLS_LABEL = {
  prefer: "dbConn.tls.prefer",
  disable: "dbConn.tls.disable",
  require: "dbConn.tls.require",
  verify: "dbConn.tls.verify",
} as const;

/** 入力欄 1 つの名前（i18n のキーの末尾と、DbConnectionFields のキー）。 */
type TextKey = "name" | "host" | "port" | "user" | "database" | "tlsCa";

/**
 * 足す・直す・消す窓。onSubmit は「Save」「Remove」と Enter で呼ぶ（入れた字をそのまま渡す。確かめるのは殻）。
 * busy の間（書いている最中）は入力とボタンを止める。onCancel は「Cancel」と Esc で呼ぶ。
 */
export function DbConnectionEditor(props: {
  form: DbConnForm;
  onSubmit: (fields: DbConnectionFields) => void;
  onCancel: () => void;
}): JSX.Element {
  // 窓は開くたびに作り直すので、初めの値は 1 回だけ読む
  const [fields, setFields] = createSignal<DbConnectionFields>({
    ...props.form.fields,
  });
  const set = <K extends keyof DbConnectionFields>(
    k: K,
    v: DbConnectionFields[K],
  ) => setFields((f) => ({ ...f, [k]: v }));
  const removing = () => props.form.mode === "remove";
  const title = () =>
    props.form.mode === "add"
      ? T("dbConn.title.add")
      : props.form.mode === "edit"
        ? T("dbConn.title.edit")
        : T("dbConn.title.remove");

  function submit() {
    if (props.form.busy) return;
    props.onSubmit(fields());
  }
  function onKeyDown(e: KeyboardEvent) {
    if (isComposingKey(e)) return;
    if (e.key === "Enter" && !(e.target instanceof HTMLSelectElement)) {
      e.preventDefault();
      submit();
    }
  }

  const text = (k: TextKey, placeholder?: string, first = false) => (
    <Field>
      {T(`dbConn.field.${k}`)}
      <Input
        type="text"
        inputMode={k === "port" ? "numeric" : undefined}
        placeholder={placeholder}
        value={fields()[k]}
        disabled={props.form.busy}
        autocomplete="off"
        spellcheck={false}
        onInput={(e) => set(k, e.currentTarget.value)}
        onKeyDown={onKeyDown}
        autofocus={first}
      />
    </Field>
  );

  return (
    <ModalCard
      label={title()}
      onCancel={props.onCancel}
      header={<CardTitle>{title()}</CardTitle>}
      footer={
        <CardActions>
          <Button onClick={props.onCancel}>{T("button.cancel")}</Button>
          <Button variant="primary" busy={props.form.busy} onClick={submit}>
            {removing() ? T("dbConn.remove") : T("dbConn.save")}
          </Button>
        </CardActions>
      }
    >
      <CardBody>
        <Show
          when={!removing()}
          fallback={
            // 入力欄が無いので、文にキーを向けて Enter で消せるようにする
            <div
              tabIndex={0}
              onKeyDown={onKeyDown}
              ref={(el) => queueMicrotask(() => el.focus())}
            >
              <CardText>
                {/* 上書きを消すと、接続は消えずに config.toml の接続に戻る */}
                {T(
                  props.form.overrides
                    ? "dbConn.removeLeadOverride"
                    : "dbConn.removeLead",
                  { name: props.form.name ?? "" },
                )}
              </CardText>
            </div>
          }
        >
          <CardText>{T("dbConn.lead")}</CardText>
          {text("name", undefined, true)}
          <Field>
            {T("dbConn.field.kind")}
            <select
              class="card-input"
              value={fields().kind}
              disabled={props.form.busy}
              onChange={(e) => set("kind", e.currentTarget.value)}
            >
              <option value="postgres">PostgreSQL</option>
              <option value="mysql">MySQL</option>
            </select>
          </Field>
          {text("host", T("dbConn.placeholder.host"))}
          {text("port", T("dbConn.placeholder.port"))}
          {text("user")}
          {text("database", T("dbConn.placeholder.database"))}
          <Field>
            {T("dbConn.field.tls")}
            <select
              class="card-input"
              value={fields().tls}
              disabled={props.form.busy}
              onChange={(e) => set("tls", e.currentTarget.value)}
            >
              <For each={TLS_MODES}>
                {(m) => <option value={m}>{T(TLS_LABEL[m])}</option>}
              </For>
            </select>
          </Field>
          <Show when={fields().tls === "verify" || fields().tlsCa !== ""}>
            {text("tlsCa", T("dbConn.placeholder.tlsCa"))}
          </Show>
          <label class="card-check">
            <input
              type="checkbox"
              checked={fields().readOnly}
              disabled={props.form.busy}
              onChange={(e) => set("readOnly", e.currentTarget.checked)}
            />
            {T("dbConn.field.readOnly")}
          </label>
        </Show>
        <Show when={props.form.errors.length > 0}>
          <CardError role="alert">
            <For each={props.form.errors}>{(line) => <div>{line}</div>}</For>
          </CardError>
        </Show>
      </CardBody>
    </ModalCard>
  );
}
