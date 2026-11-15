// 窓（ユーザーの答えを待つダイアログ）の <Show> は keyed にそろえる（#272）。
// keyed でない <Show> の子が受け取るのはアクセサで、窓を閉じた（when を偽にした）あとに読むと
// Solid が「Stale read from <Show>.」を投げる。窓を閉じてから値を使う操作（選ぶ・閉じる・名前を変える）で
// この順番を窓ごとに手で守る作りは、#162 と #272 で 2 回壊れた。
// keyed なら子が受け取るのは値そのもので、閉じたあとでも読める。
// このテストは、App.tsx の <Show> のうち、子が関数のものがすべて keyed であることを確かめる。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/** keyed でなくてよいもの（when の式）と、その理由 */
const NOT_KEYED: Record<string, string> = {
  "loaded()":
    "窓ではない。設定を読んだ結果を出し分けるだけで、閉じる操作が無い",
};

/** src の中の、子が関数の <Show> の開きタグ（`<Show` から `>` まで）を返す */
function functionChildShows(src: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const start = src.indexOf("<Show", from);
    if (start < 0) return out;
    // 開きタグの終わりの `>` を、{ } の中を飛ばして探す
    let depth = 0;
    let i = start + "<Show".length;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    const tag = src.slice(start, i + 1);
    if (/^\s*\{\s*\(/.test(src.slice(i + 1))) out.push(tag);
    from = i + 1;
  }
}

const whenOf = (tag: string) => /when=\{(.*)\}/s.exec(tag)?.[1]?.trim() ?? "";

describe("窓の <Show>", () => {
  it("開きタグを、when の中の > に惑わされずに切り出す", () => {
    const tags = functionChildShows(
      `<Show when={a() > 0} keyed>{(v) => v}</Show><Show when={b()}><p /></Show>`,
    );
    assert.deepEqual(tags, ["<Show when={a() > 0} keyed>"]);
  });

  it("App.tsx の、子が関数の <Show> は keyed（決めた例外を除く）", () => {
    const src = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    const tags = functionChildShows(src);
    assert.ok(tags.length > 0);
    const bad = tags.filter(
      (t) => !/\bkeyed\b/.test(t) && !(whenOf(t) in NOT_KEYED),
    );
    assert.deepEqual(bad, []);
  });
});
