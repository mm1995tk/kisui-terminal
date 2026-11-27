/**
 * 等幅の字の並び。ターミナル（coneko-term）と、画面の等幅の字（theme.css の --gh-mono）で同じにする。
 * JetBrains Mono に無い Nerd Font の字（U+E000-F8FF など）は Symbols Nerd Font Mono（symbols-nerd-font.css）で出す。
 * 絵文字は並びに書かない（OS の代わりの字で出る。書くと ✈ ☎ など文字の見せ方が既定の記号まで色付きの絵文字になりうる）。
 * coneko-term は CSS の変数を読めないので、ここに文字列で持つ。theme.css の --gh-mono と同じかは monoFont.test.ts が確かめる。
 */
export const MONO_FONT_FAMILY =
  "'JetBrains Mono', 'Symbols Nerd Font Mono', ui-monospace, Menlo, Consolas, 'DejaVu Sans Mono', monospace";

/** ターミナルの字の大きさ（px）。TerminalView.tsx の xterm と、サイドバーの幅の上限の計算（main-window/termCell.ts）が同じ値を使う。 */
export const TERM_FONT_SIZE = 11;

/** ターミナルのスクロールバーの幅（px）。TerminalView.tsx の coneko-term の設定と、サイドバーの幅の上限の計算（main-window/panes.ts の TERM_CHROME_WIDTH）が同じ値を使う。 */
export const TERM_SCROLLBAR_WIDTH = 4;
/** ターミナルの欄の左右の内側の余白（px。片側）。content/terminal/terminal.css の .terminal-cell の padding と同じ（panes.test.ts が確かめる）。 */
export const TERM_PADDING_X = 4;
