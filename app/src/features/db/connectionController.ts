// 接続を選ぶ窓から、手元の PC の DB の接続を足す・直す・消す（#486）の操作。決まりは connectionForm.ts。
// 書くのは殻（config.local.toml）。書けたら、接続を選ぶ窓の一覧を聞き直す（手元の kisui serve は要求のたびに設定を読み直す）。
// パスワードは扱わない。画面にも Tauri にも触らない。
import { createSignal, untrack } from "solid-js";

import { T } from "../../i18n/index.ts";
import {
  editErrorLines,
  emptyFields,
  fieldsOf,
  rowEditState,
  type DbConfigFiles,
  type DbConnectionFields,
  type LocalDbConnections,
} from "./connectionForm.ts";
import type { DbChoice } from "./model.ts";

/** 足す・直す・消す窓に出すもの。 */
export interface DbConnForm {
  mode: "add" | "edit" | "remove";
  /** 直す・消す接続の、今の名前 */
  name?: string;
  /** 入力欄の初めの中身（消すときは使わない） */
  fields: DbConnectionFields;
  /** 書いている最中 */
  busy: boolean;
  /** 直前に書けなかった理由（1 つずつ 1 行） */
  errors: string[];
}

/** 足す・直す・消すの持ち物を作る。 */
export function createDbConnections(deps: {
  config: DbConfigFiles;
  /** 書けたあと、接続を選ぶ窓の一覧を聞き直す */
  refresh: () => void;
}) {
  const [local, setLocal] = createSignal<LocalDbConnections | undefined>();
  const [localError, setLocalError] = createSignal<string | undefined>();
  const [form, setForm] = createSignal<DbConnForm | null>(null);

  /** 手元の設定を読み直す（接続を選ぶ窓を開くたび）。 */
  async function loadLocal() {
    try {
      setLocal(await deps.config.list());
      setLocalError(undefined);
    } catch (e) {
      setLocal(undefined);
      setLocalError(
        T("dbConn.note.listFailed", { error: editErrorLines(e).join(" ") }),
      );
    }
  }

  /** 足す窓を開く。 */
  function openAdd() {
    setForm({ mode: "add", fields: emptyFields(), busy: false, errors: [] });
  }

  /** 選んでいる接続 c を直す（mode が edit）・消す（remove）窓を開く。変えられない接続なら何もしない（理由は窓の下の段に出ている）。 */
  function openFor(mode: "edit" | "remove", c: DbChoice | undefined) {
    const s = rowEditState(c, untrack(local));
    if (s.kind !== "edit" && !(mode === "remove" && s.kind === "removeOnly"))
      return;
    setForm({
      mode,
      name: s.entry.name,
      fields: fieldsOf(s.entry),
      busy: false,
      errors: [],
    });
  }

  /** 窓の「Save」「Remove」：書く。書けたら窓を閉じて一覧を聞き直し、書けなければ理由を出す。 */
  async function submit(fields: DbConnectionFields) {
    const f = untrack(form);
    if (!f || f.busy) return;
    setForm({ ...f, busy: true, errors: [] });
    try {
      const after = await deps.config.edit(
        f.mode === "add"
          ? { kind: "add", connection: fields }
          : f.mode === "edit"
            ? { kind: "update", name: f.name ?? "", connection: fields }
            : { kind: "remove", name: f.name ?? "" },
      );
      setLocal(after);
      setLocalError(undefined);
      // 書いている間に窓を閉じていても、ファイルは変わったので一覧は聞き直す
      if (untrack(form) !== null) setForm(null);
      deps.refresh();
    } catch (e) {
      const now = untrack(form);
      if (now)
        setForm({ ...now, fields, busy: false, errors: editErrorLines(e) });
    }
  }

  function close() {
    setForm(null);
  }

  return {
    /** 手元の config.local.toml の接続と config.toml の接続の名前（読めていなければ undefined） */
    localDb: local,
    /** 手元の設定を読めなかった理由 */
    localDbError: localError,
    loadLocal,
    /** 足す・直す・消す窓（出していなければ null） */
    connForm: form,
    openConnAdd: openAdd,
    openConnFor: openFor,
    submitConnForm: (fields: DbConnectionFields) => void submit(fields),
    closeConnForm: close,
  };
}
