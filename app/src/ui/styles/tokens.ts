// tokens.css の読み取り。Storybook の styles/Tokens（値と説明を並べる）と、tokens.test.ts（決まりの見張り）が使う。
// DOM を使わないので node --test で確かめられる。

/** tokens.css の 1 つの値。 */
export interface Token {
  /** 名前（`--color-bg` など） */
  name: string;
  /** 書いてある値（`var(--gh-bg)` など。空白は 1 つにつめる） */
  value: string;
  /** すぐ上のコメント（役割の説明） */
  note: string;
  /** 属する見出し（`/* == 見出し == *\/` の中身） */
  group: string;
}

/** tokens.css の文から、書いた順に値を取り出す。説明は値のすぐ上のコメント、見出しは `== … ==` のコメント。 */
export function parseTokens(css: string): Token[] {
  const out: Token[] = [];
  let group = "";
  let note = "";
  const re = /\/\*([\s\S]*?)\*\/|(--[\w-]+)\s*:\s*([^;]+);/g;
  for (const m of css.matchAll(re)) {
    if (m[1] !== undefined) {
      const text = m[1].trim();
      const g = /^==\s*([\s\S]*?)\s*==$/.exec(text);
      if (g) group = g[1]!;
      note = g ? "" : text;
      continue;
    }
    out.push({
      name: m[2]!,
      value: m[3]!.trim().replace(/\s+/g, " "),
      note,
      group,
    });
    note = "";
  }
  return out;
}

/** CSS の文の中で var() が読む名前（重ならない。書いた順）。 */
export function usedVars(css: string): string[] {
  const names = [...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]!);
  return [...new Set(names)];
}
