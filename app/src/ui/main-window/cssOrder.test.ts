// メインウィンドウの CSS の並びの見張り（#313）。
// CSS は部品ごとのファイルに分けてあり、ビルドすると、部品を import した順に 1 つのファイルへ並ぶ。
// 同じ強さの規則は後のものが勝つので、import の順を変えると見た目が変わりうる。
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

/**
 * 「このクラスだけ」を相手にする規則（.a、.a:hover、.a[data-x]）のクラス名。
 * 親の文脈つきの規則（.x .a）は、別のファイルの部品を、この場所だけ飾り替える書き方なので、数えない。
 * コメント・@ の規則・括弧の中は見ない。
 */
export function baseClasses(css: string): string[] {
  const out: string[] = [];
  const text = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/:(?:has|not|is|where)\([^()]*\)/g, "&")
    .replace(/\([^()]*\)/g, "")
    .replace(/\[[^\]]*\]/g, "");
  for (const m of text.matchAll(/([^{};]+)\{/g)) {
    const prelude = m[1]!.trim();
    if (prelude.startsWith("@")) continue;
    for (const sel of prelude.split(",")) {
      const c = /^\.([A-Za-z_][\w-]*)(?::{1,2}[\w-]+)*$/.exec(sel.trim());
      if (c) out.push(c[1]!);
    }
  }
  return out;
}

/** 2 つ以上のファイルが、規則の単独の相手として書いているクラス名（クラス名 → ファイルの一覧）。 */
export function sharedClasses(
  files: Record<string, string>,
): Map<string, string[]> {
  const owners = new Map<string, Set<string>>();
  for (const [file, css] of Object.entries(files))
    for (const c of baseClasses(css)) {
      const set = owners.get(c) ?? new Set<string>();
      set.add(file);
      owners.set(c, set);
    }
  const out = new Map<string, string[]>();
  for (const [c, set] of owners) if (set.size > 1) out.set(c, [...set].sort());
  return out;
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

  it("page.tsx からたどった CSS の順は、決めた並びのとおり", () => {
    assert.deepEqual(cssOrder("ui/main-window/page.tsx"), [
      // ボタン（.button の規則だけを持ち、ほかの CSS と規則が重ならないので、カードとの前後は見た目に関わらない）
      "ui/components/button.css",
      // カードの決まり（窓・知らせ）。常駐ツールの画面と共に使うので、ビルドでは別のファイルになる
      "ui/components/card.css",
      "ui/main-window/commands/KeyListDialog.module.css",
      "ui/main-window/notifications/CopiedToast.module.css",
      "ui/main-window/notifications/ScaleToast.module.css",
      "ui/main-window/sidebar/changes/changes.css",
      // その場の入力欄（.inline-* の規則だけを持ち、置き場のツリー・サイドバー・切り替える窓の規則と重ならない）
      "ui/components/inline-input.css",
      "ui/main-window/sidebar/file-tree/tree.css",
      // キー操作のヒント（.key-hint・.kbd の規則だけを持ち、置き場の窓の規則と重ならない）。サイドバーの DB のタブの木が先に読む
      "ui/components/key-hints.css",
      // サイドバーの DB のタブの木（#374。CSS Modules なので、クラス名はほかと重ならない）
      "ui/main-window/sidebar/db-tree/DbTree.module.css",
      "ui/main-window/sidebar/sidebar.css",
      "ui/main-window/workspaces/switcher.css",
      "ui/main-window/layout.css",
      "ui/main-window/content/browser/browser.css",
      "ui/main-window/commands/LeaderMenu.module.css",
      // 字の定義（@font-face だけ）。起動のときに index.tsx が先に読むので、実際にはいちばん先に並ぶ
      "ui/styles/jetbrains-mono.css",
      "ui/styles/symbols-nerd-font.css",
      "ui/main-window/content/terminal/terminal.css",
      "ui/main-window/content/EmptyWorkspace.module.css",
      // DB のタブの画面（#347。CSS Modules なので、クラス名はほかと重ならない）
      "ui/main-window/content/db/DbTabView.module.css",
      // エージェントの SQL で上書きしてよいかを聞く窓（#382。CSS Modules なので、クラス名はほかと重ならない）
      "ui/main-window/db/DbProposeDialog.module.css",
    ]);
  });

  // #339: 切り替える窓の .newtab が、内蔵ブラウザの新しいタブのページの .newtab（browser.css。position: absolute）と
  // 同じ強さで重なり、あとから読む browser.css が勝って、タブを作る行がつぶれた。
  // 同じクラス名を 2 つのファイルが飾ると、読む順で見た目が変わるので、ファイルごとにクラス名を分ける。
  it("同じクラス名を、2 つ以上の CSS ファイルが規則の相手にしていない", () => {
    const files: Record<string, string> = {};
    for (const f of cssOrder("ui/main-window/page.tsx"))
      if (!f.endsWith(".module.css"))
        files[f] = readFileSync(new URL(f, src), "utf8");
    // 既に 2 つのファイルにまたがっているもの。足さない（別の Issue で分ける）
    const known = new Set([
      // ::after の棒を、sidebar.css と changes.css の両方が書いている（どちらも .changes-resizer::after）
      "changes-resizer",
    ]);
    const shared = [...sharedClasses(files)].filter(([c]) => !known.has(c));
    assert.deepEqual(shared, []);
  });

  it("2 つのファイルが同じクラス名を飾っていると見つける", () => {
    assert.deepEqual(
      [
        ...sharedClasses({
          "a.css": ".newtab { position: relative; }\n.x .y { color: red; }",
          "b.css":
            "/* .y */\n.newtab,\n.z:hover { inset: 0; }\n@media (a) { .w { top: 0 } }",
        }),
      ],
      [["newtab", ["a.css", "b.css"]]],
    );
  });

  it("属性つき・:hover つきは数え、:has() の中や子孫の規則は数えない", () => {
    assert.deepEqual(
      baseClasses(
        [
          '.c[data-x="1"] { top: 0 }',
          ".h:hover { top: 0 }",
          ".d:has(.e) { top: 0 }",
          ".p .q { top: 0 }",
        ].join("\n"),
      ),
      ["c", "h"],
    );
  });
});
