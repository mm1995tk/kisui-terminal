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
  /** ユーザーがつけた名前（workspace.rename）。つけていなければ省く。あれば、帯の名前は name の代わりにこれになる。古い kisui serve は送らない */
  label?: string;
  /** folder を、そのマシンのホームディレクトリを ~ にして書いた見せる用のパス。見せ方だけで、ホームの外は folder と同じ。古い kisui serve は送らない */
  display?: string;
  /** ブランチ名。detached HEAD では無い */
  branch?: string;
  /** HEAD のコミットの先頭 7 文字（帯に「main (9e11274)」と出す）。読めなければ無い。古い kisui serve は送らない */
  sha?: string;
  /** プライマリターミナル（ワークスペースを閉じるまで残る） */
  primary: TermId;
  /** 分割したターミナル（個数に上限は無い） */
  terms: TermId[];
  /** プライマリターミナルの中で動いている TUI の shj。無ければ null（kisui serve は常に送る） */
  primaryShj?: PrimaryShj | null;
  /** プライマリの shj が開かせた、ターミナルでない欄（動画。#555）。並びはターミナルの後ろ。無ければ []（古い kisui serve は送らない） */
  extras?: ExtraPane[];
  /** 欄の配置（分割の木）。葉は primary・terms・extras の id。古い kisui serve は送らない */
  layout?: PaneLayout;
  /** 欄の名前（kisui pane title。欄の id -> 名前）。名前のある欄だけ入る。無ければ省く */
  titles?: Record<string, string>;
}

/** 分割の木の節の向き：右（縦の境界。a が左、b が右）か下（横の境界。a が上、b が下） */
export type TreeDir = "right" | "down";

/** 欄を分ける向き。左と上は木に出ない（子の順番を逆にして、新しい欄を a にする）ので、木の節の向きは TreeDir。 */
export type SplitDir = TreeDir | "left" | "up";

/** 欄の配置：葉が欄（pane は primary・terms・extras の id）、節が分割。ratio は a の割合（0〜1） */
export type PaneLayout =
  | { pane: string }
  | { dir: TreeDir; ratio: number; a: PaneLayout; b: PaneLayout };

/** ターミナルでない欄：動画（#555）・画像・PDF（どれもファイルを media.read で取る） */
export interface ExtraPane {
  id: string;
  kind: "video" | "image" | "pdf";
  /** 動画・画像・PDF のファイルの絶対パス（その欄を開いたマシンのもの） */
  path: string;
  /** ファイルの種類と大きさ */
  mime: string;
  size: number;
}

/**
 * shj の CHANGES に渡すキー（shj.changesKey）：s（split / unified）・r・R（読み直す）・space（Space メニュー）・:（コマンド行）。
 * space と : のあと、GUI はプライマリの端末にキーを向ける。続きのキー（space w の w など）は端末から shj に届き、shj が CHANGES の続きとして扱う。
 */
export type ChangesShjKey = "s" | "r" | "R" | "space" | ":";

export interface PrimaryShj {
  /** その shj の制御用ソケット（core/ctl）の場所 */
  socket: string;
  pid: number;
  /** その shj が出しているテキストか画像の絶対パス。何も出していなければ省く */
  file?: string;
  /** shj が差分モード（Ctrl+G）のときの変更の一覧（CHANGES）。差分モードでなければ無い。サイドバーのツリーの下に出す */
  diff?: PrimaryDiff;
}

/** shj が差分モードのときの変更の一覧（Go の ctl.PrimaryDiff）。files は shj が見せる順 */
export interface PrimaryDiff {
  files: DiffFile[];
  /** shj が今差分を出しているファイルの絶対パス。無ければ省く */
  selected?: string;
  /** 比べている相手：'head'（HEAD。無いときも）か 'pr'（PR。Space g）。知らない値は HEAD */
  base?: "head" | "pr";
}

