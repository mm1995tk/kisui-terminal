// ツリーのアイコン（D2）。どのファイルにどのアイコンを出すかは TUI の対応表（core/icons.go）を写す。
// TUI は Nerd Font の文字で出すが、GUI は文字のフォントに頼らず SVG で描く（描くのは TreeView.tsx の TreeIconView）。
// 形はモック（親 #271「案：フラットな一覧」）に合わせる：フォルダは塗り、ファイルは枠と短い札。

export type TreeIconKind =
  | "folder"
  | "folder-open"
  | "default"
  | "go"
  | "nix"
  | "markdown"
  | "image"
  | "json"
  | "config"
  | "shell"
  | "lock"
  | "git"
  | "js"
  | "ts"
  | "python"
  | "rust"
  | "html"
  | "css"
  | "text"
  | "pdf"
  | "archive"
  | "license";

export interface TreeIcon {
  kind: TreeIconKind;
  /** 線（と札の文字）の色。TUI と同じ値 */
  color: string;
  /** ファイルの枠の中に出す短い札。無ければ横線 2 本 */
  label?: string;
}

const icon = (kind: TreeIconKind, color: string, label?: string): TreeIcon =>
  label === undefined ? { kind, color } : { kind, color, label };

const FOLDER = icon("folder", "#7aa2c8");
const FOLDER_OPEN = icon("folder-open", "#7aa2c8");
const DEFAULT = icon("default", "#a0a0a0");

const GO = icon("go", "#00add8", "GO");
const NIX = icon("nix", "#7ebae4", "NIX");
const MARKDOWN = icon("markdown", "#519aba", "MD");
const IMAGE = icon("image", "#a074c4");
const JSON_ = icon("json", "#cbcb41", "{}");
const CONFIG = icon("config", "#9aa5b1");
const SHELL = icon("shell", "#89e051", "$");
const LOCK = icon("lock", "#9aa5b1");
const GIT = icon("git", "#f1502f", "GIT");
const JS = icon("js", "#cbcb41", "JS");
const TS = icon("ts", "#519aba", "TS");
const PYTHON = icon("python", "#ffbc03", "PY");
const RUST = icon("rust", "#dea584", "RS");
const HTML = icon("html", "#e44d26", "<>");
const CSS = icon("css", "#42a5f5", "#");
const TEXT = icon("text", "#a0a0a0");
const PDF = icon("pdf", "#e45649", "PDF");
const ARCHIVE = icon("archive", "#c9a26d", "ZIP");
const LICENSE = icon("license", "#d0bf41");

/** 名前（小文字）でそのまま決まるもの。拡張子より先に見る。 */
const byName: Record<string, TreeIcon> = {
  "go.mod": GO,
  "go.sum": GO,
  "flake.lock": NIX,
  license: LICENSE,
  makefile: CONFIG,
  dockerfile: CONFIG,
  ".gitignore": GIT,
  ".gitattributes": GIT,
  ".gitmodules": GIT,
};

/** 拡張子（小文字、点なし）で決まるもの。 */
const byExt: Record<string, TreeIcon> = {
  go: GO,
  nix: NIX,
  md: MARKDOWN,
  markdown: MARKDOWN,
  png: IMAGE,
  jpg: IMAGE,
  jpeg: IMAGE,
  gif: IMAGE,
  webp: IMAGE,
  bmp: IMAGE,
  svg: IMAGE,
  ico: IMAGE,
  json: JSON_,
  toml: CONFIG,
  yaml: CONFIG,
  yml: CONFIG,
  sh: SHELL,
  bash: SHELL,
  zsh: SHELL,
  lock: LOCK,
  js: JS,
  mjs: JS,
  ts: TS,
  tsx: TS,
  py: PYTHON,
  rs: RUST,
  html: HTML,
  css: CSS,
  txt: TEXT,
  pdf: PDF,
  zip: ARCHIVE,
  tar: ARCHIVE,
  gz: ARCHIVE,
};

/** 拡張子（Go の filepath.Ext と同じく、最後の「.」より後ろ。無ければ ""）。 */
function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1);
}

/** ツリーの 1 行のアイコン。 */
export function iconFor(
  name: string,
  dir: boolean,
  expanded: boolean,
): TreeIcon {
  if (dir) return expanded ? FOLDER_OPEN : FOLDER;
  const n = name.toLowerCase();
  return byName[n] ?? byExt[ext(n)] ?? DEFAULT;
}
