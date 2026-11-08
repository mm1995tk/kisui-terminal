// 1 つのワークスペースのターミナルを並べて持つ（F4）。設計書 docs/design/gui-protocol.md の 6 章 F の表の F4。
//
// - ワークスペースには、プライマリターミナル 1 つ（先頭。ワークスペースを閉じるまで残る）と、分割したターミナル
//   何個でもある。何があるかは shj の Workspace（primary と terms）が決め、GUI は update() で合わせる。
// - フォーカスしているワークスペースのターミナルを全部並べる。並べ方は serve が持つ分割の木（Workspace.layout。grid.ts）。今使っているもの（active）に
//   キーを向ける。最初の active はプライマリ。
// - Cmd+D・Cmd+Shift+D（Mac）か Ctrl+Shift+D・Ctrl+Shift+E で、今の欄を右か下に分けて増やす（add。term.create）。分割したターミナルのシェルが終わったら
//   （`exit`）その欄を閉じて並び直す。プライマリターミナルは、終わっても欄を閉じず、Enter で作り直す
//   （ターミナル 1 つの流量制御・取り直し・作り直しは TermLink（link.ts）がする）。
// - ターミナルでない欄（動画 #555・ブラウザ #556）も同じ木に入る。プライマリの shj が開かせたもので、
//   Workspace.extras が決める。キーを向けているのが欄かターミナルかを extraCurrent で持つ（欄を閉じるのは closeExtra）。
// - マシンの全ワークスペースの組は TermGroups が持つ。
//
// DOM を使わないので node --test で確かめられる。

import type {
  ExtraPane,
  PaneLayout,
  SplitDir,
  TermId,
  Workspace,
  WorkspaceId,
} from "../rpc/protocol.ts";
import type { TermEvent } from "../ssh/session.ts";
import {
  layoutBars,
  layoutRects,
  limitedRatio,
  neighbor,
  reconcileLayout,
  withRatio,
  type Bar,
  type Direction,
} from "./grid.ts";
import { DEFAULT_SIZE, TermLink, type TermPort } from "./link.ts";

/** ワークスペースのうち、ターミナルの並びを決める部分。 */
export type TermLayout = Pick<Workspace, "id" | "primary" | "terms"> &
  Partial<Pick<Workspace, "extras" | "layout" | "titles">>;

