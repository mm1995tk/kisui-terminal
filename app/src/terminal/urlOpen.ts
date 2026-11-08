// ターミナルに出た URL のクリック（#47）で、どこで開くかを決める。DOM も Tauri も使わない。

import type { UrlClick } from "coneko-term";

/** 開く先。`builtin` は kisui-terminal のブラウザの欄、`external` は OS 既定のブラウザ。 */
export type UrlTarget = "builtin" | "external";

/**
 * クリックで URL をどこで開くか。開かない（ふつうのクリック）なら undefined。
 * 修飾キーは macOS では cmd、それ以外では ctrl（`cmd -` などと同じ扱い）。ほかに alt を押していれば開かない。
 * cmd（ctrl）+ shift + クリックは設定（`setting`）の先、shift なしはその反対側。
 */
export function urlTarget(
  click: Pick<UrlClick, "shiftKey" | "altKey" | "ctrlKey" | "metaKey">,
  mac: boolean,
  setting: UrlTarget,
): UrlTarget | undefined {
  const mod = mac
    ? click.metaKey && !click.ctrlKey
    : click.ctrlKey && !click.metaKey;
  if (!mod || click.altKey) return undefined;
  if (click.shiftKey) return setting;
  return setting === "external" ? "builtin" : "external";
}

/** 開いてよい URL か（http と https だけ。殻と serve も同じ決まりで断る）。 */
export function isOpenableUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
  } catch {
    return false;
  }
}
