// 内蔵ブラウザのタブ（browser.rs）のページの favicon を読む（favicon.rs。#237）。
// 殻がページの読み込みの終わり・（読み込みの後の）題の変化のたびに、ページの外の世界（isolated world。ページのスクリプトからは
// 見えず、ページが DOM の関数を差し替えても効かない）で、このファイルの後ろに `return main();` を付けた関数の本体を動かす。
// 返した文字を殻が受ける。
// ページの中で画像を読み込み、32×32 の PNG の data: URL にして返す。読み込むのはページ自身（ページと同じデータ。
// シークレットのタブはディスクに残さないデータ）。外の origin の画像は、CORS で許されたものだけ読める（許されなければ次の候補へ。
// どれも駄目なら "" を返し、画面は地球のアイコンを出す）。
// candidates は DOM に触らない（app/src/browser/favicon.test.ts で確かめる）。

/** 画面に出す大きさ（縦横の画素）。 */
const SIZE = 32;
/** 画像 1 つを待つ長さ。 */
const WAIT_MS = 5000;

/**
 * 読みに行く画像の URL を、試す順に並べる。
 * `<link rel="icon">` のうち 32×32 に合うもの（sizes が 32x32 か any、または SVG）、残りの `rel="icon"` を後に書いたものから
 * （ふつうのブラウザと同じ）、`apple-touch-icon`、最後に `/favicon.ico`。http・https・data: だけ。重なりは除く。
 * @param {{rel: string, sizes: string, type: string, href: string}[]} links ページの `<link>`（書いた順）
 * @param {string} base 相対の URL を解く元（document.baseURI）
 * @returns {string[]}
 */
function candidates(links, base) {
  const abs = (href) => {
    try {
      const u = new URL(href, base);
      return ["http:", "https:", "data:"].includes(u.protocol) ? u.href : "";
    } catch {
      return "";
    }
  };
  const has = (l, token) => l.rel.toLowerCase().split(/\s+/).includes(token);
  const fits = (l) =>
    /(^|\s)(32x32|any)(\s|$)/i.test(l.sizes) ||
    l.type.toLowerCase() === "image/svg+xml";
  const icons = links.filter((l) => has(l, "icon"));
  return [
    ...icons.filter(fits),
    ...[...icons].reverse(),
    ...links.filter((l) => has(l, "apple-touch-icon")),
  ]
    .map((l) => abs(l.href))
    .concat([abs("/favicon.ico")])
    .filter((h, i, a) => h !== "" && a.indexOf(h) === i);
}

/**
 * 画像を読み込み、SIZE×SIZE の PNG の data: URL にする。読めない・CORS で許されない・待ちきれないときは ""。
 * @param {string} href
 * @returns {Promise<string>}
 */
function load(href) {
  return new Promise((resolve) => {
    const img = new Image();
    const done = (v) => {
      clearTimeout(timer);
      img.onload = img.onerror = null;
      resolve(v);
    };
    const timer = setTimeout(() => done(""), WAIT_MS);
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = SIZE;
        c.height = SIZE;
        c.getContext("2d").drawImage(img, 0, 0, SIZE, SIZE);
        done(c.toDataURL("image/png"));
      } catch {
        // CORS で許されていない画像（キャンバスが汚れる）
        done("");
      }
    };
    img.onerror = () => done("");
    if (!href.startsWith("data:") && new URL(href).origin !== location.origin)
      img.crossOrigin = "anonymous";
    img.src = href;
  });
}

/**
 * ページの favicon（PNG の data: URL）。取れなければ ""。
 * 同じページで同じ候補なら、前の答え（読めなかったことも）を返す（題が変わるたびに読み込み直さない）。
 * 前の答えはこの世界の globalThis に置く（ページからは見えない）。
 * @returns {Promise<string>}
 */
async function main() {
  if (location.protocol !== "http:" && location.protocol !== "https:")
    return "";
  const links = Array.from(document.querySelectorAll("link[rel][href]"), (l) => ({
    rel: l.getAttribute("rel") || "",
    sizes: l.getAttribute("sizes") || "",
    type: l.getAttribute("type") || "",
    href: l.getAttribute("href") || "",
  }));
  const list = candidates(links, document.baseURI);
  const memo = globalThis.__kisuiFavicon;
  if (memo && memo.page === location.href && memo.href === list[0])
    return memo.data;
  let data = "";
  for (const href of list) {
    const d = await load(href);
    if (d.startsWith("data:image/png;base64,")) {
      data = d;
      break;
    }
  }
  globalThis.__kisuiFavicon = { page: location.href, href: list[0], data };
  return data;
}