function sameExtra(a: ExtraPane, b: ExtraPane): boolean {
  return (
    a.id === b.id && a.kind === b.kind && a.path === b.path && a.url === b.url
  );
}

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
  /** serve が持つ欄の配置（Workspace.layout）。古い serve では undefined */
  private serverLayout?: PaneLayout;
  private layoutKey = "";
  /** 欄の名前（Workspace.titles） */
  private titleMap: Readonly<Record<string, string>> = {};
  private titleKey = "";
  private cache?: {
    ids: string;
    src?: PaneLayout;
    rev: number;
    tree?: PaneLayout;
  };
  private ratioRev = 0;
  /** 動かしている境界の、serve にまだ反映されていない割合（key は境界の B 側の左上の欄 id。grid.ts）。描くときは木に重ねる */
  private readonly ratios = new Map<string, number>();
  /** layout.resize を送っている境界、送る順番を待っている最新の割合 */
  private readonly resizing = new Set<string>();
  private readonly resizeQueued = new Map<string, number>();
  /** ターミナルでない欄（動画。#555）。並べるのはターミナルの後ろ */
  private extraList: ExtraPane[] = [];
  /** キーを向けているターミナルでない欄の id。ターミナルを使っているときは undefined */
  private extraCurrent?: string;
  /** こちらから extra.close を送った欄。shj の一覧から消えるまで、並べ直さない */
  private readonly closingExtras = new Set<string>();

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

  /** ターミナルでない欄（並べる順。ターミナルの後ろに並ぶ）。変えるたびに新しい配列にする。 */
  get extras(): readonly ExtraPane[] {
    return this.extraList;
  }

  /** キーを向けているターミナルでない欄。ターミナルを使っているときは undefined。 */
  get activeExtra(): ExtraPane | undefined {
    return this.extraList.find((x) => x.id === this.extraCurrent);
  }

  /** 欄の id（ターミナル、ターミナルでない欄の順）。 */
  get paneIds(): string[] {
    return [...this.links.map((l) => l.id), ...this.extraList.map((x) => x.id)];
  }

  /** 欄の名前（kisui pane title。欄の id -> 名前）。名前のある欄だけ入る。 */
  get titles(): Readonly<Record<string, string>> {
    return this.titleMap;
  }

  /** 欄の配置（分割の木）。serve の木を、いまある欄に合わせたもの。 */
  get layout(): PaneLayout | undefined {
    const ids = this.paneIds;
    const key = ids.join(",");
    if (
      !this.cache ||
      this.cache.ids !== key ||
      this.cache.src !== this.serverLayout ||
      this.cache.rev !== this.ratioRev
    ) {
      // 動かしている境界の割合を重ねる
      let tree = reconcileLayout(this.serverLayout, ids);
      for (const [k, r] of this.ratios) tree = withRatio(tree, k, r);
      this.cache = {
        ids: key,
        src: this.serverLayout,
        rev: this.ratioRev,
        tree,
      };
    }
    return this.cache.tree;
  }

  /** キーを向けている欄の id（ターミナルでも、ターミナルでない欄でも）。 */
  get activeId(): string | undefined {
    return this.extraCurrent ?? this.current?.id;
  }

  /** 今使っているターミナル（キーを向けるもの）。 */
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
      if (old && old.primary !== (id === layout.primary)) {
        // プライマリのシェルが終わって、分割したターミナルが昇格した（serve が決める）
        old.primary = id === layout.primary;
        old.onExit = old.primary ? undefined : () => this.exited(old);
      }
      next.push(old ?? this.newLink(id, id === layout.primary));
    }
    const lk = JSON.stringify(layout.layout ?? null);
    const layoutChanged = lk !== this.layoutKey;
    if (layoutChanged) {
      this.layoutKey = lk;
      this.serverLayout = layout.layout;
    }
    const tk = JSON.stringify(layout.titles ?? null);
    const titlesChanged = tk !== this.titleKey;
    if (titlesChanged) {
      this.titleKey = tk;
      this.titleMap = layout.titles ?? {};
    }
    const wantX = layout.extras ?? [];
    for (const id of this.closingExtras)
      if (!wantX.some((x) => x.id === id)) this.closingExtras.delete(id);
    // 変わっていない欄は同じ物のまま残す（動画の欄を作り直して、取り直さないため）
    const nextX = wantX
      .filter((x) => !this.closingExtras.has(x.id))
      .map((x) => this.extraList.find((o) => sameExtra(o, x)) ?? x);
    const sameX =
      nextX.length === this.extraList.length &&
      nextX.every((x, i) => x === this.extraList[i]);
    const same =
      next.length === this.links.length &&
      next.every((l, i) => l === this.links[i]);
    if (same && sameX) {
      if ((layoutChanged || titlesChanged) && notify) this.onChange();
      return;
    }
    const was = this.current ? this.links.indexOf(this.current) : -1;
    this.links = next;
    if (!this.current || !next.includes(this.current)) {
      this.current = next[Math.min(Math.max(was, 0), next.length - 1)];
    }
    this.extraList = nextX;
    if (!nextX.some((x) => x.id === this.extraCurrent))
      this.extraCurrent = undefined;
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
   * 今使っている欄を dir（右か下）に分けて、新しいターミナルを足して active にする（Cmd+D・Cmd+Shift+D
   * ・Ctrl+Shift+D・Ctrl+Shift+E）。フォルダは shj が決める（ワークスペースのフォルダ。未定なら start_dir）。
   * 小さすぎて分けられなければ、serve が断った理由を onError に出して false。足したら true。
   */
  async add(dir: SplitDir = "right"): Promise<boolean> {
    const target = this.activeId;
    try {
      const r = await this.port.request("term.create", {
        workspaceId: this.wsId,
        cols: DEFAULT_SIZE.cols,
        rows: DEFAULT_SIZE.rows,
        ...(target ? { split: { target, dir } } : {}),
      });
      // workspace.changed が先に届いていれば、もう並んでいる
      let l = this.links.find((x) => x.id === r.termId);
      if (!l) {
        l = this.newLink(r.termId, false);
        this.links = [...this.links, l];
      }
      this.current = l;
      this.extraCurrent = undefined;
      this.onChange();
      return true;
    } catch (e) {
      this.onError(`term.create: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }

  /** i 番目を active にする（押した欄）。 */
  setActive(i: number): void {
    const l = this.links[i];
    if (!l || (l === this.current && this.extraCurrent === undefined)) return;
    this.current = l;
    this.extraCurrent = undefined;
    this.onChange();
  }

  /** id の、ターミナルでない欄にキーを向ける（shj が欄を出した・欄を押した。#555）。無ければ false。 */
  activateExtra(id: string): boolean {
    if (!this.extraList.some((x) => x.id === id)) return false;
    if (this.extraCurrent !== id) {
      this.extraCurrent = id;
      this.onChange();
    }
    return true;
  }

  /** ターミナルでない欄を閉じる（欄の閉じるボタン・Cmd+W）。shj には extra.close を送る。 */
  closeExtra(id: string): void {
    const i = this.extraList.findIndex((x) => x.id === id);
    if (i < 0) return;
    this.extraList = this.extraList.filter((x) => x.id !== id);
    this.closingExtras.add(id);
    this.port
      .request("extra.close", { workspaceId: this.wsId, id })
      .catch(() => {});
    if (this.extraCurrent === id) this.extraCurrent = undefined;
    this.onChange();
  }

  /** termId の欄を active にする（shj が欄を出した。#553）。無ければ false。 */
  activate(termId: TermId): boolean {
    const i = this.links.findIndex((l) => l.id === termId);
    if (i < 0) return false;
    this.setActive(i);
    return true;
  }

  /** active を dir の向きの隣へ移す（Ctrl+Shift+矢印）。動いたら true。 */
  move(dir: Direction): boolean {
    const from = this.activeId;
    if (!from) return false;
    const to = neighbor(layoutRects(this.layout), from, dir);
    if (!to) return false;
    const l = this.links.find((x) => x.id === to);
    if (l) {
      this.current = l;
      this.extraCurrent = undefined;
    } else this.extraCurrent = to;
    this.onChange();
    return true;
  }

  /** 動かせる欄どうしの境界（#18）。 */
  get bars(): Bar[] {
    return layoutBars(this.layout);
  }

  /**
   * key の境界（grid.ts。B 側の左上の欄 id）を割合 ratio に動かす（ドラッグ・リサイズモードのキー）。
   * 両側が最小の大きさを下回らないように収め、すぐ画面に出して、serve に layout.resize を送る
   * （送るのは 1 境界につき 1 つずつで、待つ間に動かした分は最新の 1 つだけ送る）。serve の木が追いつくまでの間は、
   * 動かした割合を木に重ねて描く。動かせなければ（境界が無い・すでに小さすぎる）false。
   */
  setBorder(key: string, ratio: number): boolean {
    const r = limitedRatio(this.layout, key, ratio, (id) => this.sizeOf(id));
    if (r === undefined) return false;
    const cur = this.bars.find((b) => b.key === key)?.ratio;
    if (cur === r) return true;
    this.ratios.set(key, r);
    this.ratioRev++;
    this.onChange();
    this.resizeQueued.set(key, r);
    this.sendBorder(key);
    return true;
  }

  private sizeOf(id: string): { cols: number; rows: number } | undefined {
    return this.links.find((l) => l.id === id)?.size;
  }

  private sendBorder(key: string): void {
    const r = this.resizeQueued.get(key);
    if (r === undefined || this.resizing.has(key)) return;
    this.resizeQueued.delete(key);
    this.resizing.add(key);
    this.port
      .request("layout.resize", { workspaceId: this.wsId, pane: key, ratio: r })
      .catch((e) =>
        this.onError(`layout.resize: ${e instanceof Error ? e.message : e}`),
      )
      .finally(() => {
        this.resizing.delete(key);
        if (this.resizeQueued.has(key)) {
          this.sendBorder(key);
          return;
        }
        // 返事の前に workspace.changed が届くので、serve の木にはもう反映されている。重ねていた割合を外す
        this.ratios.delete(key);
        this.ratioRev++;
        this.onChange();
      });
  }

  /** 今使っている分割したターミナル（か、ターミナルでない欄）を閉じる（Cmd+W）。プライマリターミナルは閉じず false。閉じたら true。 */
  closeActive(): boolean {
    const x = this.activeExtra;
    if (x) {
      this.closeExtra(x.id);
      return true;
    }
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
