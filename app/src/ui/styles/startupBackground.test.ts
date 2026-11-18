import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// 起動時の背景色は、描画の前から効かせるため複数の場所に同じ値がある。ずれたらここで落とす。
const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8");

describe("起動時の背景色", () => {
  it("theme.css の --gh-bg・tauri.conf.json の backgroundColor・index.html・ui/main-window/content/terminal/theme.ts が同じ値", () => {
    const css = read("./theme.css").match(/--gh-bg:\s*(#[0-9a-fA-F]{6})/)?.[1];
    assert.ok(css, "theme.css に --gh-bg が無い");
    const want = css.toLowerCase();

    const conf = JSON.parse(read("../../../src-tauri/tauri.conf.json"));
    assert.equal(conf.app.windows[0].backgroundColor.toLowerCase(), want);

    const html = read("../../../index.html");
    const inline = [
      ...html.matchAll(
        /<(?:html|body)[^>]*style="[^"]*background:\s*(#[0-9a-fA-F]{6})/g,
      ),
    ];
    assert.equal(
      inline.length,
      2,
      "html と body の両方にインラインの背景が要る",
    );
    for (const m of inline) assert.equal(m[1].toLowerCase(), want);

    const term = read("../main-window/content/terminal/theme.ts").match(
      /background:\s*"(#[0-9a-fA-F]{6})"/,
    )?.[1];
    assert.equal(term?.toLowerCase(), want);
  });
});

describe("ページの上に重ねる間（data-page-overlay。#255）", () => {
  it("html と body のインラインの背景を !important で透かす（無いと、ページの場所が塗られてページが見えない）", () => {
    const css = read("../main-window/content/browser/browser.css");
    const rule = css.match(
      /html\[data-page-overlay\],\s*html\[data-page-overlay\] body\s*\{([^}]*)\}/,
    );
    assert.ok(rule, "html と body の両方を透かす規則が無い");
    assert.match(rule[1], /background:\s*transparent\s*!important/);
  });
});
