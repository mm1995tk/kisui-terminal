// 1 つのワークスペースのターミナルを並べて持つ（F4）。設計書 docs/design/gui-protocol.md の 6 章 F の表の F4。
//
// - ワークスペースには、プライマリターミナル 1 つ（先頭。ワークスペースを閉じるまで残る）と、分割したターミナル
//   0〜5 個がある。何があるかは shj の Workspace（primary と terms）が決め、GUI は update() で合わせる。
// - ターミナルモードでは、フォーカスしているワークスペースのターミナルを全部（6 個まで）並べる。IDE モードの
//   右下に出すのは、そのうちの 1 つ（今使っているもの = active）。並べ方は grid.ts。最初の active はプライマリ。
// - Ctrl+Shift+T で分割したターミナルを増やす（add。term.create）。分割したターミナルのシェルが終わったら
//   （`exit`）その欄を閉じて並び直す。プライマリターミナルは、終わっても欄を閉じず、Enter で作り直す
//   （ターミナル 1 つの流量制御・取り直し・作り直しは TermLink（link.ts）がする）。
// - マシンの全ワークスペースの組は TermGroups が持つ。
//
// DOM を使わないので node --test で確かめられる。

import type { TermId, Workspace, WorkspaceId } from "../rpc/protocol.ts";
import type { TermEvent } from "../ssh/session.ts";
import { MAX_TERMS, neighbor, type Direction } from "./grid.ts";
import { DEFAULT_SIZE, TermLink, type TermPort } from "./link.ts";

/** ワークスペースのうち、ターミナルの並びを決める部分。 */
export type TermLayout = Pick<Workspace, "id" | "primary" | "terms">;

/** 1 つのワークスペースのターミナルの並びと、今使っている 1 つ（active）を持つ。並びか active が変わったら onChange を呼ぶ。 */
export class TermGroup {
  private readonly port: TermPort;
  private readonly wsId: WorkspaceId;
  private readonly onChange: () => void;
  private readonly onError: (message: string) => void;
  private links: TermLink[] = [];
  private current?: TermLink;
  /** こちらから term.close を送った分割ターミナル。shj の一覧から消えるまで、並べ直さない */
  private readonly closing = new Set<TermId>();
  /** term.create の返事待ちの数（上限の数え方に入れる） */
  private creating = 0;

  constructor(
    port: TermPort,
    layout: TermLayout,
    onChange: () => void,
    onError: (message: string) => void = () => {},
  ) {
    this.port = port;
    this.wsId = layout.id;
    this.onChange = onChange;
    this.onError = onError;
    this.update(layout, false);
  }

  /** 並べるターミナル（並べる順。先頭がプライマリ）。変えるたびに新しい配列にする。 */
  get list(): readonly TermLink[] {
    return this.links;
  }

  /** 今使っているターミナル（IDE モードの右下に出すもの・キーを向けるもの）。 */
  get active(): TermLink | undefined {
    return this.current;
  }

  /**
   * shj の一覧に合わせる（workspace.list・workspace.changed のあと）。残るものはそのまま、増えたものは足し、
   * 消えたものは外す。active が消えたら隣へ移す。
   */
  update(layout: TermLayout, notify = true): void {
    const want = [layout.primary, ...layout.terms];
    for (const id of this.closing)
      if (!want.includes(id)) this.closing.delete(id);
    const next: TermLink[] = [];
    for (const id of want) {
      if (this.closing.has(id)) continue;
      const old = this.links.find((l) => l.id === id);
      next.push(old ?? this.newLink(id, id === layout.primary));
    }
    const same =
      next.length === this.links.length &&
      next.every((l, i) => l === this.links[i]);
    if (same) return;
    const was = this.current ? this.links.indexOf(this.current) : -1;
    this.links = next;
    if (!this.current || !next.includes(this.current)) {
      this.current = next[Math.min(Math.max(was, 0), next.length - 1)];
    }
    if (notify) this.onChange();
  }

  /** shj からの通知。termId が合うものが受ける。 */
  handle(e: TermEvent): void {
    for (const l of this.links) l.handle(e);
  }

  /** つなぎ直した。それぞれ続きから取り直す。 */
  reconnected(): void {
    for (const l of this.links) l.reconnected();
  }

