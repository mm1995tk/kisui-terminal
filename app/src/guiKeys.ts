// GUI が受けるキーの土台。キーの割り当て（どのキーで何をするか）は commands.ts の表にある（リーダーと近道。docs/key-design.md）。
// Mac は Cmd を含むキー、Linux と Windows は Ctrl+Shift+字だけを受ける（shj のキーを奪わないため）。
// Option は字を打つキーのまま使うので、アプリの外のキー Option+Space（殻が OS から取る。clipboard_popup.rs）以外では使わない。
// Cmd+` は macOS が使うので使わない。
// DOM には触らない（node --test で確かめられる）。

/** KeyboardEvent のうち、ここで使う項目。 */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/** 動いている OS が macOS か。 */
export function isMac(platform: string): boolean {
  return /mac|iphone|ipad/i.test(platform);
}

/** 動いている OS が macOS か。 */
export const IS_MAC =
  typeof navigator !== "undefined" &&
  isMac(navigator.platform || navigator.userAgent || "");
/**
 * キーの向き先がどの欄にも無い（フォーカスが画面全体に落ちている）か。
 * フォーカスがどの要素にも無いときに起こる（Mac の実機では、どの場面で起こるかを確かめていない）。
 * このとき Cmd+W を受けないと、OS のメニューの「閉じる」にまで届いて、アプリの窓が閉じる（#83）。
 */
export function isFocusLost(
  target: unknown,
  doc: Document = document,
): boolean {
  return !target || target === doc.body || target === doc.documentElement;
}

/**
 * Ctrl+E だけ（Shift・Alt・Cmd なし）。TUI と同じ「エディタ（端末の shj）へ戻る」キー（#77）。
 * かな漢字変換中は除く。サイドバーのファイルツリーと CHANGES の両方がこれを使う。
 */
export function isEditorKey(e: {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
}): boolean {
  return (
    e.key.toLowerCase() === "e" &&
    !!e.ctrlKey &&
    !e.shiftKey &&
    !e.altKey &&
    !e.metaKey &&
    !e.isComposing
  );
}

/**
 * Mac のメニューの「閉じる」（Cmd+W）が選ばれたとき、閉じるのは今の欄か、アプリの窓か（#111）。
 * キーがターミナルの欄（画像・動画・PDF の欄を含む。PDF は欄の中の iframe にフォーカスがある）に向いているときか、
 * どこにも向いていないときは、今の欄（プライマリの欄なら何もしない）。サイドバー・入力欄・窓の中などでは、今までどおり窓を閉じる。
 * キーが画面に届く場合の判定（App.tsx の `inPane`）と同じにしてある。
 */
export function closeTarget(
  focused: unknown,
  card: { contains(n: Node | null): boolean } | null | undefined,
  doc: Document = document,
): "pane" | "window" {
  return isFocusLost(focused, doc) || !!card?.contains(focused as Node)
    ? "pane"
    : "window";
}
