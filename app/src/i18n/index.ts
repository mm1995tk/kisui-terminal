// 画面の文の表（en.ts・ja.ts）を引く。言語は起動時に 1 度だけ、手元の設定ファイルの `ui-language`（"en" か "ja"）で決める
// （index.tsx が Tauri の `ui_language` を読んで setLang を呼ぶ）。無い・分からない値は英語。
// 文は、コードに日本語や英語を直に書かず、必ずこの表のキーで引く（internal/i18n の Go 側と同じ考え方）。

import { en, type Key } from "./en.ts";
import { ja } from "./ja.ts";

export type { Key };

/** 対応する言語の名前。 */
export type Lang = "en" | "ja";

/** `ui-language` が無い・分からない値のときの言語。 */
export const DEFAULT_LANG: Lang = "en";

const tables: Record<Lang, Record<Key, string>> = { en, ja };

let current: Lang = DEFAULT_LANG;

/** 値が対応する言語の名前か。 */
export function isLang(code: unknown): code is Lang {
  return code === "en" || code === "ja";
}

/** 言語を選ぶ。空・分からない値は英語。 */
export function setLang(code: unknown): void {
  current = isLang(code) ? code : DEFAULT_LANG;
}

/** 今の言語の名前。 */
export function lang(): Lang {
  return current;
}

/** `{name}` の形の穴に値を入れる。 */
function fill(s: string, params?: Record<string, string | number>): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) =>
    k in params ? String(params[k]) : m,
  );
}

/** キーの文を、今の言語で返す。`{name}` の穴は params で埋める。 */
export function T(key: Key, params?: Record<string, string | number>): string {
  return fill(tables[current][key] ?? en[key] ?? key, params);
}

/** 表を言語ごとに返す（テスト用）。 */
export function tableOf(l: Lang): Record<string, string> {
  return tables[l];
}

/** キーの文を、すべての言語で返す（言語を切り替えても同じものとして扱いたい名前を照らすとき）。 */
export function inAllLangs(key: Key): string[] {
  return [en[key], ja[key]];
}
