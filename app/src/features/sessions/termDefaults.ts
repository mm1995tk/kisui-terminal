// マシンごとの、新しいターミナルが始まるフォルダとシェル（#485）。
//
// 決めるのは手元の設定ファイルだけ（リモートのマシンの設定ファイルは書き換えない）。リモートのマシンは [[gui.machines]] の項目の
// start_dir と shell、手元のマシン（「ローカル」）は [server] の start_dir と shell。窓は、ターミナルを始める要求
// （workspace.create・term.create・term.restart）に、そのマシンの分を付けて kisui serve に渡す（session.ts）。
// 設定は、要求のたびに読み直す（controller.ts）。kisui serve を止めずに、設定を変えた次のターミナルから効くようにするため。
//
// - どちらも、そのマシンでのパス。~ と ~/x は、そのマシンのホーム（開くのは、そのマシンの kisui serve）。
// - 手元では、リモートのパスが有るかを確かめられない。ここで確かめるのは形だけ（startDirProblem・shellProblem。殻の config.rs と同じ決まり）。
//   有るかを確かめるのは kisui serve で、フォルダが無ければそのマシンの [server] start_dir（無ければホーム）で始め、
//   シェルが実行できなければ、別のシェルに替えずに断る（理由を知らせに出す）。
// - 書いていないマシンは、今までどおり（そのマシンの [server] start_dir、無ければホーム。シェルは、そのマシンの [server] shell、無ければ $SHELL）。
// - 受けられるのは、session.hello の capabilities に TERM_DEFAULTS_CAPABILITY がある kisui serve だけ。無い（古い）serve には、何も付けない。

import { T } from "../../i18n/index.ts";
import type { ConfigMachine } from "./machines.ts";
import { LOCAL } from "./shell.ts";

/** マシン 1 台の分。書いていない項目は無い（null・undefined。殻の config.rs の TermDefaults と同じ形）。 */
export interface TermDefaults {
  /** 始めるフォルダ（start_dir） */
  startDir?: string | null;
  /** シェル（shell。実行できるファイルのパス。引数は書けない） */
  shell?: string | null;
}

/** workspace.create の startDir・shell と、term.create・term.restart の shell を受けられる kisui serve の印。 */
export const TERM_DEFAULTS_CAPABILITY = "workspace.create.shell";

/** 設定のうち、ここで使う部分（殻の config_gui の結果）。 */
export interface TermDefaultsConfig {
  machines: readonly ConfigMachine[];
  localTerminal?: TermDefaults | null;
}

/** 設定から、つなぎ先（LOCAL か ssh の行き先）ごとの分を取り出す。 */
export function termDefaultsByTarget(
  cfg: TermDefaultsConfig,
): Record<string, TermDefaults> {
  const out: Record<string, TermDefaults> = {
    [LOCAL]: pick(cfg.localTerminal ?? {}),
  };
  for (const m of cfg.machines) out[m.ssh] = pick(m);
  return out;
}

const pick = (d: TermDefaults): TermDefaults => ({
  ...(d.startDir ? { startDir: d.startDir } : {}),
  ...(d.shell ? { shell: d.shell } : {}),
});

const hasControl = (v: string): boolean => /\p{Cc}/u.test(v);

/** start_dir に書ける形か（絶対パスか、~・~/…）。書けなければ理由。v は前後の空白を除いたもの。空は「書かない」で、よい。 */
export function startDirProblem(v: string): string | undefined {
  if (v === "") return undefined;
  if (hasControl(v)) return T("termSettings.err.control");
  if (v === "~" || v.startsWith("~/") || v.startsWith("/")) return undefined;
  return T("termSettings.err.startDir");
}

/** shell に書ける形か（ファイルの絶対パスか、~/…。引数は書けない）。書けなければ理由。v は前後の空白を除いたもの。空は「書かない」で、よい。 */
export function shellProblem(v: string): string | undefined {
  if (v === "") return undefined;
  if (hasControl(v)) return T("termSettings.err.control");
  if ((v.startsWith("~/") || v.startsWith("/")) && !v.endsWith("/"))
    return undefined;
  return T("termSettings.err.shell");
}

/**
 * workspace.create に付ける引数（TERM_DEFAULTS_CAPABILITY のある kisui serve にだけ送る。確かめるのは session.ts）。
 * 書いていない項目は、空の文字列で送る（「そのマシンの既定」。前に渡したシェルを、serve が覚えたままにしないように）。
 */
export function createParams(d: TermDefaults): {
  startDir: string;
  shell: string;
} {
  return { startDir: d.startDir ?? "", shell: d.shell ?? "" };
}

/** term.create・term.restart に付ける引数（シェルだけ。フォルダは、ワークスペースのフォルダ）。送る相手は createParams と同じ。 */
export function shellParam(d: TermDefaults): { shell: string } {
  return { shell: d.shell ?? "" };
}
