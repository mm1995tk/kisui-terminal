// Dialog（ModalCard）の高さの決め方の見張り（#524）。決まりは card.css の .card-modal の上のコメントと、
// docs/design/design-system.md の「Dialog の枠」の「高さ」。
// Dialog の高さは .card-modal と .card-content だけで決め、Dialog ごとの CSS は高さの決め方を持たない。
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const ui = new URL("../", import.meta.url);

const withoutComments = (css: string): string =>
  css.replace(/\/\*[\s\S]*?\*\//g, "");

/** app/src/ui の下の CSS（ui からの相対の名前 → コメントを除いた中身）。 */
function cssFiles(dir: URL, base = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const name = base + e.name;
    if (e.isDirectory())
      Object.assign(out, cssFiles(new URL(`${e.name}/`, dir), `${name}/`));
    else if (e.name.endsWith(".css"))
      out[name] = withoutComments(readFileSync(new URL(e.name, dir), "utf8"));
  }
  return out;
}

/** 前置き（セレクタ）がちょうど selector の規則の、宣言（名前 → 値）。css はコメントを除いたもの。 */
function declarations(css: string, selector: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1]!.trim() !== selector) continue;
    for (const d of m[2]!.split(";")) {
      const i = d.indexOf(":");
      if (i > 0) out.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
    }
  }
  return out;
}

/** app/src/ui の下の tsx（ui からの相対の名前 → 中身）。 */
function tsxFiles(dir: URL, base = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const name = base + e.name;
    if (e.isDirectory())
      Object.assign(out, tsxFiles(new URL(`${e.name}/`, dir), `${name}/`));
    else if (e.name.endsWith(".tsx") && !e.name.endsWith(".stories.tsx"))
      out[name] = readFileSync(new URL(e.name, dir), "utf8");
  }
  return out;
}

/** text の中の `status={ … }`（波括弧の釣り合う所まで）を取り除く。 */
function withoutStatus(text: string): string {
  let out = text;
  for (;;) {
    const i = out.indexOf("status={");
    if (i < 0) return out;
    let depth = 0;
    let j = i + "status=".length;
    for (; j < out.length; j++) {
      if (out[j] === "{") depth++;
      else if (out[j] === "}" && --depth === 0) break;
    }
    out = out.slice(0, i) + out.slice(j + 1);
  }
}

const files = cssFiles(ui);
const card = files["components/card.css"]!;

describe("Dialog の高さの決め方", () => {
  it("Dialog は中身の高さで、上限は max-height", () => {
    const d = declarations(card, ".card-modal");
    assert.equal(d.get("height"), "fit-content");
    assert.ok(d.has("max-height"));
  });

  it("中身の段は flex-basis が auto（0% を 0 と解く WebView で、高さが 0 にならない）", () => {
    const d = declarations(card, ".card-content");
    assert.equal(d.get("flex"), "1 1 auto");
    assert.equal(d.get("min-height"), "0");
  });

  it("中身の段の子は縮まない（Dialog に収まらない分は中身の段がスクロールする）", () => {
    assert.equal(
      declarations(card, ":where(.card-content > *)").get("flex"),
      "none",
    );
  });

  it("Dialog の高さを書き替えるのは、高さを固定する Workspace switcher だけ", () => {
    const owners = Object.entries(files)
      .filter(([name]) => name !== "components/card.css")
      .filter(([, css]) => /\.card-(modal|content)\b/.test(css))
      .map(([name]) => name);
    assert.deepEqual(owners, ["main-window/workspaces/switcher.css"]);
  });

  it("中身の直下の一覧だけは縮む（一覧が Dialog の高さを使い切るとき、一覧の中だけがスクロールする。#524）", () => {
    assert.equal(
      declarations(card, ".card-content > .card-rows").get("flex"),
      "0 1 auto",
    );
  });

  it("縮む一覧にも、行が見える下限の高さがある（短い窓で 0 行にならない）", () => {
    assert.equal(
      declarations(card, ".card-content > .card-rows:has(> li)").get(
        "min-height",
      ),
      "56px",
    );
    assert.equal(
      declarations(
        card,
        ".card-content > .card-rows:has(> li:nth-child(3))",
      ).get("min-height"),
      "120px",
    );
  });
});

describe("Dialog の status の段（できなかった理由・今の状態の文。#524）", () => {
  it("status の段は動かず、上に線を引く（中身がスクロールしても見えたまま）", () => {
    const d = declarations(card, ".card-status");
    assert.equal(d.get("flex"), "none");
    assert.ok(d.has("border-top"));
  });

  it("ModalCard は status を中身と footer の間に出す", () => {
    const tsx = readFileSync(new URL("components/Card.tsx", ui), "utf8");
    const at = (s: string) => tsx.indexOf(s);
    assert.ok(at('class="card-content"') < at('class="card-status"'));
    assert.ok(at('class="card-status"') < at("<CardFooter>{footer()}"));
  });

  it("ModalCard の Dialog は、できなかった理由（CardError）を中身に置かず status に渡す", () => {
    const bad = Object.entries(tsxFiles(ui))
      .filter(([, text]) => text.includes("<ModalCard"))
      .filter(([, text]) => withoutStatus(text).includes("<CardError"))
      .map(([name]) => name);
    assert.deepEqual(bad, []);
  });
});
