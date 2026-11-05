import type { ClipboardItem, ClipboardLocation } from "coneko-term";

/**
 * 公式の clipboard-manager プラグインが OS に書けるのは、テキストか画像のどちらか 1 つ。
 * 両方あるときはテキストを選ぶ（どのアプリにも貼れる）。
 */
export type WritePlan =
  { kind: "text"; text: string } | { kind: "image"; bytes: Uint8Array };

/** パラメータ（`;charset=...`）を落として小文字にした MIME の種類。 */
export function baseMime(mime: string): string {
  return mime.split(";")[0]!.trim().toLowerCase();
}

function isText(mime: string): boolean {
  return baseMime(mime) === "text/plain";
}

function isImage(mime: string): boolean {
  return baseMime(mime).startsWith("image/");
}

/** 書き込みの項目から、OS に書くものを選ぶ。書けるものが無ければ undefined（対応しない）。 */
export function planWrite(items: ClipboardItem[]): WritePlan | undefined {
  const text = items.find((i) => isText(i.mime));
  if (text) {
    return {
      kind: "text",
      text: new TextDecoder("utf-8").decode(text.data),
    };
  }
  const image = items.find((i) => isImage(i.mime));
  if (image) return { kind: "image", bytes: image.data };
  return undefined;
}

/** OS に読ませられる種類。読み取りで答えるのはこの 2 つだけ。 */
export const READ_TEXT = "text/plain";
export const READ_IMAGE = "image/png";

/** 頼まれた種類（先に書いたものほど優先）のうち、渡せるものを頼まれた順に。 */
export function readableMimes(wanted: string[]): string[] {
  const out: string[] = [];
  for (const w of wanted) {
    const base = baseMime(w);
    if ((base === READ_TEXT || base === READ_IMAGE) && !out.includes(base)) {
      out.push(base);
    }
  }
  return out;
}

/**
 * primary selection は OS のクリップボード機能（プラグイン）では扱えない。
 * 扱えない場所は、書き込みも読み取りも「対応しない」と答える。
 */
export function supportsLocation(location: ClipboardLocation): boolean {
  return location === "clipboard";
}

/**
 * 許可の窓に出す、頼まれた種類の説明。プログラムが送ってきた文字列は見せない
 * （MIME の欄に文を書いて許可を促せてしまうため）。渡せる種類（テキスト・画像）だけを名前で言い、残りは「ほかの種類」。
 */
export function describeMimes(wanted: string[]): string {
  const names: string[] = [];
  const known = readableMimes(wanted);
  if (known.includes(READ_TEXT)) names.push("テキスト");
  if (known.includes(READ_IMAGE)) names.push("画像");
  if (wanted.some((w) => !known.includes(baseMime(w))))
    names.push("ほかの種類");
  return names.length > 0 ? names.join("、") : "（指定なし）";
}
