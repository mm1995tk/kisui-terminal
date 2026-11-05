// メソッドとパラメータの型。docs/design/gui-protocol.md の 3 章の各表に合わせて手で書いてある。
//
// 向き：Requests は GUI から shj への要求（→ shj）、Notifications は shj から GUI への通知（← GUI）。
// 生成にしなかった理由：Go 側のメソッドの型はまだ無く（B2 以降）、設計書の表が唯一の元なので。
// Go 側ができたら、ここと突き合わせるテストを足す。
//
// `Screen` の中身の細かい部分は画面を作る Issue（D・E）で詰めるので、
// ここではペインの中身までを型にし、残りは緩く（unknown）持つ。元の形は Go の core/screen。

import type { I18nTable } from "./i18n.ts";

export type WorkspaceId = string;
export type TermId = string;

// ---- つなぐ・引き継ぐ・切れる ----

export interface ProtocolVersion {
  major: number;
  minor: number;
}

export type Encoding = "json" | "msgpack";

export interface ClientInfo {
  name: string;
  version: string;
  kind: "web" | "native";
}

export interface HelloParams {
  protocol: ProtocolVersion;
  client: ClientInfo;
  encoding: Encoding[];
  resume?: { serverId: string; rev: number };
}

export interface HelloResult {
  protocol: ProtocolVersion;
  encoding: Encoding;
  shj: { version: string; commit: string; channel: string };
  serverId: string;
  startedAt: string;
  supersedes?: { client: ClientInfo; connectedAt: string };
  capabilities: string[];
  workspaces: Workspace[];
  rev: number;
}

export interface ServerInfo {
  shj: { version: string; commit: string; channel: string };
  serverId: string;
  pid: number;
  uptime: number;
  lastClientAt: string;
  idleStopAt?: string;
  workspaces: number;
  terminals: number;
}

// ---- 画面 ----

export type Region = "files" | "status" | "cmdline" | "overlay";

export interface Pos {
  line: number;
  col: number;
}

export interface Range {
  start: Pos;
  end: Pos;
}

export interface Span {
  text: string;
  /** テーマ上の名前（`syntax.keyword` など）。空はテーマの標準の文字色 */
  style?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}

/** 行番号の横の印。Go の screen.Mark。 */
export interface Mark {
  kind: "added" | "modified" | "deleted" | "diag";
  /** 印の色（テーマ上の名前） */
  style?: string;
}

/** 診断の重さ（LSP の DiagnosticSeverity と同じ数）。1 がエラー、2 が警告、3 が情報、4 がヒント。 */
export type Severity = 1 | 2 | 3 | 4;

/** 1 つの診断。Go の screen.Diagnostic。範囲は行の中の rune の位置 [start, end)。 */
export interface Diagnostic {
  start: number;
  end: number;
  severity: Severity;
  message: string;
  /** 前の行から続く診断。下線だけ引き、行末の文言と行番号の横の印には使わない */
  cont?: boolean;
}

export interface Line {
  /** バッファの行番号（0 始まり） */
  no: number;
  spans: Span[];
  /** 行番号の横の印 */
  marks?: Mark[];
  diag?: Diagnostic[];
  /** インデントガイドを引く桁（表示上の桁、小さい順）。文字の上の空白でも、空行の行末より右でも引く */
  guides?: number[];
  blank?: boolean;
  words?: { start: number; end: number }[];
  /** ガイドが及ぶ幅（桁）。ガイドを引かないときは 0 */
  indent?: number;
  band?: string;
  rule?: boolean;
}

export interface Viewport {
  top: number;
  rows: number;
  cols: number;
  left: number;
  total: number;
}

export interface Title {
  text: string;
  dirty?: boolean;
  readOnly?: boolean;
  peer?: string;
  added?: number;
  deleted?: number;
  note?: string;
  noteWarn?: boolean;
}

/** 画像の参照。Go の screen.ImageRef。実体は blob.get（id は blob）で取る。 */
export interface ImageRef {
  blob: string;
  /** 画像のピクセル数 */
  width: number;
  height: number;
  /** 画像の形式（png など）。画像のペインのとき */
  format?: string;
  /** ファイルの大きさ（バイト）。画像のペインのとき */
  size?: number;
}

