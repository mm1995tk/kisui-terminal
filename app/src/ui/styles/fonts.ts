// 画面の字（親 #271 のモック「案：フラットな一覧」）。オフラインでも出るよう、Google Fonts ではなく同梱する。
// 使う太さだけを読む。IBM Plex Sans JP はモックの 400・600・700（1 つの太さで woff2 が約 1.4MB）。
// どの太さも字の範囲ごとのファイルに分かれていて、WebView は画面に出た字の分だけを読む。
// woff（woff2 の代わり）は vite.config.ts で落としている。
// 端末の JetBrains Mono は kitty と同じ版を同梱する（jetbrains-mono.css）。400 と、太字（ターミナルの bold）の 700、それぞれの斜体。
// Nerd Font のアイコン（Symbols Nerd Font Mono）は JetBrains Mono の次に使う字（symbols-nerd-font.css）。
import "@fontsource/ibm-plex-sans-jp/400.css";
import "@fontsource/ibm-plex-sans-jp/600.css";
import "@fontsource/ibm-plex-sans-jp/700.css";
import "./jetbrains-mono.css";
import "./symbols-nerd-font.css";

/** 等幅の字を読み終えたら解ける（ターミナルは字の幅を測る前にこれを待つ）。読めなくても解ける */
export const monoFontsReady: Promise<unknown> = Promise.all([
  document.fonts.load("400 13px 'JetBrains Mono'"),
  document.fonts.load("700 13px 'JetBrains Mono'"),
  document.fonts.load("italic 400 13px 'JetBrains Mono'"),
  document.fonts.load("italic 700 13px 'JetBrains Mono'"),
  // unicode-range があるので、その範囲の字を渡さないと読まれない
  document.fonts.load("400 13px 'Symbols Nerd Font Mono'", "\ue0a0\uf313"),
]).catch(() => undefined);
