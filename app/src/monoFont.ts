/**
 * 等幅の字の並び。ターミナル（coneko-term）と、画面の等幅の字（theme.css の --gh-mono）で同じにする。
 * JetBrains Mono に無い Nerd Font の字（U+E000-F8FF など）は Symbols Nerd Font Mono（symbols-nerd-font.css）で出す。
 * 絵文字は並びに書かない（OS の代わりの字で出る。書くと ✈ ☎ など文字の見せ方が既定の記号まで色付きの絵文字になりうる）。
 * coneko-term は CSS の変数を読めないので、ここに文字列で持つ。theme.css の --gh-mono と同じかは monoFont.test.ts が確かめる。
 */
export const MONO_FONT_FAMILY =
  "'JetBrains Mono', 'Symbols Nerd Font Mono', ui-monospace, Menlo, Consolas, 'DejaVu Sans Mono', monospace";