/**
 * プレビュー（とレビューカード）の中の画像 1 つ。Go の screen.PreviewImage。表示行 [row, row+rows) を使い、
 * この範囲の行は空。col は左に空ける桁（引用の中の画像）。
 */
export interface PreviewImage {
  row: number;
  rows: number;
  col?: number;
  image: ImageRef;
}

/** 変更のある表示行の範囲 [start, end)。Go の screen.Hunk。 */
export interface Hunk {
  start: number;
  end: number;
  kind: "added" | "deleted" | "modified";
}

/** 差分のペイン（kind が "diff"）の追加の項目。Go の screen.DiffInfo。 */
export interface DiffInfo {
  /** 変更の前（old）・後（new）・前後を行ごとに並べた 1 列（unified） */
  side: "old" | "new" | "unified";
  /** lines[0] の表示行 */
  top: number;
  /** 表示行の全部の数 */
  rows: number;
  hunks: Hunk[] | null;
}

/** Markdown プレビューのペイン（kind が "preview"）の追加の項目。Go の screen.PreviewInfo。 */
export interface PreviewInfo {
  /** lines[0] の表示行 */
  top: number;
  /** 表示行の全部の数 */
  rows: number;
  /** 画像の場所。row の小さい順で、重ならない */
  images: PreviewImage[] | null;
}

export interface Pane {
  id: string;
  title: Title;
  /** "text" | "image" | "diff" | "preview" | "welcome" */
  kind: string;
  viewport: Viewport;
  /** 見えている行だけ。上から並ぶ */
  lines?: Line[] | null;
  /** カーソルのある行（バッファの行番号）。行の強調の基準 */
  curLine: number;
  /** 描くカーソルの位置。先頭が主のカーソル */
  cursors?: Pos[] | null;
  /** cursors と同じ並び。選択の無いカーソルは start と end が同じ */
  selections?: Range[] | null;
  /** kind が "image" のとき。読めなかったときは無い */
  image?: ImageRef | null;
  /** kind が "image" のとき、画像の説明の行（形式・大きさ・容量。読めなかったときはその理由） */
  caption?: string;
  /** kind が "diff" のとき */
  diff?: DiffInfo | null;
  /** kind が "preview" のとき */
  preview?: PreviewInfo | null;
  [more: string]: unknown;
}

export interface Files {
  panes: Pane[];
  active: number;
}

/** 状態行。Go の screen.Status。 */
export interface Status {
  /** モードの表示（"NOR" など）。空ならモードの欄を出さない */
  mode: string;
  /** 途中まで押されたキー（"space" など） */
  pending?: string;
  /** モードの色（`mode.normal` など） */
  style: string;
  /** キーを受けているエディタ以外の領域の名前 */
  pane?: string;
  branch?: string;
  errors?: number;
  warnings?: number;
  /** エージェントの提案の数（文言は shj が作る） */
  suggestions?: string;
  msg?: string;
  msgErr?: boolean;
  cursor: Pos;
  /** 「行:桁」に複数カーソルと選択の文字数を足したもの */
  position?: string;
  indent?: string;
  language?: string;
  /** 未送信のレビューコメントの数（文言は shj が作る） */
  unsent?: string;
  version?: string;
}

/** `:` と `/` の入力行（検索バーも同じ形で、ラベルと案内が付く）。Go の screen.Cmdline。 */
export interface Cmdline {
  /** ":" か "/" か "?"（検索バーはラベル） */
  prefix: string;
  text: string;
  /** rune の位置 */
  cursor: number;
  /** 検索バーの右の案内 */
  hint?: string;
}

/** ポップアップの種類。Go の screen.OverlayKind。 */
export type OverlayKind =
  | "completion"
  | "hover"
  | "signature"
  | "confirm"
  | "palette"
  | "menu"
  | "reviewCard"
  | "search"
  | "proposal";

/** 一覧の 1 行（補完の候補、パレットの項目、メニュー）。Go の screen.Item。 */
export interface Item {
  label: string;
  detail?: string;
  kind?: string;
  /** label の中で検索に合った文字の位置（rune、小さい順） */
  matched?: number[];
}

