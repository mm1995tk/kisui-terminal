// 窓のすべての入力欄（input・textarea）に、打った字をそのまま通す属性を付ける。
// macOS の WKWebView は、属性の無い欄で文の始めを大文字にしたり、綴りを直したりする（#481）。
// この窓の欄は名前・URL・パス・SQL などで、文章ではない。欄ごとに属性を付ける作りだと、付け忘れた欄で
// 起きるので、欄が DOM に入ったときに、ここでまとめて付ける。欄が自分で付けた属性（明示した値）は上書きしない。

/** 属性を読み書きできるもの（DOM の Element のうち、ここで使う部分） */
export interface AttrTarget {
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
}

const DEFAULTS: ReadonlyArray<readonly [string, string]> = [
  ["autocapitalize", "off"],
  ["autocorrect", "off"],
  ["spellcheck", "false"],
];

/** 欄に、まだ無い属性だけを付ける */
export function applyTextInputDefaults(el: AttrTarget): void {
  for (const [name, value] of DEFAULTS) {
    if (!el.hasAttribute(name)) el.setAttribute(name, value);
  }
}

const SELECTOR = "input, textarea";

/** doc の今ある欄と、これから入る欄すべてに applyTextInputDefaults を当てる */
export function watchTextInputs(doc: Document): void {
  const visit = (node: Node): void => {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (el.matches(SELECTOR)) applyTextInputDefaults(el);
    el.querySelectorAll(SELECTOR).forEach(applyTextInputDefaults);
  };
  visit(doc.documentElement);
  new MutationObserver((records) => {
    for (const r of records) r.addedNodes.forEach(visit);
  }).observe(doc.documentElement, { childList: true, subtree: true });
}
