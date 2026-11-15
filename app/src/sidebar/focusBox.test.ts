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

test("帯はいつも箱（li）で、フォーカスしていると枠と見出しの色が変わる", () => {
  assert.match(tsx, /<li\s+class="band-item"[^>]*data-focused=/);
  assert.match(rule(".band-item"), /border: 1px solid var\(--gh-/);
  assert.match(rule(".band-item[data-focused]"), /border-color: var\(--gh-/);
});

test("箱の色は --gh-* だけで、黄色とマシンの色は使わない", () => {
  const box = rule(".band-item[data-focused]");
  assert.doesNotMatch(box, /yellow|machine-color/);
});

test("選んでも帯の位置と高さが変わらない：フォーカスの規則は色だけを変え、余白・枠の太さ・高さ・字の太さは変えない（#234）", () => {
  const box = rule(".band-item[data-focused]");
  assert.doesNotMatch(
    box,
    /^\s*(margin|padding|border|border-width|height|font-weight|display)\s*:/m,
  );
  // 固定するヘッダーも、固定していないヘッダーと同じ高さ（規則を分けない）
  assert.doesNotMatch(rule(".band-slot[data-sticky]"), /height|padding|margin/);
  assert.doesNotMatch(css, /\.band\[aria-current="true"\] \{/);
});

test("鉛筆・✕・「+」はいつも出す（#258）。つかむ所と押せないボタンは、出ていないときも場所を空ける（opacity か visibility で隠し、display で消さない）", () => {
  // どの規則も、鉛筆・✕・「+」（.band-btn / .band-close / .band-add / .band-edit / .tab-edit）を opacity: 0 で隠さない
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g))
    if (/band-btn|band-close|band-add|band-edit|tab-edit/.test(m[1]!))
      assert.doesNotMatch(m[2]!, /opacity: 0;/, `${m[1]!.trim()} が隠している`);
  // visibility: hidden で隠すのは、押せないボタン（data-off）だけ
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g))
    if (/visibility: hidden/.test(m[2]!))
      assert.match(
        m[1]!,
        /\[data-off\]/,
        `${m[1]!.trim()} が visibility: hidden`,
      );
  assert.match(rule(".grip"), /opacity: 0;/);
  assert.match(rule(".band-btn[data-off]"), /visibility: hidden;/);
  for (const sel of [".grip", ".band-btn[data-off]"])
    assert.doesNotMatch(rule(sel), /display: none/);
  // つかむ所の幅は 6px
  assert.match(rule(".grip"), /width: 6px;/);
});

test("箱は overflow: clip で中身を角に切り取る（hidden / auto は sticky を壊す）", () => {
  const box = rule(".band-item");
  assert.match(box, /overflow: clip;/);
  assert.doesNotMatch(box, /overflow: (hidden|auto|scroll)/);
});

test("ヘッダーとコンテンツの境目に太い線があり、マシンの色の縦線は無い（#234）", () => {
  assert.match(rule(".band-slot"), /border-bottom: 2px solid/);
  assert.doesNotMatch(rule(".band-item"), /border-left|machine-color/);
});

test("ファイルツリーと CHANGES は、今出しているターミナルのタブの行の中に開き、タブの並びを畳んでいてもヘッダーの下に出る", () => {
  const panes = tsx.slice(tsx.indexOf("function RowPanes"));
  assert.ok(panes.indexOf("<TreeView") < panes.indexOf("<ChangesView"));
  const item = tsx.slice(
    tsx.indexOf("function BandItem"),
    tsx.indexOf("function TabRow"),
  );
  // 開いているときはタブの行（TabRow）の中、畳んでいるとき（Show の fallback）はヘッダーの下
  assert.match(item, /fallback=\{<RowPanes \{\.\.\.props\} \/>\}/);
  assert.match(
    item,
    /<TabRow[\s\S]*<RowPanes \{\.\.\.props\} \/>[\s\S]*<\/TabRow>/,
  );
  // ツリーと CHANGES の部品は、畳むかどうかを知らない
  assert.doesNotMatch(
    tsx.slice(
      tsx.indexOf("function RowPanes"),
      tsx.indexOf("function BandItem"),
    ),
    /folded/,
  );
});

test("断られた理由は流れの中に置き、箱の clip で切り取られない（#172）", () => {
  const err = rule(".band-rename-error");
  assert.doesNotMatch(err, /position: (absolute|fixed)/);
  assert.match(err, /white-space: normal;/);
  assert.doesNotMatch(err, /text-overflow|nowrap/);
  // 理由の要素は、帯（.band-slot）の外・箱（li.band-item）の中に置く
  const slotEnd = tsx.indexOf("<BandHeader {...props}");
  assert.notEqual(slotEnd, -1);
  assert.ok(tsx.indexOf('class="band-rename-error"') > slotEnd);
});
