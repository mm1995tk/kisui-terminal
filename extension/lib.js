// kisui-terminal の拡張機能の、ブラウザの API に触れない部分（background.js が使う。テストは extension.test.ts）。
// 取り決めは docs/passkey-extension.md。
//
// Chrome の service worker（importScripts）と Firefox の background の scripts の両方で読めるよう、
// ES module にせず、大域の KisuiPasskey に入れる。
var KisuiPasskey = (() => {
  // native messaging の受け口の名前。普通の版と nightly 版を並べて入れていることがあるので、両方に聞く
  const HOSTS = [
    "dev.mm1995tk.kisui_terminal",
    "dev.mm1995tk.kisui_terminal_nightly",
  ];

  // 1 回に送る Cookie の上限（kisui-terminal が受ける上限）
  const MAX_COOKIES = 1000;

  // 新しいタブの最初のページが、kisui-terminal が開いたものかを見るのは、タブができてからこの間だけ
  const NEW_TAB_MS = 30 * 1000;

  // パスキーが通ったあと、落ち着いたと見るまでの長さ:
  // ページの読み込みが済み、そのサイトの Cookie が SETTLE_QUIET_MS の間変わらなければ落ち着いた。
  // 早すぎないよう、パスキーが通ってから SETTLE_MIN_MS は待つ。SETTLE_MAX_MS を過ぎたら、落ち着かなくても送る
  const SETTLE_MIN_MS = 2000;
  const SETTLE_QUIET_MS = 1500;
  const SETTLE_MAX_MS = 15000;

  // URL の host（小文字）。http(s) でなければ null
  function hostOf(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.hostname.toLowerCase();
  }

  // `sites` の答えの形を確かめて、{ sites, waiting } にする。形が違えば null
  function parseSites(reply) {
    if (!reply || reply.type !== "sites" || !Array.isArray(reply.sites))
      return null;
    const sites = reply.sites.filter((s) => typeof s === "string");
    const waiting = Array.isArray(reply.waiting)
      ? reply.waiting.filter(
          (w) => w && typeof w.site === "string" && sites.includes(w.site),
        )
      : [];
    return { sites, waiting };
  }

  // 各受け口の答え（{ host, reply }。つなげなかったものは reply が null）から、許可サイトすべてと、
  // サイトごとの待っている受け口を作る
  function combine(answers) {
    const sites = new Set();
    const waiting = new Map();
    for (const { host, reply } of answers) {
      const p = parseSites(reply);
      if (!p) continue;
      for (const s of p.sites) sites.add(s);
      for (const w of p.waiting) {
        if (!waiting.has(w.site)) waiting.set(w.site, { host, url: w.url });
      }
    }
    return { sites: [...sites].sort(), waiting };
  }

  // 許可サイトのページに入れるスクリプトの matches
  function matchPatterns(sites) {
    return sites.map((s) => `https://${s}/*`);
  }

  // Cookie が `site` のページに送られるか（kisui-terminal が受けるのと同じ決まり）。
  // ドメインが `site` と同じか、host だけでない上のドメインのもの
  function appliesTo(cookie, site) {
    if (!cookie || typeof cookie.domain !== "string") return false;
    const hostOnly = cookie.hostOnly === true && !cookie.domain.startsWith(".");
    const domain = cookie.domain.replace(/^\.+/, "").toLowerCase();
    if (domain === site) return true;
    return !hostOnly && domain.includes(".") && site.endsWith(`.${domain}`);
  }

  // 読んだ Cookie から `site` に送られるものだけを残し、同じもの（名前・ドメイン・パス）を 1 つにし、
  // 取り決めの形にして返す（多ければ上限で切る）
  function pickCookies(cookies, site) {
    const seen = new Set();
    const out = [];
    for (const c of cookies) {
      if (!appliesTo(c, site)) continue;
      const key = `${c.name}\u0000${c.domain}\u0000${c.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const w = {
        name: c.name,
        value: c.value,
        domain: c.domain,
        hostOnly: c.hostOnly === true,
        path: typeof c.path === "string" ? c.path : "/",
        secure: c.secure === true,
        httpOnly: c.httpOnly === true,
        session: c.session === true,
      };
      if (typeof c.sameSite === "string") w.sameSite = c.sameSite;
      if (typeof c.expirationDate === "number")
        w.expirationDate = c.expirationDate;
      out.push(w);
      if (out.length >= MAX_COOKIES) break;
    }
    return out;
  }

  // パスキーが通ってから落ち着いたか。now・successAt・lastCookieChange は ms。tabComplete はページの読み込みが済んだか
  function settled({ now, successAt, lastCookieChange, tabComplete }) {
    const since = now - successAt;
    if (since >= SETTLE_MAX_MS) return true;
    if (since < SETTLE_MIN_MS || !tabComplete) return false;
    const last = Math.max(successAt, lastCookieChange || 0);
    return now - last >= SETTLE_QUIET_MS;
  }

  // 新しいタブの最初のページが、kisui-terminal が開いたものか。
  // できてから NEW_TAB_MS のうちに、待っているサイトのページを開いたタブを、kisui-terminal が開いたものと見る
  // （サイトが最初にリダイレクトしても見分けられるよう、URL でなくサイトで比べる）
  function openedByKisui({ url, createdAt, now, waiting }) {
    if (now - createdAt > NEW_TAB_MS) return null;
    const host = hostOf(url);
    if (!host) return null;
    const w = waiting.get(host);
    return w ? { site: host, host: w.host } : null;
  }

  // 2 つの URL が同じページか（ブラウザが書き直す形の違いと、# の後ろは見ない）
  function sameUrl(a, b) {
    try {
      const x = new URL(a);
      const y = new URL(b);
      x.hash = "";
      y.hash = "";
      return x.href === y.href;
    } catch {
      return false;
    }
  }

  return {
    HOSTS,
    MAX_COOKIES,
    NEW_TAB_MS,
    SETTLE_MIN_MS,
    SETTLE_QUIET_MS,
    SETTLE_MAX_MS,
    hostOf,
    parseSites,
    combine,
    matchPatterns,
    appliesTo,
    pickCookies,
    settled,
    openedByKisui,
    sameUrl,
  };
})();
