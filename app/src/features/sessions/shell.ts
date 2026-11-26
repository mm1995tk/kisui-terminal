// Tauri の殻（src-tauri）とのやりとり。テストで差し替えられるよう、窓口は ShellApi にまとめる。

import type { ConfigMachine } from "./machines.ts";
import type { TermDefaults } from "./termDefaults.ts";

/** ssh の質問 1 つ（殻の askpass.rs の AskEvent）。 */
export interface AskpassRequest {
  requestId: number;
  conn: string;
  /**
   * 質問を出した接続の ssh の行き先。殻が ssh を起こすときに決めた値で、つなぎ先のサーバーは変えられない。
   * 窓は、これでどのマシンへの接続の質問かを出す（askpass.ts）。殻は、行き先の無い質問を窓に渡さない。
   */
  target: string;
  /** ssh が出した質問の文。つなぎ先のサーバーが決められるので、窓が出す文（マシンの名前など）とは分けて出す */
  prompt: string;
}

export interface ClosedEvent {
  id: string;
  code: number | null;
  stderr: string;
}

/** リモートに入れるものの説明。ユーザーに聞くときに見せる。 */
export interface InstallPlan {
  /** GUI の版 */
  version: string;
  /** リモートに置く場所（`~/.cache/kisui-terminal/<版>/kisui`。PATH の kisui ではない） */
  path: string;
  /** 取ってくる GitHub Release のページ */
  release_url: string;
}

/** 入れ終わった結果。 */
export interface InstallResult {
  /** 入れた場所 */
  path: string;
  /** 取った Release のアセット名 */
  asset: string;
  /** 確かめた SHA-256（取得の段階とリモートの両方で合った値） */
  sha256: string;
}

/** kisui が無いとき、`ssh host -- <kisui> attach` がこの終了コードで終わる（殻の EXIT_KISUI_MISSING と同じ値）。 */
export const EXIT_KISUI_MISSING = 97;

export type Unlisten = () => void;

/** 手元の設定ファイルの GUI の節（殻の config.rs の GuiConfig）。 */
export interface GuiConfig {
  machines: ConfigMachine[];
  /** 内蔵ブラウザのタブを使うか（[gui.browser] enabled。初めは使わない） */
  browser: boolean;
  /** 設定で足した近道（[gui.shortcuts]。キーの順。書き方と使えるコマンドかは commands.ts の setUserShortcuts が確かめる） */
  shortcuts: { key: string; command: string; source: number }[];
  /** [gui.browser] passkey_sites に書いたが、公開サフィックス（.com・.github.io）なので使わない項目（書いた形のまま。お知らせに出す） */
  passkeyRejected: string[];
  /** タブの段の高さの上限の元の値（[gui.sidebar] tabs-height。サイドバーの高さに対する %）。書いていなければ無い */
  sidebarTabsHeight?: number | null;
  /** 手元のマシンの、新しいターミナルが始まるフォルダとシェル（[server] start_dir・shell。termDefaults.ts） */
  localTerminal?: TermDefaults | null;
}

/**
 * 窓のマシンの書き込み 1 つ（殻の config_list.rs の MachineEdit）。name は付けた名前で、null・空なら名前を付けない。
 * 書く先は config.local.toml の [[gui.machines]]（config.toml には書かない）。
 */
export type MachineEdit =
  | { kind: "add"; ssh: string; name: string | null }
  | { kind: "rename"; ssh: string; name: string | null }
  | { kind: "remove"; ssh: string }
  /** 新しいターミナルが始まるフォルダとシェルを変える（termDefaults.ts）。null・空の項目は消す */
  | {
      kind: "terminal";
      ssh: string;
      startDir: string | null;
      shell: string | null;
    };

export interface ShellApi {
  listSshHosts(): Promise<string[]>;
  /**
   * 手元の設定ファイルの [[gui.machines]] と [gui.browser]。間違いがあれば「ファイル:行: 理由」の文字列で reject する
   * （そのときは何もつながずに理由だけを出す）。
   */
  configGui(): Promise<GuiConfig>;
  /**
   * 窓でマシンを足す・名前を変える・外す。config.local.toml に書き、書いたあとのマシンの一覧（configGui の machines と同じ形）を返す。
   * 書けなければ MachineEditError（machines.ts）で reject する。
   */
  editMachine(edit: MachineEdit): Promise<ConfigMachine[]>;
  /**
   * 窓で、手元のマシンの新しいターミナルが始まるフォルダとシェルを変える。config.local.toml の [server] に書き（null・空の項目は消す）、
   * 書いたあとの手元のマシンの分（configGui の localTerminal と同じ形）を返す。書く前に、使えない値
   * （無いフォルダ・実行できないシェル）でないことを殻が確かめる。書けなければ MachineEditError（machines.ts）で reject する。
   */
  editLocalTerminal(edit: {
    startDir: string | null;
    shell: string | null;
  }): Promise<TermDefaults>;
  /** target は ssh のホスト名か LOCAL。id は呼ぶ側が決める（イベントの宛先） */
  connect(id: string, target: string): Promise<void>;
  send(id: string, text: string): Promise<void>;
  disconnect(id: string): Promise<void>;
  askpassReply(requestId: number, value: string | null): Promise<void>;
  /** 入れるものの説明（ユーザーに聞く前に見せる） */
  installPlan(): Promise<InstallPlan>;
  /**
   * リモートに kisui を入れる。ユーザーが「入れる」と答えたあとにだけ呼ぶこと（ここでは聞かない）。
   * id は askpass の質問の宛先。取得した実行ファイルの SHA-256 と、リモートに置いた後の SHA-256 が
   * checksums と合わなければ、入れずに失敗する。
   */
  installRemote(id: string, target: string): Promise<InstallResult>;
  /** 入れている最中の取り消し。待っている質問と、あとで来る質問を断り、転送中の ssh を止める（installRemote は失敗して終わる） */
  installCancel(id: string): Promise<void>;
  onLine(h: (e: { id: string; line: string }) => void): Promise<Unlisten>;
  onClosed(h: (e: ClosedEvent) => void): Promise<Unlisten>;
  onAskpass(h: (e: AskpassRequest) => void): Promise<Unlisten>;
  /** 答えが済んだ（時間切れ・接続が閉じた）質問の requestId */
  onAskpassDone(h: (requestId: number) => void): Promise<Unlisten>;
  /** Mac のメニューの「閉じる」（Cmd+W）が選ばれた。PDF の欄の中を押した後は、キーが画面に届かず、これで知る（#111） */
  onCloseRequest?(h: () => void): Promise<Unlisten>;
  /** アプリの窓を閉じる */
  windowClose?(): Promise<void>;
}

/** 「ローカル」。ssh を挟まず kisui attach を直接起動する。ssh のホスト名とは取り違えない形にしてある。 */
export const LOCAL = "@local";
