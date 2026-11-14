// 内蔵ブラウザのタブで、リモート（ssh）のマシンの localhost 系の URL を開くときの、中継前と中継後の URL の対応（#203）。
// DOM も Tauri も使わない（node --test で確かめられる）。
//
// タブは、中継前の元の URL（`http://localhost:3000/`）を覚え、入力欄にもそれを出す。ページ（子の webview）が実際に開くのは、
// 殻が `kisui relay` の中継を用意して返す手元の URL（`http://127.0.0.1:<ポート>/`。open_url.rs の browser_resolve_url）。
// ページが遷移して殻から届く URL は中継後のものなので、同じ origin なら元の origin に戻してからタブに書く。

/** 中継の origin と、元の origin。 */
export interface Relayed {
  /** ページが実際に開く origin（`http://127.0.0.1:<ポート>`） */
  local: string;
  /** 元の URL の origin（`http://localhost:3000`） */
  original: string;
}

/** 元の URL と、殻が返した実際に開く URL から、対応を作る。origin が同じ（中継しない）なら null。 */
export function relayedOf(original: string, opened: string): Relayed | null {
  try {
    const a = new URL(original);
    const b = new URL(opened);
    return a.origin === b.origin
      ? null
      : { local: b.origin, original: a.origin };
  } catch {
    return null;
  }
}

/** ページから届いた URL を、元の origin の URL に戻す。中継の origin でなければ、そのまま返す。 */
export function unrelay(url: string, r: Relayed | undefined): string {
  if (!r) return url;
  try {
    const u = new URL(url);
    if (u.origin !== r.local) return url;
    const o = new URL(r.original);
    u.protocol = o.protocol;
    // host に port の無い値を入れても port は残るので、hostname と port を別に入れる（port の "" は既定のポート）
    u.hostname = o.hostname;
    u.port = o.port;
    return u.href;
  } catch {
    return url;
  }
}