  /**
   * 分割したターミナルを足して active にする（Ctrl+Shift+T）。フォルダは shj が決める
   * （ワークスペースのフォルダ。未定なら start_dir）。上限なら足さずに false。足したら true。
   */
  async add(): Promise<boolean> {
    if (this.links.length + this.creating >= MAX_TERMS) return false;
    this.creating++;
    try {
      const r = await this.port.request("term.create", {
        workspaceId: this.wsId,
        cols: DEFAULT_SIZE.cols,
        rows: DEFAULT_SIZE.rows,
      });
      // workspace.changed が先に届いていれば、もう並んでいる
      let l = this.links.find((x) => x.id === r.termId);
      if (!l) {
        l = this.newLink(r.termId, false);
        this.links = [...this.links, l];
      }
      this.current = l;
      this.onChange();
      return true;
    } catch (e) {
      this.onError(`term.create: ${e instanceof Error ? e.message : e}`);
      return false;
    } finally {
      this.creating--;
    }
  }

  /** i 番目を active にする（押した欄）。 */
  setActive(i: number): void {
    const l = this.links[i];
    if (!l || l === this.current) return;
    this.current = l;
    this.onChange();
  }

  /** active を dir の向きの隣へ移す（Ctrl+Shift+矢印）。動いたら true。 */
  move(dir: Direction): boolean {
    const i = this.current ? this.links.indexOf(this.current) : -1;
    if (i < 0) return false;
    const j = neighbor(i, this.links.length, dir);
    if (j === i) return false;
    this.current = this.links[j];
    this.onChange();
    return true;
  }

  /** 今使っている分割したターミナルを閉じる（Cmd+W）。プライマリターミナルは閉じず false。閉じたら true。 */
  closeActive(): boolean {
    const l = this.current;
    if (!l || l.primary || !this.links.includes(l)) return false;
    this.exited(l);
    return true;
  }

  private newLink(id: TermId, primary: boolean): TermLink {
    const l = new TermLink(this.port, id, this.onError, { primary });
    if (!primary) l.onExit = () => this.exited(l);
    return l;
  }

  /** 分割したターミナルのシェルが終わった。欄を閉じて並び直す。 */
  private exited(l: TermLink): void {
    if (!this.links.includes(l)) return;
    const i = this.links.indexOf(l);
    this.links = this.links.filter((x) => x !== l);
    l.onExit = undefined;
    this.closing.add(l.id);
    this.port.request("term.close", { termId: l.id }).catch(() => {});
    if (this.current === l)
      this.current = this.links[Math.min(i, this.links.length - 1)];
    this.onChange();
  }
}

/** 1 つのマシンの、ワークスペースごとの TermGroup。 */
export class TermGroups {
  private readonly port: TermPort;
  private readonly onChange: () => void;
  private readonly onError: (message: string) => void;
  private readonly groups = new Map<WorkspaceId, TermGroup>();

  constructor(
    port: TermPort,
    onChange: () => void,
    onError: (message: string) => void = () => {},
  ) {
    this.port = port;
    this.onChange = onChange;
    this.onError = onError;
  }

  /** そのワークスペースのターミナル。一覧に無ければ undefined。 */
  get(id: WorkspaceId): TermGroup | undefined {
    return this.groups.get(id);
  }

  /** ワークスペースの一覧に合わせる。増えたものは作り、消えたものは忘れる（シェルは shj が終わらせる）。 */
  sync(workspaces: readonly TermLayout[]): void {
    const ids = new Set(workspaces.map((w) => w.id));
    let changed = false;
    for (const id of [...this.groups.keys()]) {
      if (!ids.has(id)) {
        this.groups.delete(id);
        changed = true;
      }
    }
    for (const w of workspaces) {
      const g = this.groups.get(w.id);
      if (g) g.update(w);
      else {
        this.groups.set(
          w.id,
          new TermGroup(this.port, w, this.onChange, this.onError),
        );
        changed = true;
      }
    }
    if (changed) this.onChange();
  }

  /** shj からの通知を、ターミナルを持つグループに渡す。 */
  handle(e: TermEvent): void {
    for (const g of this.groups.values()) g.handle(e);
  }

  /** つなぎ直した。 */
  reconnected(): void {
    for (const g of this.groups.values()) g.reconnected();
  }
}
