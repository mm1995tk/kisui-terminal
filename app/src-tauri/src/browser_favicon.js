// 内蔵ブラウザのタブ（browser.rs）のページの favicon を読む（favicon.rs。#237）。
// 殻がページの読み込みの終わり・題の変化のたびに、ページの外の世界（isolated world。ページのスクリプトからは見えず、
// ページが DOM の関数を差し替えても効かない）で、この関数を呼ぶ。返した文字を殻が受ける。
// ページの <link rel="icon"> を選び、無ければ（読めなければ）/favicon.ico を、ページの中で読み込み、32×32 の PNG の
// data: URL にして返す。読み込むのはページ自身（ページと同じデータ。シークレットのタブはディスクに残さないデータ）。
// 外の origin の画像は、CORS で許されたものだけ読める（許されなければ次の候補へ。どれも駄目なら "" を返し、画面は地球のアイコンを出す）。
async () => {
  const SIZE = 32;
  const WAIT_MS = 5000;
  if (location.protocol !== "http:" && location.protocol !== "https:")
    return "";
  const abs = (href) => {
    try {
      const u = new URL(href, document.baseURI);
      return u.protocol === "http:" ||
        u.protocol === "https:" ||
        u.protocol === "data:"
        ? u.href
        : "";
    } catch {
      return "";
    }
  };
  const rels = (l) => (l.getAttribute("rel") || "").toLowerCase().split(/\s+/);
  const links = Array.from(document.querySelectorAll("link[rel][href]"));
  const icons = links.filter((l) => rels(l).includes("icon"));
  // 32×32 に合うもの（大きさの指定が 32x32 か any、または SVG）を先に、無ければ後に書いたもの（ふつうのブラウザと同じ）
  const fits = (l) =>
    /(^|\s)(32x32|any)(\s|$)/i.test(l.getAttribute("sizes") || "") ||
    (l.getAttribute("type") || "").toLowerCase() === "image/svg+xml";
  const candidates = [
    ...icons.filter(fits),
    ...[...icons].reverse(),
    ...links.filter((l) => rels(l).includes("apple-touch-icon")),
  ]
    .map((l) => abs(l.getAttribute("href") || ""))
    .concat([abs("/favicon.ico")])
    .filter((h, i, a) => h !== "" && a.indexOf(h) === i);
  // 同じページで同じ候補なら、前の答え（読めなかったことも）を返す（題が変わるたびに読み込み直さない）。
  // この世界の外（ページ）からは見えない
  const memo = globalThis.__kisuiFavicon;
  if (memo && memo.page === location.href && memo.href === candidates[0])
    return memo.data;
  const remember = (data) => {
    globalThis.__kisuiFavicon = {
      page: location.href,
      href: candidates[0],
      data,
    };
    return data;
  };
  const load = (href) =>
    new Promise((resolve) => {
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
  for (const href of candidates) {
    const data = await load(href);
    if (data.startsWith("data:image/png;base64,")) return remember(data);
  }
  return remember("");
};
