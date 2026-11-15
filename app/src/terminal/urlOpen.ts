// ターミナルに出た URL のクリック（#47）で、どこで開くかを決める。DOM も Tauri も使わない。

import type { UrlClick } from "coneko-term";

/**
 * URL のクリックで、どう開くか。修飾キーは macOS では cmd、それ以外では ctrl（`cmd -` などと同じ扱い）。
 * - `"open"`：cmd + クリック。内蔵ブラウザを有効にしていれば今のワークスペースの新しいタブ、無効なら外のブラウザで開く（#203）。
 * - `"external"`：cmd + option + クリック（macOS 以外は ctrl + alt）。いつも外のブラウザ（OS 既定のブラウザ）で開く。
 * - `null`：開かない。
 *
 * shift は付けても付けなくても同じ。アプリがマウスの報告を有効にしている間は、shift なしのクリックはアプリに届き、
 * shift 付きだけが届く（coneko-term の onUrlClick）。
 */
export function urlClickAction(
  click: Pick<UrlClick, "altKey" | "ctrlKey" | "metaKey">,
  mac: boolean,
): "open" | "external" | null {
  const mod = mac
    ? click.metaKey && !click.ctrlKey
    : click.ctrlKey && !click.metaKey;
  if (!mod) return null;
  return click.altKey ? "external" : "open";
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
