// メインウィンドウの CSS の並びの見張り（#313）。
// CSS は部品ごとのファイルに分けてあり、ビルドすると、部品を import した順に 1 つのファイルへ並ぶ。
// 同じ強さの規則は後のものが勝つので、import の順を変えると見た目が変わりうる（分ける前の App.tsx のときから、順はこの並びだった）。
// 部品の import を並べ替えた・部品を足した人が、気づかずに順を変えないよう、page.tsx からたどった順を確かめる。
// 順を変えるときは、見た目を確かめたうえで、ここの並びも直す。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path/posix";
import { describe, it } from "node:test";

const src = new URL("../../", import.meta.url);

/** ソースの中の、動かすときに読む import（型だけの import は、ビルドで消えるので除く）。書いた順。 */
export function runtimeImports(text: string): string[] {
  const out: string[] = [];
  const re = /^import\s+(type\s+)?(?:[^;"]*?\sfrom\s+)?"([^"]+)";/gm;
  for (const m of text.matchAll(re)) if (!m[1]) out.push(m[2]!);
  return out;
}

/** entry（app/src からの相対）から import を書いた順にたどり、初めて出会った順に CSS を並べる（ESM が動く順と同じ、深さ優先）。 */
function cssOrder(entry: string): string[] {
  const seen = new Set<string>();
  const css: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    if (file.endsWith(".css")) {
      css.push(file);
      return;
    }
    const url = new URL(file, src);
    if (!/\.tsx?$/.test(file) || !existsSync(url)) return;
    for (const spec of runtimeImports(readFileSync(url, "utf8")))
      if (spec.startsWith("."))
        visit(path.normalize(path.join(path.dirname(file), spec)));
  };
  visit(entry);
  return css;
}

describe("メインウィンドウの CSS の並び", () => {
  it("動かすときに読む import を、書いた順に取り出す（型だけの import は除く）", () => {
    assert.deepEqual(
      runtimeImports(
        [
          `import { a } from "./a.ts";`,
          `import type { B } from "./b.ts";`,
          `import {\n  c,\n  type C,\n} from "./c.tsx";`,
          `import "./d.css";`,
          `import styles from "./e.module.css";`,
        ].join("\n"),
      ),
      ["./a.ts", "./c.tsx", "./d.css", "./e.module.css"],
    );
  });

  it("page.tsx からたどった CSS の順は、分ける前（App.tsx）と同じ", () => {
    assert.deepEqual(cssOrder("ui/main-window/page.tsx"), [
      // カードの決まり（窓・知らせ）。常駐ツールの画面と共に使うので、ビルドでは別のファイルになる
      "ui/components/card.css",
      "ui/main-window/commands/KeyListDialog.module.css",
      "ui/main-window/notifications/CopiedToast.module.css",
      "ui/main-window/notifications/ScaleToast.module.css",
      "ui/main-window/sidebar/changes/changes.css",
      "ui/main-window/sidebar/file-tree/tree.css",
      "ui/main-window/sidebar/sidebar.css",
      "ui/main-window/workspaces/switcher.css",
      "ui/main-window/layout.css",
      "ui/main-window/content/browser/browser.css",
      "ui/main-window/commands/LeaderMenu.module.css",
      // 字の定義（@font-face だけ）。起動のときに index.tsx が先に読むので、実際にはいちばん先に並ぶ
      "ui/styles/jetbrains-mono.css",
      "ui/styles/symbols-nerd-font.css",
      "ui/main-window/content/terminal/terminal.css",
    ]);
  });
});
