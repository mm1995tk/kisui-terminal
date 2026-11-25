// プロキシのパネルの並び（PanelBar.tsx）の見張り（#422）。
// 並べ方（右に寄せる・折り返す・字を折らない）は ProxyPanel.module.css の .bar の段だけで決める。
// 並びの場所ごとの規則に並べ方を書き足すと、狭い幅・日本語での崩れを、並びごとに手で直すことに戻るので、ここで落とす。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const css = readFileSync(
  new URL("./ProxyPanel.module.css", import.meta.url),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** 規則（セレクタと中身）を、書いた順に。@ の規則の中も、1 段だけ開いて数える。 */
function rules(text: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g))
    out.push({
      selector: m[1]!.trim().replace(/^@[^{]*\{\s*/, ""),
      body: m[2]!,
    });
  return out;
}

/** 並びの場所ごとの規則（PanelBar に class で渡すもの）と、並びの中に置くもの */
const placed = [
  "head",
  "heldBar",
  "editHead",
  "holding",
  "holdButton",
  "heldNote",
];

describe("プロキシのパネルの並び", () => {
  it("右に寄せる・中身を寄せるのは .bar の段だけ", () => {
    for (const { selector, body } of rules(css)) {
      if (/^\.bar/.test(selector)) continue;
      assert.doesNotMatch(
        body,
        /margin-left:\s*auto|justify-content:\s*(?:space-between|flex-end)/,
        `${selector} は右に寄せる並びを自分で書いている。PanelBar.tsx を使う`,
      );
    }
  });

  it("並びの場所ごとの規則は、並べ方（display・折り返し・寄せ方・間・white-space）を書かない", () => {
    for (const { selector, body } of rules(css)) {
      const own = selector
        .split(",")
        .map((s) => /^\.([\w-]+)(?:[:[].*)?$/.exec(s.trim())?.[1]);
      if (!own.some((c) => c && placed.includes(c))) continue;
      assert.doesNotMatch(
        body,
        /(?:^|;|\s)(?:display|flex-wrap|flex-direction|align-items|justify-content|gap|white-space|min-width)\s*:/,
        `${selector} が並べ方を書いている。並べ方は .bar の段に書く`,
      );
    }
  });
});