/** 変更したファイル 1 つ（Go の ctl.DiffFile）。added と deleted は増えた行・減った行の数（バイナリは 0 か省く） */
export interface DiffFile {
  /** 絶対パス（削除されたファイルも） */
  path: string;
  /** "modified" | "added" | "deleted" | "renamed" | "binary"。知らない値・無い値は変更として扱う */
  status?: string;
  added?: number;
  deleted?: number;
  /** PR で viewed にしている（base が 'pr' のときだけ入る。無ければ viewed でない） */
  viewed?: boolean;
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

// ---- DB（MySQL / PostgreSQL） ----
// capabilities に "db" がある kisui serve だけが受ける。Go の側は server/db.go と internal/db。

/**
 * db.connections が返す接続の 1 つ：kisui serve が動くマシンの設定の [[db.connections]]。パスワードは入らない。
 * 環境の変種（[[db.connections.variants]]）のある接続は、変種ごとに 1 つ（name が同じで variant が違うものが、設定に書いた順に続く）
 */
export interface DbConnection {
  /** 接続の名前。name と variant の組は、そのマシンの一覧の中で重ならない。db.query の connection に渡す */
  name: string;
  /** 環境の変種の名前（db.query の variant に渡す）。変種の無い接続は ""（変種を知らない古い kisui serve は付けない） */
  variant?: string;
  kind: "postgres" | "mysql";
  /** ホスト名かアドレス。`/` で始まれば Unix ソケット */
  host: string;
  port: number;
  user: string;
  /** 設定に書いていなければ "" */
  database: string;
  /** true の接続は、窓からの SQL を読み取り専用のトランザクションで実行する（書き込みは DB が断る）。人の実行の段階が "read"（human.run）ということ */
  readOnly: boolean;
  /** 人（窓）がこの接続にしてよいこと（#381。権限を知らない古い kisui serve は付けない） */
  human?: DbHumanAccess;
  /** コーディングエージェント（kisui db のコマンド）がこの接続にしてよいこと（#381。権限を知らない古い kisui serve は付けない） */
  agent?: DbAgentAccess;
}

/** SQL の実行の段階。none：実行しない、read：読み取り専用のトランザクションで実行する、free：そのまま実行する */
export type DbRun = "none" | "read" | "free";

/** 人がある接続にしてよいこと（設定の権限と read-only を合わせた結果） */
export interface DbHumanAccess {
  /** 使っている権限の名前（[db.permissions] のキー）。設定に書いていなければ "" */
  permission: string;
  run: DbRun;
}

/** コーディングエージェントがある接続にしてよいこと */
export interface DbAgentAccess {
  permission: string;
  run: DbRun;
  /** DB のタブの入力欄に SQL を書いてよいか */
  propose: boolean;
  /** エージェントがログインする DB のユーザー（権限に agent-user が無ければ、接続の user と同じ） */
  user: string;
}

/** 列の値の読み方。number：数（文字のまま届く）、boolean："true" か "false"、binary："0x" と 16 進、text：それ以外 */
export type DbColumnKind = "number" | "boolean" | "binary" | "text";

export interface DbColumn {
  name: string;
  /** DB の型の名前（小文字。"integer"、"character varying(20)"、"int unsigned" など）。見せるためのもので、型の判定には kind を使う */
  type: string;
  kind: DbColumnKind;
}

/** db.query の結果 */
export interface DbQueryResult {
  /** 行を返さない文（UPDATE・CREATE など）では空 */
  columns: DbColumn[];
  /** 値は DB が書く文字のまま（数も文字。桁を落とさないため）。NULL は null */
  rows: (string | null)[][];
  /** rows の行数 */
  rowCount: number;
  /** 文が返した行が上限（maxRows、または全体で 8 MiB）を超え、rows に入っていない行がある */
  truncated: boolean;
  /**
   * 文を包んで実行し直せる（offset で続きのページを読める。#373）：列を返す SELECT（WITH … SELECT）で、MySQL では列の名前が重ならない。
   * 古い kisui serve は付けない（そのときはページを送らない）
   */
  wrappable?: boolean;
  /** db.query の offset：rows の前にある行数 */
  offset?: number;
  /** 1 MiB を超えて切られた値がある */
  truncatedCells?: boolean;
  /** 文が変えた行数。読むだけの文では無い */
  rowsAffected?: number;
  /** 文を送ってから最後の行を読むまでのミリ秒（小数あり）。ログインの時間は入らない */
  elapsedMs: number;
}

/** db.schema の結果：接続のスキーマ → テーブル（ビューを含む）→ 列。システムのスキーマは入らない */
export interface DbCatalog {
  /** 名前の順。テーブルの無いスキーマも入る。MySQL ではスキーマは DB（ユーザーに見える全部） */
  schemas: DbCatalogSchema[];
  /**
   * この接続で、スキーマ名の無い文が使うスキーマ（PostgreSQL は current_schema()、MySQL は接続先の DB）。
   * 無ければ null（MySQL で DB を指定せずに接続した、PostgreSQL の search_path にあるスキーマが 1 つも無い）。
   * schemas に入っていないことがある。フィールドが無い（undefined）のは、これを返さない古い kisui serve
   */
  defaultSchema?: string | null;
  /** 列が上限（全体で 100000）を超え、その先のスキーマ・テーブルが無い（最後のテーブルの列が欠けることがある） */
  truncated: boolean;
}

export interface DbCatalogSchema {
  name: string;
  /** 名前の順 */
  tables: DbCatalogTable[];
}

export interface DbCatalogTable {
  name: string;
  /** table：テーブル（PostgreSQL の分割したテーブル・外部テーブルも）、view：ビュー（マテリアライズドビューも） */
  kind: "table" | "view";
  /** テーブルの中の順 */
  columns: DbCatalogColumn[];
}

export interface DbCatalogColumn {
  name: string;
  /** DB の型の名前（DB が返したまま。"character varying(20)"、"varchar(20)"、"int unsigned"、"enum('A','b')"、引用符付きの "\"Mood\"" など）。見せるためのもの */
  type: string;
}

/** db.structure の結果（#379）：1 つのテーブル（ビュー）の列・インデックス・外部キー */
export interface DbStructure {
  /** テーブルの中の順 */
  columns: DbStructureColumn[];
  /** 主キーが先、ほかは名前の順。ビューには無い */
  indexes: DbStructureIndex[];
  /** このテーブルから、ほかのテーブルを指す外部キー。名前の順 */
  foreignKeys: DbStructureForeignKey[];
  /** どれかの一覧が上限を超え、終わりが欠けている */
  truncated: boolean;
}

export interface DbStructureColumn {
  name: string;
  /** DB の型の名前（DbCatalogColumn.type と同じ書き方） */
  type: string;
  nullable: boolean;
  /** 既定値（DB が書いたまま。PostgreSQL は式、MySQL は COLUMN_DEFAULT で、文字列は引用符無し）。無ければ null */
  default: string | null;
}

export interface DbStructureIndex {
  name: string;
  /** キーの並び：列の名前か、列でないキーの式（PostgreSQL。MySQL の式のキーは ""） */
  columns: string[];
  unique: boolean;
  primary: boolean;
  /** 作り方（小文字。"btree"、"hash"、"gin"、"fulltext" など） */
  method: string;
}

export interface DbStructureForeignKey {
  name: string;
  /** このテーブルの列。refColumns は、それぞれが指す列（同じ順） */
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  /** "NO ACTION"・"RESTRICT"・"CASCADE"・"SET NULL"・"SET DEFAULT" */
  onUpdate: string;
  onDelete: string;
}

/** db.history の 1 件：接続で実行した SQL。結果の行は残らない */
export interface DbHistoryEntry {
  /** 送った SQL そのまま */
  sql: string;
  /** 送った時刻（UTC、ミリ秒まで。RFC 3339。例 "2026-01-02T03:04:05.678Z"） */
  at: string;
  /** DB が間違いなく実行した。DB が断った・取り消したものは false */
  ok: boolean;
  /** コーディングエージェントが実行した文（`kisui db query`。#382）なら "agent"。人が窓で実行した文には無い */
  actor?: string;
}

/** password_required（-32006）の data。missing：どこにも無い、rejected：DB が断った。どちらも窓はパスワードを聞く */
export interface DbPasswordRequiredData {
  reason: "missing" | "rejected";
  /**
   * rejected のとき、断られたパスワードを見つけた場所（キーチェーンか ~/.pgpass・~/.my.cnf）。入力したものが断られたときは無い。
   * 入力したパスワードは、次から見つけたものより先に使われる（#356）
   */
  passwordSource?: "keychain" | "file";
}

/** db_error（-32007）の data。message は DB の言葉そのまま */
export interface DbErrorData {
  /**
   * connect：つながらない、auth：キーチェーンかファイルのパスワードを DB が断った（古い kisui serve だけ。今は password_required）、
   * query：DB が SQL を断った、cancelled：取り消された
   */
  kind: "connect" | "auth" | "query" | "cancelled";
  /** DB が返した 5 文字（SQLSTATE） */
  sqlState?: string;
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
  /** 欄どうしの境界の割合を変える。pane は境界の B 側の左上の欄（grid.ts の firstPane）。serve が範囲に収めた割合を返す */
  "layout.resize": {
    params: { workspaceId: WorkspaceId; pane: string; ratio: number };
    result: { ratio: number };
  };
  /** 2 つの欄の場所を入れ替える（pane と other は Workspace.layout の葉）。役目（プライマリなど）は欄についたまま。どちらかが無ければ not_found、同じ欄なら invalid_params */
  "layout.swap": {
    params: { workspaceId: WorkspaceId; pane: string; other: string };
    result: Record<string, never>;
  };

