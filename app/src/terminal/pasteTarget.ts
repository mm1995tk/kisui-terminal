// キーが向いているターミナルの欄に、文字を貼る（クリップボードの履歴の窓から使う）。
// 欄ごとに TerminalView が paste を登録し、キーが今どの欄の中にあるかで宛先を決める。

interface Entry {
  host: HTMLElement;
  paste: (text: string) => void;
}

const entries = new Set<Entry>();

/** 欄を登録する。返す関数で外す。 */
export function registerPasteTarget(
  host: HTMLElement,
  paste: (text: string) => void,
): () => void {
  const entry = { host, paste };
  entries.add(entry);
  return () => entries.delete(entry);
}

/** いまキーが向いている欄に貼る関数。どの欄にも向いていなければ undefined。 */
export function focusedPasteTarget(
  active: Element | null = document.activeElement,
): ((text: string) => void) | undefined {
  if (!active) return undefined;
  for (const e of entries) if (e.host.contains(active)) return e.paste;
  return undefined;
}
