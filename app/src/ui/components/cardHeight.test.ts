// Dialog（ModalCard）の高さの決め方の見張り（#524）。決まりは card.css の .card-modal の上のコメントと、
// docs/design/design-system.md の「Dialog の枠」の「高さ」。
// Dialog の高さは .card-modal と .card-content だけで決め、Dialog ごとの CSS は高さの決め方を持たない。
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const ui = new URL("../", import.meta.url);

/** app/src/ui の下の CSS（ui からの相対の名前 → 中身）。 */
function cssFiles(dir: URL, base = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const name = base + e.name;
    if (e.isDirectory())
      Object.assign(out, cssFiles(new URL(`${e.name}/`, dir), `${name}/`));
    else if (e.name.endsWith(".css"))
      out[name] = readFileSync(new URL(e.name, dir), "utf8");
  }
  return out;
}

/** 前置き（セレクタ）がちょうど selector の規則の、宣言（名前 → 値）。コメントは見ない。 */
function declarations(css: string, selector: string): Map<string, string> {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Map<string, string>();
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1]!.trim() !== selector) continue;
    for (const d of m[2]!.split(";")) {
      const i = d.indexOf(":");
      if (i > 0) out.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
    }
  }
  return out;
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
      .filter(([, css]) =>
        /\.card-(modal|content)\b/.test(css.replace(/\/\*[\s\S]*?\*\//g, "")),
      )
      .map(([name]) => name);
    assert.deepEqual(owners, ["main-window/workspaces/switcher.css"]);
  });
});
