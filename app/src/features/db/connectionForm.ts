// Dialog から DB の接続を足す・直す・消す（#486）。書くのは殻（app/src-tauri/src/config_db.rs）で、手元の config.local.toml の
// [[db.connections]] だけ。手元の kisui serve は要求のたびに設定を読み直すので、書いたら接続を選ぶ Dialog の一覧を聞き直せば出る。
// リモートのマシンの接続と config.toml の接続は、Dialog からは変えない（理由を出す。rowEditState）。
// パスワードは扱わない：入力欄も、書く形（DbConnectionFields）にも無い。つなぐときに聞く（controller.ts の askPassword）。
// 画面にも Tauri にも触らない。
import { T, type Key } from "../../i18n/index.ts";
import { LOCAL } from "../sessions/shell.ts";
import type { DbChoice } from "./model.ts";

/** 入力欄の中身（殻の DbFields）。どれも入れた字のまま（前後の空白は殻が除く）。空の欄は書かない（kisui の既定になる）。 */
export interface DbConnectionFields {
  name: string;
  /** "postgres" か "mysql" */
  kind: string;
  host: string;
  /** 空なら種類の既定（5432・3306） */
  port: string;
  user: string;
  database: string;
  readOnly: boolean;
  /** "prefer"（既定。書かない）・"disable"・"require"・"verify" */
  tls: string;
  /** tls が verify のときだけ（絶対パスか ~ で始まるパス） */
  tlsCa: string;
}

/** config.local.toml の接続 1 つ（殻の DbEntry。書いてある形のまま）。 */
export interface LocalDbEntry extends DbConnectionFields {
  /** Dialog で直せるか（変種・権限など、Dialog で入れないキーを書いた項目は false。消すことはできる） */
  editable: boolean;
  /** config.toml の同じ名前の接続に代わっている（上書き）。消すと config.toml の接続に戻る */
  overrides: boolean;
}

/** Window が知る、手元の DB の接続（殻の DbConnections）。 */
export interface LocalDbConnections {
  /** config.local.toml の項目 */
  local: LocalDbEntry[];
  /** config.toml の項目の名前（Dialog では変えられない） */
  fixed: string[];
}

/** Dialog の書き込み 1 つ（殻の DbEdit）。 */
export type DbConnectionEdit =
  | { kind: "add"; connection: DbConnectionFields }
  | { kind: "update"; name: string; connection: DbConnectionFields }
  | { kind: "remove"; name: string };

/** 殻に頼むこと（本物は infrastructure/tauri/dbConfig.ts）。 */
export interface DbConfigFiles {
  list(): Promise<LocalDbConnections>;
  edit(e: DbConnectionEdit): Promise<LocalDbConnections>;
}

/** 新しい接続の入力欄の初めの中身。 */
export function emptyFields(): DbConnectionFields {
  return {
    name: "",
    kind: "postgres",
    host: "",
    port: "",
    user: "",
    database: "",
    readOnly: false,
    tls: "prefer",
    tlsCa: "",
  };
}

/** config.local.toml の項目を、入力欄の中身にする。 */
export function fieldsOf(e: LocalDbEntry): DbConnectionFields {
  return {
    name: e.name,
    kind: e.kind || "postgres",
    host: e.host,
    port: e.port,
    user: e.user,
    database: e.database,
    readOnly: e.readOnly,
    tls: e.tls || "prefer",
    tlsCa: e.tlsCa,
  };
}

/**
 * 接続を選ぶ Dialog の 1 行を、Dialog から変えられるか。
 * edit：直せる・消せる。removeOnly：消せるが、Dialog で入れないキーを書いた項目なので直すのは設定ファイルで。
 * fixed：config.toml の接続。remote：リモートのマシンの接続。unknown：手元の設定を読めていない。
 */
export type RowEditState =
  | { kind: "edit"; entry: LocalDbEntry }
  | { kind: "removeOnly"; entry: LocalDbEntry }
  | { kind: "fixed" }
  | { kind: "remote" }
  | { kind: "unknown" };

/**
 * 接続を選ぶ Dialog の行 c を、Dialog から変えられるかを、次の順で決める。行が無ければ unknown。
 * 1. 行のマシンが手元（LOCAL）でなければ remote（Window が書けるのは手元の設定だけ）。
 * 2. 手元の設定 local がまだ読めていない・読めなかった（undefined）なら unknown。
 * 3. config.local.toml に同じ名前の項目があれば、Dialog で直せる項目（editable）で変種の行でもなければ edit、そうでなければ removeOnly。
 * 4. config.toml の接続の名前なら fixed。どれでもなければ unknown。
 */