  "term.create": {
    params: {
      workspaceId: WorkspaceId;
      cols: number;
      rows: number;
      shell?: string;
      env?: Record<string, string>;
      /** 足す場所：欄 target（Workspace.layout の葉）を dir に分ける。無ければ自動。小さすぎる欄は busy で断られる */
      split?: { target: string; dir: SplitDir };
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
    params: { termId: TermId; path: string };
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
  /**
   * `kisui pane` の --machine（#344）。別のマシンのペインから手元の GUI が中継した頼み（list・send・keys・close・read）を、
   * このマシンで行う。断るときも result の error で答える。hello の capabilities に "pane.run" がある serve だけが受ける
   */
  "pane.run": { params: PaneRunRequest; result: PaneRunReply };
  "workspace.create": {
    /**
     * dir は、プライマリターミナルのシェルを始めるフォルダ（絶対パス）。無い・フォルダでなければ start_dir。古い kisui serve は無視する。
     * argv・env・name は `kisui pane open`（#343）：プライマリターミナルでシェルの代わりに動かすコマンド（最初の語は絶対パス）、
     * その環境変数（"NAME=value"）、そのペインの名前（ほかのペインと重なれば作らずに断る）。hello の capabilities に
     * "workspace.create.command" がある serve だけが受ける（古い serve は無視してシェルを始めるので、送る前に確かめる）
     */
    params: { dir?: string; argv?: string[]; env?: string[]; name?: string };
    result: { id: WorkspaceId; termId: TermId };
  };
  "workspace.close": {
    params: { id: WorkspaceId; force?: boolean };
    result: Record<string, never>;
  };
  /** name が空（前後の空白を除いて）なら、つけた名前を外して自動の名前に戻す */
  "workspace.rename": {
    params: { id: WorkspaceId; name: string };
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
  "shj.diff": {
    /** path は primaryShj.diff.files の path（絶対パス） */
    params: { workspaceId: WorkspaceId; path: string };
    result: Record<string, never>;
  };
  "shj.changesKey": {
    /** TUI の CHANGES のキー（ChangesShjKey）。差分モードのプライマリの shj に、CHANGES でそのキーを押したものとして渡す */
    params: { workspaceId: WorkspaceId; key: ChangesShjKey };
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
  /** このマシンの設定に書いた DB の接続の一覧。problems は設定の間違い（間違いのある接続は connections に入らない） */
  "db.connections": {
    params: Record<string, never>;
    result: { connections: DbConnection[]; problems: string[] };
  };
  /**
   * 接続に SQL を 1 つ実行する。variant は環境の変種の名前（変種の無い接続では省く。変種のある接続で省くと not_found）。password は画面で入力されたもの（省くのと "" は違う："" はパスワード無しでログインする）。
   * maxRows は rows の上限（省くと 1000、最大 10000）。queryId は db.cancel で取り消すための、窓が付ける名前。
   * 断られ方：not_found（接続が無い）、password_required、db_error、busy（同時に動かせる数を超えた）、denied（権限が実行を許していない。#381）。
   * actor は誰の要求か（#381）：省くか "human" は人（窓）、"agent" はコーディングエージェント。窓は付けない（人として扱われる）
   */
  "db.query": {
    params: {
      connection: string;
      variant?: string;
      sql: string;
      password?: string;
      maxRows?: number;
      /** 前に実行した結果の続きのページ（#373）：SQL を包んで（SELECT * FROM (sql) AS q LIMIT … OFFSET offset）、この行数の後から読む。result.wrappable の文だけ */
      offset?: number;
      /** 前に実行した結果の列の位置（1 が最初の列）での並べ替え（#377）：SQL を包んで ORDER BY 位置 を付ける。省くか 0 は並べ替えない。desc は降順。result.wrappable の文だけ */
      orderBy?: number;
      desc?: boolean;
      /** 前に実行した SQL を読み直すだけの実行（ページ・並べ替え・並べ替えをやめる）：履歴に残さない（offset か orderBy があれば付けなくても残さない） */
      rerun?: boolean;
      /** スキーマを書かない名前を先に探すスキーマ（#378）：PostgreSQL は search_path の先頭に足し、MySQL は USE する。省けば DB の既定のまま */
      schema?: string;
      queryId?: string;
      actor?: "human" | "agent";
    };
    result: DbQueryResult;
  };
  /** queryId を付けた、動いている db.query を取り消す。その db.query は db_error（kind は cancelled）で返る。動いていなければ not_found */
  "db.cancel": {
    params: { queryId: string };
    result: Record<string, never>;
  };
  /**
   * 接続のスキーマ・テーブル（ビューを含む）・列の一覧を 1 回で全部返す。履歴には残らない。
   * variant・password・queryId・actor と断られ方は db.query と同じ（not_found、password_required、db_error、busy）。
   * ただし denied は無い：一覧は、実行の段階に関わらず読める（#381）
   */
  "db.schema": {
    params: {
      connection: string;
      variant?: string;
      password?: string;
      queryId?: string;
      actor?: "human" | "agent";
    };
    result: DbCatalog;
  };
  /**
   * 1 つのテーブル（ビュー）の構造（列・インデックス・外部キー。#379）を返す。schema と table は db.schema の一覧の名前のまま。
   * capabilities に "db-structure" のある kisui serve だけが受ける。履歴には残らない。
   * variant・password・queryId・actor と断られ方は db.schema と同じ（denied は無い）。テーブルが無ければ db_error（kind は query）
   */
  "db.structure": {
    params: {
      connection: string;
      variant?: string;
      password?: string;
      queryId?: string;
      actor?: "human" | "agent";
      schema: string;
      table: string;
    };
    result: DbStructure;
  };
  /**
   * 接続で実行した SQL の履歴を新しい順に返す（kisui serve のマシンに、接続ごと・環境の変種ごとに最大 1000 件残る）。
   * ほかの接続・ほかの変種の SQL は入らない。limit は返す数の上限（省くと全部）。DB にはつながない。断られ方：not_found（接続が無い）
   */
  "db.history": {
    params: { connection: string; variant?: string; limit?: number };
    result: { entries: DbHistoryEntry[] };
  };
  /**
   * 通信をプロキシに通し始める（#409）。capabilities に "proxy" がある kisui serve だけが受ける。workspaceId はターミナルのタブ
   * （そのあとに開いたペインに、プロキシと認証局の環境変数が渡る。scope は "ws:<id>" になる）、scope は内蔵ブラウザのタブ
   * （窓が決めた名前。英数字と _ . : - で 64 字まで。"ws:" では始めない）。どちらか 1 つを渡す。もう通していれば、
   * 同じ待ち受け口のまま答える（やめていたワークスペースは、記録を始め直す）。flows は、それまでに記録した通信（古い順）。
   * 断られ方：not_found（ワークスペースが無い）、busy（通している数が上限）、internal_error（認証局・待ち受けを作れない）
   */
  "proxy.start": {
    params: { scope?: string; workspaceId?: WorkspaceId };
    result: ProxyScope & { flows: ProxyFlow[] };
  };
  /**
   * 通すのをやめる。内蔵ブラウザのタブの scope は、待ち受け口を閉じて記録を捨てる。ワークスペースの scope は、新しいペインに
   * 環境変数を渡すのをやめ、待ち受け口は中継だけを続ける（環境変数を持ったままのペインのため。閉じるのはワークスペースを閉じたとき）
   */
  "proxy.stop": { params: { scope: string }; result: Record<string, never> };
  /** 通している単位の一覧（やめたあと中継だけしているワークスペースは recording が false）。 */
  "proxy.list": {
    params: Record<string, never>;
    result: { scopes: ProxyScope[] };
  };
  /** scope が記録した通信の一覧（古い順。1000 件まで）。 */
  "proxy.flows": { params: { scope: string }; result: { flows: ProxyFlow[] } };
  /** 通信 1 つの中身（要求と応答のヘッダーと本文）。もう覚えていなければ not_found。 */
  "proxy.detail": {
    params: { scope: string; id: number };
    result: ProxyFlowDetail;
  };
  /**
   * 記録した通信 from の要求を書き換えて、プロキシから送り直す（#410）。capabilities に "proxy.resend" がある kisui serve だけが受ける。
   * 送った通信は、同じ scope の記録に新しい通信（resentFrom が from）として足し、応答もそこに入る（proxy.flow で知らせる）。応答は
   * ページ・シェルには返さない。headers の Host は、url のホストの代わりに Host として送る。Content-Length・Transfer-Encoding は
   * 本文から決めるので見ない。body を省くと、元の通信の本文をそのまま送る（字でない本文・圧縮した本文もそのまま）。
   * 断られ方：not_found（scope・通信が無い）、invalid_params（メソッド・URL・ヘッダーの形が違う・この待ち受け口自身を指す・
   * body を省いたが元の本文が記録の上限で切れている）、busy（同時に送り直している数が上限）
   */
  "proxy.resend": {
    params: {
      scope: string;
      from: number;
      method: string;
      url: string;
      headers: [string, string][];
      body?: string;
    };
    result: { flow: ProxyFlow };
  };
}

/** プロキシに通している単位（#409）。 */
export interface ProxyScope {
  scope: string;
  /** ターミナルのタブの scope なら、そのワークスペース */
  workspaceId?: WorkspaceId;
  /** 待ち受け口（そのマシンの 127.0.0.1 のポート） */
  port: number;
  /** 間に入って記録しているか */
  recording: boolean;
}

/** プロキシを通った通信 1 つの、一覧の 1 行（#409。Go の proxy.Summary）。 */
export interface ProxyFlow {
  /** scope の中の通し番号（1 から） */
  id: number;
  /** 始まった時刻（Unix のミリ秒） */
  time: number;
  method: string;
  scheme: string;
  /** 行き先（既定のポートでなければ host:port） */
  host: string;
  /** パスとクエリ */
  path: string;
  /** 応答のステータス（まだ・無いときは 0） */
  status: number;
  /** pending：応答を待っている・本文を受けている。failed：つながらない・証明書が正しくない・途中で切れた */
  state: "pending" | "done" | "failed";
  error?: string;
  /** 要求・応答の本文の大きさ（通ったままの大きさ。圧縮されていれば圧縮後） */
  reqSize: number;
  respSize: number;
  durationMs: number;
  /** 応答の Content-Type の種類（text/html など） */
  mime?: string;
  /** 送り直した通信（proxy.resend。#410）なら、元の通信の id */
  resentFrom?: number;
}

/** 通信の本文（#409）。字として読めれば text、読めなければ binary。gzip・deflate は展開してある。 */
export interface ProxyBody {
  size: number;
  /** 覚える上限（256 KiB）を超えて、続きを捨てた */
  truncated?: boolean;
  text?: string;
  binary?: boolean;
  /** 展開できなかった圧縮の種類（Content-Encoding） */
  encoding?: string;
}

/** 通信 1 つの中身（#409。Go の proxy.Detail）。ヘッダーは名前の順。 */
export interface ProxyFlowDetail extends ProxyFlow {
  /** 要求の HTTP の版（HTTP/1.1・HTTP/2.0） */
  protocol: string;
  reqHeaders: [string, string][];
  respHeaders: [string, string][];
  reqBody: ProxyBody;
  respBody: ProxyBody;
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
  /** `kisui update`（#94）。手元のアプリが新しい版を調べ直し、update.result で答える */
  "update.check": { id: string };
  /**
   * `kisui pane open`（#343）。GUI のワークスペース workspace（--new なら、その名前で新しく作る）の最後に、
   * このマシンのターミナルのタブを足し（workspace.create の argv・env・name）、pane.opened で答える。フォーカスは移さない
   */
  "pane.open": PaneOpenRequest;
  /**
   * `kisui pane` の --machine（#344）。machine（[[gui.machines]] の名前。local は手元の PC）のペインへの頼み request を、
   * そのマシンの serve に pane.run で送り（open-tab は、pane.open と同じく GUI がそのマシンにタブを作る）、pane.relayed で答える
   */
  "pane.relay": PaneRelayRequest;
  /**
   * `kisui db propose`（#382）。コーディングエージェントが、このマシンの接続 connection（と variant）の DB のタブの入力欄に
   * sql を書くよう頼んだ。今のワークスペースのそのタブ（無ければ開く）に書き、db.proposed で答える。入力欄に SQL があれば、
   * 上書きの前に人に聞く
   */
  "db.propose": DbProposeRequest;
  /** db.propose の取り下げ（serve が答えを待つのをやめた：時間切れ・コマンドが止められた）。人に聞いている途中なら、聞くのをやめて書かない */
  "db.proposeCancel": { id: string };
  /** プライマリの shj（`ctl.PaneRequest` の `kind: "browser"`）・`kisui open <URL>` が、URL を手元のブラウザで開くよう頼んだ（#96）。欄は作らない。内蔵ブラウザを有効にしていればそのワークスペースの新しいタブ、無効なら外部ブラウザで開く（#203）。リモートのマシンの localhost 系は、GUI が `kisui relay` の中継越しに開く */
  "browser.open": { workspaceId: WorkspaceId; url: string };
  /** プライマリの shj が、そのワークスペースのファイルエクスプローラにキーを向けるよう頼んだ（Space e）。Esc で端末に戻る。start は、shj が引数なしで起動した直後（ツリーが整うのを待つ）。 */
  "explorer.focus": { workspaceId: WorkspaceId; start?: boolean };
  /** プライマリの shj が、サイドバーの CHANGES にキーを向けるよう頼んだ（Space E・cmd.diffchanges）。Esc・q で端末に戻る */
  "changes.focus": { workspaceId: WorkspaceId };
  notify: { level: string; text: string };
  "term.output": { termId: TermId; seq: number; data: string };
  /** `code` は、`kisui serve` が引き継いだシェル（その子でない）では分からないので無い。 */
  "term.exit": { termId: TermId; code?: number; signal?: string };
  "term.title": { termId: TermId; title: string };
  /** プロキシを通った通信が始まった・変わった（#409。同じ id の行を置き換える） */
  "proxy.flow": { scope: string; flow: ProxyFlow };
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
  /** update.check への答え（`kisui update` に渡る。serve の panecmd.UpdateResult） */
  "update.result": { id: string } & UpdateReport;
  /** pane.open への答え（`kisui pane open` に渡る）。作れたら termId、作れなければ error（そのまま kisui pane open が出す） */
  "pane.opened": { id: string } & PaneOpenReport;
  /** pane.relay への答え（`kisui pane … --machine` に渡る。serve の panecmd.Reply の形） */
  "pane.relayed": { id: string; reply: PaneRunReply };
  /** db.propose への答え（`kisui db propose` に渡る） */
  "db.proposed": { id: string } & DbProposeReport;
}

/** db.propose の中身（`kisui db propose`。#382）。 */
export interface DbProposeRequest {
  id: string;
  /** 頼んだマシンの接続の名前 */
  connection: string;
  /** 環境の変種の名前（変種の無い接続では無い） */
  variant?: string;
  /** 入力欄に書く SQL */
  sql: string;
}

/**
 * db.propose への答え（#382）。written：入力欄に書いた。declined：入力欄に SQL があり、人が上書きを断った。
 * error：書けなかった理由（そのまま kisui db propose が出す）。
 */
export type DbProposeReport =
  { status: "written" | "declined" } | { error: string };

/** pane.open の中身（`kisui pane open`。#343）。 */
export interface PaneOpenRequest {
  id: string;
  /** 足す先の GUI のワークスペースの名前（サイドバーに出ている名前） */
  workspace: string;
  /** その名前のワークスペースを新しく作る */
  new?: boolean;
  /** 新しいタブのペインの名前 */
  name: string;
  /** 始めるフォルダ（絶対パス） */
  dir: string;
  /** 動かすコマンド（無ければシェル。最初の語は絶対パス） */
  argv?: string[];
  /** コマンドの環境変数（"NAME=value"） */
  env?: string[];
}

/** pane.open への答え（#343）。 */
export type PaneOpenReport = { termId: TermId } | { error: string };

/** pane.relay の中身（#344）。 */
export interface PaneRelayRequest {
  id: string;
  /** 頼む先のマシンの名前（[[gui.machines]] の名前。local は GUI の動く手元の PC） */
  machine: string;
  request: PaneRunRequest;
}

/** 別のマシンのペインへの頼み（serve の panecmd.Request から、頼んだペインの id・秘密・マシンを除いたもの）。 */
export interface PaneRunRequest {
  /** list・send・keys・close・read・open-tab */
  cmd: string;
  /** 相手のペインの名前か id */
  to?: string;
  /** send の文字 */
  text?: string;
  /** keys のキー */
  keys?: string[];
  /** read の scrollback の行数 */
  lines?: number;
  /** open-tab のワークスペースの名前 */
  workspace?: string;
  /** open-tab で、その名前のワークスペースを新しく作る */
  new?: boolean;
  /** open-tab の新しいタブのペインの名前 */
  name?: string;
  /** open-tab で始めるフォルダ（そのマシンの絶対パス。無ければそのマシンの始めのフォルダ） */
  cwd?: string;
  /** open-tab で動かすコマンド（最初の語はそのマシンの絶対パス。無ければシェル） */
  argv?: string[];
}

/** 別のマシンのペインへの頼みの答え（serve の panecmd.Reply）。中身は見ずに、頼んだマシンへそのまま渡す。 */
export interface PaneRunReply {
  ok?: boolean;
  error?: string;
  /** 頼みが指した・作ったペインの id */
  id?: string;
  /** list の答え */
  panes?: unknown[];
  /** read の答え */
  text?: string;
}

/** 新しい版の調べ直しの答え（#94）。 */
export type UpdateReport =
  | {
      status: "available";
      current: string;
      version: string;
      notes?: string | null;
    }
  | { status: "latest"; current: string }
  | { status: "manual" }
  | { status: "failed"; error: string };
