// app/src の配置と依存の向きの見張り（#313。決まりは docs/design/frontend-structure.md）。
// ファイルを足したり移したりした人が、機能（features/）に画面や Tauri を持ち込んだり、
// 画面（ui/）から外の実装（infrastructure/）を直に読んだりしないようにする。
// ソースの import の文面を読んで確かめる（node --test は JSX を読めないので、動かさずに読む）。
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path/posix";
import { describe, it } from "node:test";

const root = new URL("./", import.meta.url);

/** app/src の .ts・.tsx（テストは除く）。パスは app/src からの相対（区切りは /）。 */
const files = readdirSync(root, { recursive: true, encoding: "utf8" })
  .map((f) => f.replaceAll("\\", "/"))
  .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
  .sort();

/** ソースの中の import の行き先（`from "…"`・`import "…"`・`import("…")`）。型だけの import も含む。 */
export function importsOf(src: string): string[] {
  const out: string[] = [];
  const re =
    /\bfrom\s+"([^"]+)"|\bimport\s+"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)/g;
  for (const m of src.matchAll(re)) out.push((m[1] ?? m[2] ?? m[3])!);
  return out;
}

/** file（app/src からの相対）の中の import を、app/src からの相対のパスにする。パッケージの名前はそのまま返す。 */
function resolved(file: string, spec: string): string {
  if (!spec.startsWith(".")) return spec;
  return path.normalize(path.join(path.dirname(file), spec));
}

const imports = new Map(
  files.map((f) => [
    f,
    importsOf(readFileSync(new URL(f, root), "utf8")).map((s) =>
      resolved(f, s),
    ),
  ]),
);

/** dir の下のファイルのうち、bad に当たる import を持つものを「ファイル -> 行き先」で返す。 */
function violations(
  under: (file: string) => boolean,
  bad: (target: string, file: string) => boolean,
): string[] {
  const out: string[] = [];
  for (const [f, targets] of imports) {
    if (!under(f)) continue;
    for (const t of targets) if (bad(t, f)) out.push(`${f} -> ${t}`);
  }
  return out;
}

const inDir = (dir: string) => (f: string) => f.startsWith(`${dir}/`);

describe("app/src の配置と依存の向き", () => {
  it("app/src の .ts・.tsx を読んでいる", () => {
    assert.ok(files.includes("index.tsx"));
    assert.ok(files.includes("ui/main-window/page.tsx"));
    assert.ok(files.includes("features/sessions/controller.ts"));
    assert.ok(files.includes("infrastructure/tauri/shell.ts"));
    assert.ok(
      imports.get("ui/main-window/page.tsx")!.includes("features/compose.ts"),
    );
  });

  it("import の文面から行き先を取り出す", () => {
    assert.deepEqual(
      importsOf(
        [
          `import { a } from "./a.ts";`,
          `import type {\n  B,\n} from "../b.ts";`,
          `import "./c.css";`,
          `const { D } = await import("./d.tsx");`,
          `export { e } from "pkg/e";`,
        ].join("\n"),
      ),
      ["./a.ts", "../b.ts", "./c.css", "./d.tsx", "pkg/e"],
    );
  });

  it("app/src の直下に置くのは、起動の index.tsx だけ（ほかは ui・features・infrastructure・i18n・assets のどれかに置く）", () => {
    const top = new Set(files.map((f) => f.split("/")[0]));
    assert.deepEqual(
      [...top].sort(),
      ["features", "i18n", "index.tsx", "infrastructure", "ui"].sort(),
    );
  });

  it("Tauri の API（@tauri-apps/*）を読むのは infrastructure/tauri だけ", () => {
    assert.deepEqual(
      violations(
        (f) => !f.startsWith("infrastructure/tauri/"),
        (t) => t.startsWith("@tauri-apps/"),
      ),
      [],
    );
  });

  it("features は、画面（ui/）にも、外の実装（infrastructure/tauri・infrastructure/storage）にも依存しない", () => {
    // kisui serve との取り決め（infrastructure/rpc。型・エラーコードと、輸送路を受け取って動くクライアント）だけは使ってよい
    assert.deepEqual(
      violations(
        inDir("features"),
        (t) =>
          t.startsWith("ui/") ||
          t === "index.tsx" ||
          (t.startsWith("infrastructure/") &&
            !t.startsWith("infrastructure/rpc/")),
      ),
      [],
    );
  });

  it("features は、ブラウザの記録（localStorage）を直に読まない（KeyValueStore で受け取る）", () => {
    const hits: string[] = [];
    for (const f of files.filter(inDir("features"))) {
      const code = readFileSync(new URL(f, root), "utf8")
        .split("\n")
        // コメントの行は見ない（置き場所の説明に localStorage と書いてある）
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
      if (code.some((l) => /\blocalStorage\b/.test(l.replace(/\/\/.*$/, ""))))
        hits.push(f);
    }
    assert.deepEqual(hits, []);
  });

  it("ui は、外の実装（infrastructure/tauri・infrastructure/storage）を直に読まない（Ports で受け取る。本物を渡すのは index.tsx）", () => {
    assert.deepEqual(
      violations(
        inDir("ui"),
        (t) =>
          t.startsWith("infrastructure/tauri/") ||
          t.startsWith("infrastructure/storage/") ||
          t === "index.tsx",
      ),
      [],
    );
  });

  it("infrastructure は、画面（ui/）に依存しない", () => {
    assert.deepEqual(
      violations(
        inDir("infrastructure"),
        (t) => t.startsWith("ui/") || t === "index.tsx",
      ),
      [],
    );
  });

  it("メインウィンドウ（ui/main-window）と常駐ツール（ui/utilities）は、互いを読まない（共に使う部品は ui/modules・ui/components に置く）", () => {
    assert.deepEqual(
      [
        ...violations(inDir("ui/main-window"), (t) =>
          t.startsWith("ui/utilities/"),
        ),
        ...violations(inDir("ui/utilities"), (t) =>
          t.startsWith("ui/main-window/"),
        ),
      ],
      [],
    );
  });

  it("共有の部品（ui/modules・ui/components・ui/styles）は、画面（ui/main-window・ui/utilities）を読まない", () => {
    assert.deepEqual(
      violations(
        (f) =>
          f.startsWith("ui/modules/") ||
          f.startsWith("ui/components/") ||
          f.startsWith("ui/styles/"),
        (t) => t.startsWith("ui/main-window/") || t.startsWith("ui/utilities/"),
      ),
      [],
    );
  });

  it("ui/components は機能の知識を持たない（features から読むのは、かな漢字変換のキーの見分け方 ime.ts だけ）", () => {
    assert.deepEqual(
      violations(
        inDir("ui/components"),
        (t) => t.startsWith("features/") && t !== "features/commands/ime.ts",
      ),
      [],
    );
  });

  it("外への頼みの本物（infrastructure/tauri・infrastructure/storage）を組み立てるのは index.tsx", () => {
    const users = [...imports]
      .filter(
        ([f, targets]) =>
          !f.startsWith("infrastructure/") &&
          targets.some(
            (t) =>
              t.startsWith("infrastructure/tauri/") ||
              t.startsWith("infrastructure/storage/"),
          ),
      )
      .map(([f]) => f);
    assert.deepEqual(users, ["index.tsx"]);
  });
});
