// メソッドとパラメータの型。docs/design/gui-protocol.md の 3 章の各表に合わせて手で書いてある。
//
// 向き：Requests は GUI から shj への要求（→ shj）、Notifications は shj から GUI への通知（← GUI）。
// 生成にしなかった理由：Go 側のメソッドの型はまだ無く（B2 以降）、設計書の表が唯一の元なので。
// Go 側ができたら、ここと突き合わせるテストを足す。

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
  /** プライマリターミナルの中で動いている TUI の shj。無ければ null（kisui serve は常に送る） */
  primaryShj?: PrimaryShj | null;
  /** プライマリの shj が開かせた、ターミナルでない欄（動画。#555）。並びはターミナルの後ろ。無ければ []（古い kisui serve は送らない） */
  extras?: ExtraPane[];
}

/** ターミナルでない欄：動画（#555）かブラウザ（#556） */
export interface ExtraPane {
  id: string;
  kind: "video" | "browser";
  /** 動画のファイルの絶対パス（その欄を開いたマシンのもの）。ブラウザでは空 */
  path: string;
  /** 動画の種類と大きさ。ブラウザでは空と 0 */
  mime: string;
  size: number;
  /** ブラウザが最初に開く http か https の URL（動画では無い） */
  url?: string;
}

export interface PrimaryShj {
  /** その shj の制御用ソケット（core/ctl）の場所 */
  socket: string;
  pid: number;
  /** その shj が出しているテキストか画像の絶対パス。何も出していなければ省く */
  file?: string;
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
  /** 欄のシェルと画面を消さずに、executable の kisui serve に入れ替わる。返事のあと古い serve は接続を閉じる（#7） */
  "server.handover": {
    params: { executable: string; env?: Record<string, string> };
    result: { pid: number };
  };

  /** ターミナルでない欄（動画）の中身を範囲で取る。1 回で返るのは 4 MiB まで（#555） */
  "media.read": {
    params: {
      workspaceId: WorkspaceId;
      id: string;
      offset?: number;
      length?: number;
    };
    result: { mime: string; size: number; data: string; eof: boolean };
  };
  "extra.close": {
    params: { workspaceId: WorkspaceId; id: string };
    result: Record<string, never>;
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
    params: { termId: TermId };
    result: { seq: number; snapshot: string; cols: number; rows: number };
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
  "term.cd": {
    params: { termId: TermId; path?: string };
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
  "shj.open": {
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
  /** kisui attach が目印のすぐあとに出す、その attach 自身の kisui の説明。serve の版と違えば引き継ぎに使う（#8） */
  "attach.info": AttachInfo;
  "session.superseded": { by: { client: ClientInfo; connectedAt: string } };
  /** プライマリの shj の欄（#553）。shj が端末のコマンドで欄を出した・隠した */
  "pane.show": {
    workspaceId: WorkspaceId;
    /** 出した欄がターミナルのとき */
    termId?: TermId;
    /** 出した欄がターミナルでないとき（Workspace.extras の id） */
    extraId?: string;
  };
  "pane.hide": { workspaceId: WorkspaceId };
  notify: { level: string; text: string };
  "term.output": { termId: TermId; seq: number; data: string };
  /** `code` は、`kisui serve` が引き継いだシェル（その子でない）では分からないので無い。 */
  "term.exit": { termId: TermId; code?: number; signal?: string };
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

/** attach.info の中身。version・commit・channel は session.hello の shj と同じ形。 */
export interface AttachInfo {
  /** その kisui の実行ファイルの絶対パス */
  executable: string;
  version: string;
  commit: string;
  channel: string;
  /** 新しい serve に渡す環境変数（server.handover の env） */
  env?: Record<string, string>;
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
  "term.ack": { termId: TermId; seq: number };
}