/** パレットの 1 行の入力欄。Go の screen.Field。 */
export interface Field {
  /** 見出しの後ろの印。":"（文言を聞く）か ">"（探す・選ぶ） */
  prefix: string;
  text: string;
  /** rune の位置 */
  cursor: number;
  /** text が空のときに見せる薄い文言 */
  placeholder?: string;
}

/** レビューカードの編集（返信・コメント）の入力欄。Go の screen.Compose。 */
export interface Compose {
  text: string;
  /** 入力欄の中の行と桁（rune） */
  cursor: Pos;
  /** プレビューの見出し。置き場所が無いときは空 */
  previewLabel?: string;
}

/**
 * ペインの上に重ねるもの。Go の screen.Overlay。at はペイン（pane は Pane.id）の中の位置で、
 * 無ければ描く側が置き場所を決める。
 */
export interface Overlay {
  kind: OverlayKind;
  pane?: string;
  at?: Pos;
  title?: string;
  lines?: Line[];
  items?: Item[];
  /** items の選択位置 */
  active: number;
  field?: Field;
  /** ホバーとレビューカード。lines は見えている行だけで、view がその位置を表す */
  view?: Viewport;
  /** 枠の下の案内 */
  hint?: string;
  /** 枠の上の右端の「コピー」 */
  copyLabel?: string;
  /** レビューカードの中の画像。row は lines の no と同じ表示行の番号 */
  images?: PreviewImage[] | null;
  compose?: Compose;
  /** エージェントの変更の承認の窓で、差分に行が無いときの文言（lines の代わり） */
  empty?: string;
  /** 検索の窓。title は見出し、hint は状態の行の右に出すキーの一覧 */
  search?: Search;
}

/** 検索の窓の入力欄。Go の screen.SearchField。 */
export interface SearchField {
  label: string;
  text: string;
  /** rune の位置 */
  cursor: number;
  placeholder?: string;
}

/** 検索のオプション（切り替え）。Go の screen.SearchOption。 */
export interface SearchOption {
  label: string;
  on: boolean;
}

/** 一致した行の一覧の 1 行。line は一致した部分に背景（match）を付けた、見せる最初の桁からの行。Go の screen.SearchHit。 */
export interface SearchHit {
  /** 「相対パス:行番号」 */
  label: string;
  line: Line;
  /** 置換から外した行 */
  skip?: boolean;
}

/** 選んだ行のプレビュー。Go の screen.SearchPreview。 */
export interface SearchPreview {
  title: string;
  /** ファイルの中の見える行（no は 0 始まりの行番号） */
  lines: Line[];
  /** 選んだ行の no */
  hit: number;
  /** ファイルの全行数（行番号の桁数に使う） */
  total: number;
  /** 置換の前と後の行（違うときだけ。hit の行の下に出す） */
  del?: Line;
  add?: Line;
}

/** 検索の窓（プロジェクトの検索・置換）の状態。Go の screen.Search。 */
export interface Search {
  /** 検索・置換・含める・除くの順（Tab の順） */
  fields: SearchField[];
  /** 今の欄（fields の番号） */
  field: number;
  /** 大文字小文字・単語・正規表現・大文字小文字を保つの順 */
  options: SearchOption[];
  status: string;
  err?: boolean;
  busy?: boolean;
  /** 一覧とプレビューの高さ（行） */
  bodyRows: number;
  /** scroll から見えている分だけ */
  hits?: SearchHit[];
  scroll: number;
  /** 全体の中の選択位置 */
  cursor: number;
  /** 一致した行の全部の数 */
  total: number;
  /** 一致した行が無いときの文言 */
  empty?: string;
  preview?: SearchPreview;
}

/** 全部の画面。`screen.get` の結果。 */
export interface Screen {
  rev: number;
  ackSeq: number;
  focus: string;
  files?: Files;
  /** 購読していない・まだ来ていないときは null */
  status: Status | null;
  /** 閉じているときは null か無い */
  cmdline?: Cmdline | null;
  /** 何も無ければ空か無い */
  overlay?: Overlay[] | null;
}

/** `screen.update` の `files.panes[]`。付いている項目だけが変わった。 */
export interface PaneUpdate {
  id: string;
  kind?: string;
  title?: Title;
  viewport?: Viewport;
  /** `rows` のキーは「ビューポートの中で上から何行目か」（0 始まり）。`count` は見えている行数 */
  lines?: { rows: Record<string, Line>; count: number };
  curLine?: number;
  /** 無くなったときは null（Go 側の空の並び） */
  cursors?: Pos[] | null;
  selections?: Range[] | null;
  [more: string]: unknown;
}

