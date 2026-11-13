import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { MONO_FONT_FAMILY } from "./monoFont.ts";

// ターミナルの字の並び（MONO_FONT_FAMILY）と画面の等幅の字（theme.css の --gh-mono）がずれると、
// ターミナルで出る Nerd Font の字や絵文字が、クリップボードの履歴などで豆腐になる。ずれたらここで落とす。
test("theme.css の --gh-mono は MONO_FONT_FAMILY と同じ並び", () => {
  const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");
  const v = css.match(/--gh-mono:\s*([^;]+);/)?.[1];
  assert.ok(v, "theme.css に --gh-mono が無い");
  const norm = (s: string) =>
    s
      .split(",")
      .map((f) => f.trim().replace(/^["']|["']$/g, ""))
      .join(",");
  assert.equal(norm(v), norm(MONO_FONT_FAMILY));
  // Symbols Nerd Font Mono が JetBrains Mono のすぐ次に無いと、私用領域の字（プロンプトの U+E0A0 など）が OS の代わりの字で出て豆腐になる
  assert.ok(norm(v).startsWith("JetBrains Mono,Symbols Nerd Font Mono,"));
});
