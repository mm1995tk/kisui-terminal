import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// DOM を立てるテストの道具は無いので、CSS と TSX の文面で、フォーカスしているワークスペースの箱（#170）の決まりを確かめる。
const css = readFileSync(new URL("./sidebar.css", import.meta.url), "utf8");
const tsx = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");

/** セレクタが selector の規則の中身（最初の 1 つ）を返す */
function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} の規則が無い`);
  return css.slice(css.indexOf("{", start), css.indexOf("}", start));
}

test("フォーカスしている帯・ツリー・CHANGES は 1 つの箱（li）に入る", () => {
  assert.match(tsx, /<li class="band-item" data-focused=/);
  assert.match(
    rule(".band-item[data-focused]"),
    /border: 1px solid var\(--gh-/,
  );
});

test("箱の色は --gh-* だけで、黄色とマシンの色は使わない", () => {
  const box = rule(".band-item[data-focused]");
  assert.doesNotMatch(box, /yellow|machine-color/);
  assert.doesNotMatch(rule('.band[aria-current="true"]'), /color|border/);
});

test("固定した帯の見出しの背景は箱と同じ色", () => {
  assert.match(
    rule(".band-item[data-focused] > .band-slot"),
    /background: var\(--focus-box-bg\)/,
  );
});

test("箱は overflow: clip で中身を角に切り取る（hidden / auto は sticky を壊す）", () => {
  const box = rule(".band-item[data-focused]");
  assert.match(box, /overflow: clip;/);
  assert.doesNotMatch(box, /overflow: (hidden|auto|scroll)/);
});
