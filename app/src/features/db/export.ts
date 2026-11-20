// DB のタブの結果の表の書き出し（#349）：CSV・TSV・JSON の文字を作る。画面にも Tauri にも触らない（node --test で確かめられる）。
//
// 値の書き方（Issue で「作業役が決めてよい」とされた細部）：
// - 値は DB が書く文字のまま（数も文字。db.query の結果がそうなので、桁を落とさない）。日時も DB の書き方のまま。
// - NULL は、CSV・TSV では空のセル、JSON では null。空の文字列は、CSV・TSV では `""`（NULL と見分けるため。
//   PostgreSQL の COPY の CSV と同じ）、JSON では ""。
// - CSV：区切りは `,`、行の終わりは CRLF（RFC 4180）。`,` `"` 改行を含む値は `"` で囲み、中の `"` は 2 つにする。
// - TSV：区切りは tab、行の終わりは LF。tab・`"`・改行を含む値は、CSV と同じく `"` で囲む（表計算の貼り付けが読める形）。
// - JSON：列の名前をキーにしたオブジェクトの配列（字下げ 2 つ）。数の列は、JSON の数の書き方に合う値だけ数にし
//   （文字のまま書くので、桁を落とさない）、合わないもの（NaN・Infinity）は文字のまま。真偽の列は true・false。
//   列の名前が重なったら、後の列に `_2` `_3` … を付ける（キーが重なって値が消えないように）。
// - 実行した文の結果が上限で切れていても（truncated）、rows にある分だけを書く。
// - 先頭に BOM は付けない（Excel が UTF-8 の CSV を文字化けして開く場合は、表計算の取り込みで UTF-8 を選ぶ）。

import type {
  DbColumn,
  DbQueryResult,
} from "../../infrastructure/rpc/protocol.ts";

/** 書き出しの形。 */
export type ExportFormat = "csv" | "tsv" | "json";

/** 書き出し先。clipboard：OS のクリップボード、file：保存のダイアログで選んだファイル。 */
export type ExportTarget = "clipboard" | "file";

/** 書き出しで選ぶもの 1 つ（形と書き出し先）。 */
export interface ExportChoice {
  format: ExportFormat;
  target: ExportTarget;
}

/** 書き出しの窓に並べる選び方（形の順に、クリップボード・ファイル）。 */
export const EXPORT_CHOICES: readonly ExportChoice[] = (
  ["csv", "tsv", "json"] as const
).flatMap((format) =>
  (["clipboard", "file"] as const).map((target) => ({ format, target })),
);

/** ファイルの拡張子（ドットなし）。 */
export function exportExtension(format: ExportFormat): string {
  return format;
}

/** 保存のダイアログの既定のファイル名：`接続の名前-年月日-時分秒.拡張子`（時刻はこの端末のもの）。環境の変種のある接続は、connection に `接続-変種` を渡す。 */
export function exportFileName(
  connection: string,
  format: ExportFormat,
  now: Date = new Date(),
): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${connection}-${stamp}.${exportExtension(format)}`;
}

/** 書き出せる結果か（行を返す文の結果で、列がある）。行が 0 でも、列の見出しだけは書き出せる。 */
export function isExportable(r: DbQueryResult | undefined): r is DbQueryResult {
  return r !== undefined && r.columns.length > 0;
}

/** 結果 r を、形 format の文字にする。 */
export function exportText(r: DbQueryResult, format: ExportFormat): string {
  switch (format) {
    case "csv":
      return delimited(r, ",", "\r\n");
    case "tsv":
      return delimited(r, "\t", "\n");
    case "json":
      return toJson(r);
  }
}

/** 区切り文字の形（CSV・TSV）。見出しの行のあとに値の行。最後の行にも行の終わりを付ける。 */
function delimited(r: DbQueryResult, sep: string, eol: string): string {
  const line = (cells: readonly (string | null)[]) =>
    cells.map((c) => field(c, sep)).join(sep) + eol;
  return (
    line(r.columns.map((c) => c.name)) + r.rows.map((row) => line(row)).join("")
  );
}

/** 1 つのセル。NULL は空、空の文字列は `""`、区切り・`"`・改行を含むものは `"` で囲む。 */
export function field(v: string | null, sep: string): string {
  if (v === null) return "";
  if (v === "") return '""';
  return v.includes(sep) || /["\r\n]/.test(v)
    ? `"${v.replace(/"/g, '""')}"`
    : v;
}

/** JSON の数の書き方に合う文字（先頭の 0 の並び・`+`・`.5`・`NaN` は合わない）。 */
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** 列の名前を、重ならないキーにする（重なったら後の列に `_2` `_3` … を付ける）。 */
export function uniqueKeys(columns: readonly DbColumn[]): string[] {
  const used = new Set<string>();
  return columns.map((c) => {
    let key = c.name;
    for (let n = 2; used.has(key); n++) key = `${c.name}_${n}`;
    used.add(key);
    return key;
  });
}

function jsonValue(v: string | null, kind: DbColumn["kind"]): string {
  if (v === null) return "null";
  if (kind === "number" && JSON_NUMBER.test(v)) return v;
  if (kind === "boolean" && (v === "true" || v === "false")) return v;
  return JSON.stringify(v);
}

function toJson(r: DbQueryResult): string {
  if (r.rows.length === 0) return "[]\n";
  const keys = uniqueKeys(r.columns).map((k) => JSON.stringify(k));
  const rows = r.rows.map((row) => {
    const members = keys.map(
      (k, i) => `    ${k}: ${jsonValue(row[i] ?? null, r.columns[i]!.kind)}`,
    );
    return `  {\n${members.join(",\n")}\n  }`;
  });
  return `[\n${rows.join(",\n")}\n]\n`;
}

/** 保存のダイアログを出して、選んだ場所に文字を書く（本物は infrastructure/tauri/export.ts）。やめたら null、書けたらそのパス。 */
export type SaveTextFile = (o: {
  defaultName: string;
  extension: string;
  text: string;
}) => Promise<string | null>;

/** 書き出すものが欠けているときの知らせの文のキー（行が上限で切れている・長い値が切られている）。欠けていなければ空。 */
export function exportNoteKeys(o: {
  truncated: boolean;
  truncatedCells: boolean;
}): ("db.export.truncated" | "db.export.truncatedCells")[] {
  return [
    ...(o.truncated ? (["db.export.truncated"] as const) : []),
    ...(o.truncatedCells ? (["db.export.truncatedCells"] as const) : []),
  ];
}