export interface ScreenUpdate {
  rev: number;
  /** GUI の持つ版と合わなければ、GUI は `screen.get` する */
  baseRev: number;
  ackSeq: number;
  focus?: string;
  files?: { panes: PaneUpdate[]; active?: number };
  status?: Status;
  /** 閉じたら null */
  cmdline?: Cmdline | null;
  /** 何も無ければ空か無い */
  overlay?: Overlay[] | null;
}

export interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface Theme {
  name: string;
  tokens: Record<string, Style>;
}

// ---- 入力 ----

export type Mod = "ctrl" | "shift" | "alt" | "super";

export interface InputKeyParams {
  seq: number;
  region: string;
  key: string;
  mods: Mod[];
  text?: string;
  phase: "press" | "repeat" | "release";
}

export interface InputCompositionParams {
  seq: number;
  region: string;
  text: string;
  cursor: [number, number] | null;
}

export interface InputMouseParams {
  seq: number;
  region: string;
  pane?: string;
  kind: "down" | "up" | "move" | "wheel";
  button?: number;
  clicks?: number;
  row: number;
  col: number;
  dx?: number;
  dy?: number;
  mods: Mod[];
}

// ---- ワークスペース ----

export interface Workspace {
  id: WorkspaceId;
  /** プライマリターミナルの cwd から決まったフォルダ。未定のあいだ null */
  folder: string | null;
  /** folder が未定のあいだ null */
  kind: "git" | "shijimi" | "cwd" | null;
  /** folder が未定のあいだ null */
  name: string | null;
  branch?: string;
  /** プライマリターミナル（ワークスペースを閉じるまで残る） */
  primary: TermId;
  /** 分割したターミナル（0〜5 個） */
  terms: TermId[];
  files: string[];
}

// ---- ファイルのツリー ----

export type GitMark = "M" | "A" | "D" | "R" | "?" | "!" | "U";

export interface TreeEntry {
  name: string;
  nameRaw?: string;
  kind: "file" | "dir" | "symlink";
  target?: string;
  size?: number;
  git?: GitMark;
  gitChildren?: boolean;
}

// ---- ターミナル ----

export interface TermInfo {
  termId: TermId;
  pid: number;
  cwd: string;
  workspaceId: WorkspaceId;
  primary: boolean;
  title: string;
  cols: number;
  rows: number;
  alive: boolean;
}

/** GUI から shj への要求（→ shj）。メソッド名 → パラメータと結果。 */
export interface Requests {
  "session.hello": { params: HelloParams; result: HelloResult };
  "session.bye": {
    params: Record<string, never>;
    result: Record<string, never>;
  };
  "session.ping": {
    params: Record<string, never>;
    result: Record<string, never>;
  };
  "server.info": { params: Record<string, never>; result: ServerInfo };
  "server.shutdown": {
    params: { force?: boolean };
    result: { terminals: number };
  };

  "view.subscribe": {
    params: { regions: Region[] };
    result: Record<string, never>;
  };
  "view.resize": {
    params: {
      regions: {
        files?: { cols: number; rows: number };
        status?: { cols: number };
        cmdline?: { cols: number };
        overlay?: { cols: number; rows: number };
      };
      /** ファイルの欄の左右の境界（左側の %。0 は半分） */
      splits?: { diff: number; preview: number };
    };
    result: Record<string, never>;
  };
  "screen.get": { params: Record<string, never>; result: Screen };
  "theme.get": { params: Record<string, never>; result: Theme };
  "i18n.get": { params: Record<string, never>; result: I18nTable };
  "blob.get": {
    params: { id: string; offset?: number; length?: number };
    result: { mime: string; size: number; data: string; eof: boolean };
  };

