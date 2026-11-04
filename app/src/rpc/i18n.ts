// shj が送る文言（Msg）を、i18n.get で受け取った表で訳す。
// 形は設計書 docs/design/gui-protocol.md の「データの形」5 番と `i18n.get`、Go の core/msg と ui/internal/i18n。
//
// 文言は、キーの無い文字だけのもの（ファイル名など）が文字列のまま、それ以外が `{key?, args}` で来る。
// 訳したあとの画面は文字列だけなので、描く側は文言の形を知らなくてよい。

/** `{key?, args}`。args は文字列・数・真偽・入れ子の WireMsg。 */
export interface WireMsg {
  key?: string;
  args: unknown[];
}

/** i18n.get の結果と i18n.changed の中身。 */
export interface I18nTable {
  lang: string;
  messages: Record<string, string>;
}

/** v が文言か。`args` が配列で、`key` は無いか文字列で、ほかの項目が無いオブジェクト。 */
export function isWireMsg(v: unknown): v is WireMsg {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.args)) return false;
  for (const k of Object.keys(o)) if (k !== "key" && k !== "args") return false;
  return o.key === undefined || typeof o.key === "string";
}

/** Go の strconv.Quote に近い引用（%q）。 */
function quote(s: string): string {
  return JSON.stringify(s);
}

/** m を表 messages の言語の文字列にする。表に無いキーは、キーそのもの（Go の i18n.T と同じ）。 */
export function textOf(m: WireMsg, messages: Record<string, string>): string {
  const args = m.args.map((a) =>
    isWireMsg(a) ? textOf(a, messages) : (a as string | number | boolean),
  );
  if (m.key === undefined || m.key === "") return args.map(String).join("");
  return format(messages[m.key] ?? m.key, args);
}

/** Go の fmt.Sprintf のうち、表が使う `%s %d %q %v %w %c %%` を埋める。足りない値は `%!d(MISSING)`。 */
export function format(
  tmpl: string,
  args: readonly (string | number | boolean)[],
): string {
  let i = 0;
  return tmpl.replace(/%(.)/gs, (all, verb: string) => {
    if (verb === "%") return "%";
    if (!"sdqvwc".includes(verb)) return all;
    if (i >= args.length) return `%!${verb}(MISSING)`;
    const a = args[i++]!;
    switch (verb) {
      case "q":
        return quote(String(a));
      case "c":
        return typeof a === "number" ? String.fromCodePoint(a) : String(a);
      default:
        return String(a);
    }
  });
}

/**
 * v の中の文言を全部、その場で文字列にして返す（v は parse したばかりの JSON なので、書き換えてよい）。
 * 文言でないオブジェクトと配列は、中を見ていく。
 */
export function translate<T>(v: T, messages: Record<string, string>): T {
  return walk(v, messages) as T;
}

function walk(v: unknown, messages: Record<string, string>): unknown {
  if (typeof v !== "object" || v === null) return v;
  if (isWireMsg(v)) return textOf(v, messages);
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) v[i] = walk(v[i], messages);
    return v;
  }
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) o[k] = walk(o[k], messages);
  return v;
}
