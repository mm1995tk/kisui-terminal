import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// DOM を立てるテストの道具は無いので、CSS と TSX の文面で、フォーカスしているワークスペースの箱（#170）の決まりを確かめる。
const css = readFileSync(new URL("./sidebar.css", import.meta.url), "utf8");
// サイドバーの部品のソース。上から、一覧 → 帯のヘッダー → ファイルツリーと CHANGES の段 → 帯 → タブの行 → 小さな部品の順につなぐ
// （下のテストが、部品の並びの中の位置で確かめるため）
const tsx = [
  "./Sidebar.tsx",
  "./workspaces/BandHeader.tsx",
  "./Panes.tsx",
  "./workspaces/BandItem.tsx",
  "./workspaces/TabRow.tsx",
  "./workspaces/parts.tsx",
  "./PopupMenu.tsx",
  "./handlers.ts",
]
  .map((f) => readFileSync(new URL(f, import.meta.url), "utf8"))
  .join("\n");

/** セレクタが selector の規則の中身（最初の 1 つ）を返す */
function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} の規則が無い`);
  return css.slice(css.indexOf("{", start), css.indexOf("}", start));
}

test("帯は平ら（li）で、枠・角の丸み・周りの余白が無く、フォーカスしていると見出しの色が変わる（#297）", () => {
  assert.match(tsx, /<li\s+class="band-item"[^>]*data-focused=/);
  assert.doesNotMatch(
    rule(".band-item"),
    /^\s*(border|border-radius|margin|overflow)\s*:/m,
  );
  assert.match(rule(".band-item[data-focused]"), /--head-bg: /);
  assert.doesNotMatch(rule(".band-item[data-focused]"), /^\s*border/m);
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

test("帯は overflow の入れ物を作らない（hidden / auto は中の sticky を壊す）", () => {
  assert.doesNotMatch(rule(".band-item"), /overflow/);
});

test("切り替えのボタンは、名前から ⇄ までが 1 つで、「n / N」と ▾ は出さない（#297）", () => {
  assert.match(tsx, /<SwitchIcon \/>/);
  assert.doesNotMatch(tsx, /band-pos|ICON\.down/);
  assert.match(rule(".band-switch"), /border-right: 1px solid/);
});

test("ヘッダーとコンテンツの境目に太い線があり、マシンの色の縦線は無い（#234）", () => {
  assert.match(rule(".band-slot"), /border-bottom: 2px solid/);
  assert.doesNotMatch(rule(".band-item"), /border-left|machine-color/);
});

test("shj が動いているときは、タブの段の下に、ファイルツリーの段と CHANGES を別の段で出す（#284）", () => {
  const panes = tsx.slice(
    tsx.indexOf("function Panes"),
    tsx.indexOf("function BandItem"),
  );
  assert.ok(panes.indexOf("<TreeView") < panes.indexOf("<ChangesView"));
  // ファイルツリーは、スクロールする段（.tree-section）の中。CHANGES はその外（段の下）
  assert.ok(panes.indexOf("tree-section") < panes.indexOf("<TreeView"));
  assert.ok(panes.indexOf("<TreeView") < panes.indexOf("</div>\n      <Show"));
  const item = tsx.slice(
    tsx.indexOf("function BandItem"),
    tsx.indexOf("export function TabRow"),
  );
  // タブの行の中には開かない。タブの段（ul.tab-rows）の次の兄弟として出す
  assert.doesNotMatch(item, /<TabRow[\s\S]*<Panes[\s\S]*<\/TabRow>/);
  assert.match(item, /<\/ul>\s*<Show when=\{sections\(\)\}>\s*<Panes /);
  assert.match(rule(".tree-section"), /overflow-y: auto;/);
  assert.match(
    rule(".band-item[data-sections] > .tab-rows"),
    /overflow-y: auto;/,
  );
  assert.match(
    rule(".band-item[data-sections] > .tab-rows"),
    /max-height: calc\(var\(--tabs-h, 40\) \* 1%\);/,
  );
  // タブの並びを畳む仕組みは無い（#283）
  assert.doesNotMatch(tsx, /folded|onTabsFold/);
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
