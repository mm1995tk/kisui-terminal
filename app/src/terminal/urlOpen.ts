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

/** 開いてよい URL か。scheme（http と https）と host だけを見る。ユーザー名・パスワード入りや制御文字・長すぎる URL は、殻と serve が断る。 */
export function isOpenableUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
  } catch {
    return false;
  }
}

/** そのマシン自身を指す host か（殻の `is_loopback` と同じ決まり）。 */
export function isLoopbackUrl(s: string): boolean {
  try {
    const h = new URL(s).hostname.replace(/^\[|\]$/g, "");
    return (
      h === "localhost" ||
      h === "127.0.0.1" ||
      h === "::1" ||
      h === "0.0.0.0" ||
      h.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

/**
 * 開く先を、URL が指す先に合わせて直す。リモートのマシンのターミナルに出た localhost 系の URL を OS 既定のブラウザに渡すと、
 * 手元の localhost（別のマシン）が開いてしまう。内蔵ブラウザなら ssh のポート転送越しに開くので、そちらに寄せる。
 */
export function forwardIfRemote(
  to: UrlTarget,
  url: string,
  remote: boolean,
): UrlTarget {
  return to === "external" && remote && isLoopbackUrl(url) ? "builtin" : to;
}
