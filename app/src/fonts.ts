// 画面の字（親 #271 のモック「案：フラットな一覧」）。オフラインでも出るよう、Google Fonts ではなく同梱する。
// 使う太さだけを読む。IBM Plex Sans JP はモックの 400・600・700（1 つの太さで woff2 が約 1.4MB）、
// JetBrains Mono は 400 と、太字（ターミナルの bold・ファイルの欄の強調）の 700。
// どの太さも字の範囲ごとのファイルに分かれていて、WebView は画面に出た字の分だけを読む。
// woff（woff2 の代わり）は vite.config.ts で落としている。
import "@fontsource/ibm-plex-sans-jp/400.css";
import "@fontsource/ibm-plex-sans-jp/600.css";
import "@fontsource/ibm-plex-sans-jp/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";

/** 等幅の字を読み終えたら解ける（ターミナルは字の幅を測る前にこれを待つ）。読めなくても解ける */
export const monoFontsReady: Promise<unknown> = Promise.all([
  document.fonts.load("400 13px 'JetBrains Mono'"),
  document.fonts.load("700 13px 'JetBrains Mono'"),
]).catch(() => undefined);
