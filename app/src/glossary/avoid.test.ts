import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// docs/glossary.md の「Avoid」の列にある語（用語集の語に直した別名）が、
// 文書・日本語の画面の文・コードのコメントに戻っていないことを確かめる。
// 用語集そのものと、このテストのファイルは対象にしない。

const root = new URL("../../../", import.meta.url);
const SELF = "app/src/glossary/avoid.test.ts";
const GLOSSARY = "docs/glossary.md";

/** 表の行の Avoid の列を、「, 」で分ける（丸かっこの中の「, 」では分けない） */
const splitCell = (cell: string): string[] =>
  cell
    .split(/,\s*(?![^()]*\))/)
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * 見張る語か。
 * - ASCII だけの語（window など）は、OS の語としても使うので見張らない。
 * - かっこの注釈が付いた語（「(when it means …)」）は、文脈で意味が変わるので見張らない。
 * - 片仮名だけの語（ダイアログ・ワークスペースなど。「の」「 」は無視）は、日本語の文で残してよいので見張らない。
 */
const watched = (w: string): boolean => {
  if (/[()]/.test(w)) return false;
  const rest = w.replace(/[の\s]/g, "");
  return /[぀-ゟ㐀-鿿]/.test(rest);
};

const avoidWords = (): string[] => {
  const words: string[] = [];
  for (const line of readFileSync(new URL(GLOSSARY, root), "utf8").split(
    "\n",
  )) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|");
    // | Term | Means | Avoid |  → 先頭と末尾の空を除くと 3 つ
    if (cells.length !== 5) continue;
    words.push(...splitCell(cells[3]).filter(watched));
  }
  return [...new Set(words)];
};

const targets = (): string[] =>
  execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.(md|ts|tsx|go|rs|css)$/.test(f))
    .filter((f) => f !== GLOSSARY && f !== SELF);

describe("用語集の Avoid の列の語", () => {
  const words = avoidWords();

  it("見張る語を読めている", () => {
    for (const w of ["窓", "近道", "下の段", "お知らせ"]) {
      assert.ok(words.includes(w), `${w} を読めていない`);
    }
  });

  it("文書・日本語の画面の文・コードのコメントに出てこない", () => {
    const found: string[] = [];
    for (const f of targets()) {
      const lines = readFileSync(new URL(f, root), "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const w of words) {
          if (line.includes(w)) found.push(`${f}:${i + 1}: ${w}`);
        }
      });
    }
    assert.deepEqual(found, [], "用語集の語に直す（docs/glossary.md）");
  });
});