export function rowEditState(
  c: DbChoice | undefined,
  local: LocalDbConnections | undefined,
): RowEditState {
  if (!c) return { kind: "unknown" };
  if (c.target !== LOCAL) return { kind: "remote" };
  if (!local) return { kind: "unknown" };
  const entry = local.local.find((e) => e.name === c.connection.name);
  if (entry)
    return entry.editable && !c.connection.variant
      ? { kind: "edit", entry }
      : { kind: "removeOnly", entry };
  if (local.fixed.includes(c.connection.name)) return { kind: "fixed" };
  return { kind: "unknown" };
}

/**
 * 行に付ける「config.local.toml で登録している」印（手元のマシンの、config.local.toml にある接続だけ）。
 * 上書きを消すと、行は config.toml の接続に戻って印が外れるので、どちらの接続かが目で分かる。
 */
export function localMark(
  c: DbChoice,
  local: LocalDbConnections | undefined,
): boolean {
  return (
    c.target === LOCAL &&
    (local?.local.some((e) => e.name === c.connection.name) ?? false)
  );
}

/** 行を直せない・消せない理由（直せるなら undefined）。 */
export function rowEditNote(s: RowEditState): string | undefined {
  switch (s.kind) {
    case "edit":
      return undefined;
    case "removeOnly":
      return T("dbConn.note.fileOnly");
    case "fixed":
      return T("dbConn.note.fixed");
    case "remote":
      return T("dbConn.note.remote");
    case "unknown":
      return T("dbConn.note.unknown");
  }
}

/** 殻が返す、項目の間違い 1 つ（kisui の config/db.go と同じキーとコード。Dialog だけの確かめは gui.db.*）。 */
interface DbProblem {
  key: string;
  code: string;
  args: string[];
}

/** 殻から来た、書けなかった理由（config_list.rs の EditError の形）。 */
interface DbEditError {
  kind: string;
  detail: unknown;
}

function isEditError(e: unknown): e is DbEditError {
  return (
    typeof e === "object" &&
    e !== null &&
    "kind" in e &&
    typeof e.kind === "string" &&
    "detail" in e
  );
}

/** 間違いのコードと、その文の i18n のキー。文に入れる値は、kisui と同じ順の args を {arg} に入れる。 */
const PROBLEM_KEYS: Record<string, Key> = {
  "config.err.required": "dbConn.err.required",
  "config.err.string": "dbConn.err.string",
  "config.err.int": "dbConn.err.int",
  "config.err.bool": "dbConn.err.bool",
  "config.err.control": "dbConn.err.control",
  "config.err.toolong": "dbConn.err.toolong",
  "config.err.port": "dbConn.err.port",
  "config.err.oneof": "dbConn.err.oneof",
  "config.err.abspath": "dbConn.err.abspath",
  "config.err.tlssocket": "dbConn.err.tlssocket",
  "config.err.tlsca": "dbConn.err.tlsca",
  "config.err.password": "dbConn.err.password",
  "config.err.unknown": "dbConn.err.unknown",
  "gui.db.fileonly": "dbConn.err.fileonly",
  "gui.db.hosturl": "dbConn.err.hosturl",
  "gui.db.url": "dbConn.err.url",
};

/** 間違い 1 つを、画面に出す 1 文にする（「キー：理由」）。 */
export function problemText(p: DbProblem): string {
  const k = PROBLEM_KEYS[p.code];
  const why = k ? T(k, { arg: p.args[0] ?? "" }) : p.code;
  return T("dbConn.err.problem", { key: p.key, why });
}

/** 殻が config.local.toml に書けなかった理由を、画面に出す文の並びにする（殻から来たもの以外も受ける）。 */
export function editErrorLines(e: unknown): string[] {
  if (!isEditError(e)) return [T("dbConn.err.failed", { error: String(e) })];
  const { kind, detail } = e;
  if (kind === "invalid" && Array.isArray(detail))
    return (detail as DbProblem[]).map(problemText);
  if (kind === "exists")
    return [T("dbConn.err.exists", { name: String(detail) })];
  if (kind === "missing")
    return [T("dbConn.err.missing", { name: String(detail) })];
  if (kind === "fixed")
    return [T("dbConn.err.fixed", { name: String(detail) })];
  return [T("dbConn.err.failed", { error: String(detail) })];
}
