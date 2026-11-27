// かな漢字変換（IME）のキーの判定。Dialog（app/src）のキーを見る場所は、すべてこの isComposingKey で変換のキーを除く。
//
// e.isComposing だけでは足りない。macOS の WKWebView は、変換を確定する Enter の keydown が compositionend の後に来て、
// isComposing が false・keyCode が 229（key が Process）になることがある。isComposing だけを見ると、この Enter で
// 入力そのもの（名前を決める・URL を開くなど）まで確定してしまう（#172 で 1 か所だけ直し、#298 で全体をここにまとめた）。
//
// 新しく入力欄やキーの判定を足すときも、e.isComposing や e.keyCode を直に読まず、isComposingKey を使う。
// ime.test.ts が、ime.ts の外で isComposing・keyCode を読んでいないか、Enter・Esc を見るファイルが isComposingKey を
// 取り込んでいるかを確かめる。DOM には触らない（node --test で確かめられる）。

/** KeyboardEvent のうち、変換のキーかを見分けるのに使う項目。 */
export interface ComposingKeyLike {
  key: string;
  isComposing?: boolean;
  keyCode?: number;
}

/**
 * キー e が、かな漢字変換のためのキー（変換中のキーと、変換を確定する Enter・取り消す Esc）か。
 * 当たるなら、入力欄の確定・取り消しや、Dialog のキーの割り当てに使わない。
 */
export function isComposingKey(e: ComposingKeyLike): boolean {
  return !!e.isComposing || e.key === "Process" || e.keyCode === 229;
}
