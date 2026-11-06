// ブラウザの欄（#556）の、DOM を使わない部分。設計書 docs/design/browser-and-proxy.md の「GUI のブラウザの欄」。
// node --test で確かめられる。

/**
 * URL 欄に打ったものを、開く URL にする。http と https はそのまま、スキームの無いものは足す
 * （自分のマシンのもの＝localhost と IP アドレスは http、ほかは https）。ほかのスキーム（file:・javascript: など）は null。
 * 最後に殻（browser.rs）が、開いてよい URL かをもう一度確かめる。
 */
export function normalizeUrl(input: string): string | null {
  const s = input.trim();
  if (s === "" || /[\u0000-\u001f\u007f\s]/.test(s)) return null;
  if (/^https?:\/\//i.test(s)) return s;
  // スキームのように見えても、host:port（localhost:3000）は host として扱う
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^/?#]+:\d+(?:[/?#]|$)/.test(s))
    return null;
  if (s.startsWith("//") || s.startsWith("/")) return null;
  const host = s.split(/[/?#]/, 1)[0]!.replace(/:\d+$/, "");
  const local =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
  return `${local ? "http" : "https"}://${s}`;
}

/** 欄の中身を置く場所（メイン窓の左上からの CSS ピクセル）。 */
export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** getBoundingClientRect の結果から、子の webview の置き場所を作る（小数は丸める）。 */
export function boundsOf(r: {
  left: number;
  top: number;
  width: number;
  height: number;
}): Bounds {
  return {
    x: Math.round(r.left),
    y: Math.round(r.top),
    w: Math.max(1, Math.round(r.width)),
    h: Math.max(1, Math.round(r.height)),
  };
}

/** a が b と同じ場所か。a が undefined なら偽。 */
export function sameBounds(a: Bounds | undefined, b: Bounds): boolean {
  return !!a && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}
