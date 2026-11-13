// Tauri の殻（src-tauri）とのやりとり。テストで差し替えられるよう、窓口は ShellApi にまとめる。

import type { ConfigMachine } from "./machines.ts";

export interface AskpassRequest {
  requestId: number;
  conn: string;
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

export interface ShellApi {
  listSshHosts(): Promise<string[]>;
  /**
   * 手元の設定ファイルの [[gui.machines]]。間違いがあれば「ファイル:行: 理由」の文字列で reject する
   * （そのときは何もつながずに理由だけを出す）。
   */
  configMachines(): Promise<ConfigMachine[]>;
  /**
   * shijimi-editor の設定ファイルに、kisui-terminal の設定（[[gui.machines]] か [server]）が残っているか。
   * 設定は kisui-terminal 自身のファイルに移ったので、残っていれば場所が変わったことを知らせる。
   */
  configMoved(): Promise<boolean>;
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
