// 窓（ユーザーの答えを待つダイアログ）とメニューの <Show> は keyed にそろえる（#272）。
// keyed でない <Show> の子が受け取るのはアクセサで、窓を閉じた（when を偽にした）あとに読むと
// Solid が「Stale read from <Show>.」を投げる。窓を閉じてから値を使う操作（選ぶ・閉じる・名前を変える）で
// この順番を窓ごとに手で守る作りは、#162 と #272 で 2 回壊れた。
// keyed なら子が受け取るのは値そのもので、閉じたあとでも読める。
//
// このテストは、app/src の .tsx の <Show when={x()}> のうち、子が関数で、同じファイルに setX(null)
// （その signal を空にして閉じる操作）があるものが、すべて keyed であることを確かめる。
// 出している間に値が変わる表示（リーダーのメニューの道筋、マスコットの絵など）は、閉じる操作を
// 同じファイルに持たないので当たらない。そうした表示は keyed にすると変わるたびに作り直すので、keyed にしない。
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

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

/** 開きタグの when={...} の中身（空白をつめたもの） */
function whenOf(tag: string): string {
  const at = tag.indexOf("when={");
  if (at < 0) return "";
  let depth = 0;
  for (let i = at + "when=".length; i < tag.length; i++) {
    if (tag[i] === "{") depth++;
    else if (tag[i] === "}" && --depth === 0)
      return tag
        .slice(at + "when={".length, i)
        .replace(/\s+/g, " ")
        .trim();
  }
  return "";
}

/**
 * 窓の形に当たるが、窓ではないもの（ファイル → when の式 → 理由）。
 * 出している間に値が変わり続ける表示で、keyed にすると変わるたびに作り直してしまう。
 */
const NOT_WINDOWS: Record<string, Record<string, string>> = {
  "MascotCarrier.tsx": {
    "frame()": "マスコットの絵のこま。動いている間、絵が替わるたびに値が変わる",
  },
};

/** src の中の、窓の形（when={x()} で、setX(null) で閉じる）なのに keyed でない <Show> の開きタグ */
function unkeyedWindows(
  src: string,
  notWindows: Record<string, string> = {},
): string[] {
  return functionChildShows(src).filter((tag) => {
    if (/\bkeyed\b/.test(tag) || whenOf(tag) in notWindows) return false;
    const name = /^(\w+)\(\)$/.exec(whenOf(tag))?.[1];
    if (!name) return false;
    const setter = `set${name[0].toUpperCase()}${name.slice(1)}`;
    return src.includes(`${setter}(null)`);
  });
}

describe("窓の <Show>", () => {
  it("開きタグを、when の中の > に惑わされずに切り出す", () => {
    const tags = functionChildShows(
      `<Show when={a() > 0} keyed>{(v) => v}</Show><Show when={b()}><p /></Show>`,
    );
    assert.deepEqual(tags, ["<Show when={a() > 0} keyed>"]);
  });

  it("setX(null) で閉じる <Show when={x()}> を、keyed でなければ見つける", () => {
    const src = [
      `<Show when={menu()}>{(m) => <Menu onClose={() => setMenu(null)} />}</Show>`,
      `<Show when={done()} keyed>{(d) => <Card onNo={() => setDone(null)} />}</Show>`,
      `<Show when={frame()}>{(f) => <img src={f()} />}</Show>`,
    ].join("\n");
    assert.deepEqual(unkeyedWindows(src), ["<Show when={menu()}>"]);
  });

  const root = new URL("./", import.meta.url);
  const files = readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".tsx"))
    .sort();

  it("app/src の .tsx を読んでいる", () => {
    assert.ok(files.includes("App.tsx"));
  });

  for (const file of files) {
    it(`${file} の、窓の <Show> は keyed`, () => {
      const src = readFileSync(new URL(file, root), "utf8");
      assert.deepEqual(unkeyedWindows(src, NOT_WINDOWS[file]), []);
    });
  }
});
