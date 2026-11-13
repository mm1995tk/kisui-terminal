// 等幅の字の並び。ターミナル（coneko-term）と、画面の等幅の字（theme.css の --gh-mono）で同じにする。
// JetBrains Mono に無い Nerd Font の字（U+E000-F8FF など）は Symbols Nerd Font Mono（symbols-nerd-font.css）で、絵文字は最後の絵文字のフォントで出す。
// coneko-term は CSS の変数を読めないので、ここに文字列で持つ。theme.css の --gh-mono と同じかは monoFont.test.ts が確かめる。
export const MONO_FONT_FAMILY =
  "'JetBrains Mono', 'Symbols Nerd Font Mono', ui-monospace, Menlo, Consolas, 'DejaVu Sans Mono', monospace, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji'";
