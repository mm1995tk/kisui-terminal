// ターミナルに出た URL のクリック（#47）で、どこで開くかを決める。DOM も Tauri も使わない。

import type { UrlClick } from "coneko-term";

/**
 * クリックで URL を開くか。修飾キーは macOS では cmd、それ以外では ctrl（`cmd -` などと同じ扱い）。ほかに alt を押していれば開かない。
 * shift は付けても付けなくても同じ（どちらも手元の外部ブラウザで開く。アプリがマウスの報告を有効にしている間は、shift なしはアプリに届く）。
 */
export function isUrlOpenClick(
  click: Pick<UrlClick, "altKey" | "ctrlKey" | "metaKey">,
  mac: boolean,
): boolean {
  const mod = mac
    ? click.metaKey && !click.ctrlKey
    : click.ctrlKey && !click.metaKey;
  return mod && !click.altKey;
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