  "input.key": { params: InputKeyParams; result: { rev: number } };
  "input.composition": {
    params: InputCompositionParams;
    result: { rev: number };
  };
  "input.mouse": { params: InputMouseParams; result: { rev: number } };
  "input.paste": {
    params: { seq: number; region: string; text: string };
    result: { rev: number };
  };
  "input.focus": {
    params: { seq: number; region: string };
    result: { rev: number };
  };
  "command.run": {
    params: { seq: number; line: string };
    result: { ok: boolean; message: string };
  };
  "file.open": {
    params: {
      seq: number;
      workspaceId: WorkspaceId;
      path: string;
      line?: number;
      col?: number;
      pane?: string;
    };
    result: { rev: number };
  };

  "term.create": {
    params: {
      workspaceId: WorkspaceId;
      cols: number;
      rows: number;
      shell?: string;
      env?: Record<string, string>;
    };
    result: { termId: TermId; pid: number; cwd: string };
  };
  "term.list": { params: Record<string, never>; result: { terms: TermInfo[] } };
  "term.attach": {
    params: { termId: TermId; fromSeq?: number };
    result: { seq: number; replay: string; cols: number; rows: number };
  };
  "term.close": { params: { termId: TermId }; result: Record<string, never> };
  "term.restart": {
    params: { termId: TermId };
    result: { pid: number; cwd: string };
  };
  "term.resize": {
    params: { termId: TermId; cols: number; rows: number };
    result: Record<string, never>;
  };
  "term.input": {
    params: { termId: TermId; data: string };
    result: Record<string, never>;
  };

  "workspace.list": {
    params: Record<string, never>;
    result: { workspaces: Workspace[]; focus: WorkspaceId | null };
  };
  "workspace.focus": {
    params: { id: WorkspaceId };
    result: { rev: number; termId?: TermId };
  };
  "workspace.create": {
    params: Record<string, never>;
    result: { id: WorkspaceId; termId: TermId };
  };
  "workspace.close": {
    params: { id: WorkspaceId; force?: boolean };
    result: Record<string, never>;
  };

  "tree.list": {
    params: { workspaceId: WorkspaceId; path: string };
    result: { entries: TreeEntry[]; truncated?: boolean; rev: number };
  };
  "tree.watch": {
    params: { workspaceId: WorkspaceId; paths: string[] };
    result: Record<string, never>;
  };
  "tree.create": {
    params: { workspaceId: WorkspaceId; path: string; kind: "file" | "dir" };
    result: Record<string, never>;
  };
  "tree.rename": {
    params: { workspaceId: WorkspaceId; from: string; to: string };
    result: Record<string, never>;
  };
  "tree.delete": {
    params: { workspaceId: WorkspaceId; path: string };
    result: Record<string, never>;
  };
  "git.status": {
    params: { workspaceId: WorkspaceId };
    result: {
      branch: string;
      ahead?: number;
      behind?: number;
      marks: Record<string, GitMark>;
      rev: number;
    };
  };
}

/** shj から GUI への通知（← GUI）。メソッド名 → パラメータ。 */
export interface Notifications {
  "session.superseded": { by: { client: ClientInfo; connectedAt: string } };
  "screen.update": ScreenUpdate;
  "theme.changed": Theme;
  "i18n.changed": I18nTable;
  "clipboard.write": { text: string };
  "resize.start": Record<string, never>;
  "resize.key": { key: string };
  "resize.reset": Record<string, never>;
  "url.open": { url: string };
  notify: { level: string; text: string };
  "term.output": { termId: TermId; seq: number; data: string };
  "term.exit": { termId: TermId; code: number; signal?: string };
  "term.title": { termId: TermId; title: string };
  "workspace.changed": {
    added?: Workspace[];
    removed?: WorkspaceId[];
    updated?: Workspace[];
  };
  "tree.changed": { workspaceId: WorkspaceId; paths: string[]; rev: number };
  "git.changed": {
    workspaceId: WorkspaceId;
    branch?: string;
    marks?: Record<string, GitMark | null>;
    rev: number;
  };
}

/** `capabilities` に入っているか。新しい機能は、これで見分けてから使う。 */
export function hasCapability(
  hello: Pick<HelloResult, "capabilities">,
  name: string,
): boolean {
  return hello.capabilities.includes(name);
}

/** GUI から shj へ送る通知（返事の無いもの）。メソッド名 → パラメータ。 */
export interface GuiNotifications {
  "screen.ack": { rev: number };
  "term.ack": { termId: TermId; seq: number };
}
