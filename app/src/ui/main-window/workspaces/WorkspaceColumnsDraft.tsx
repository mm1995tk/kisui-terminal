// 試作：ワークスペースを切り替える窓を、左にワークスペース・右に選んだワークスペースのタブの 2 列にし、
// 選んだワークスペースの行と右のタブの一覧を 1 枚につなげて見せるもの。
// Storybook で見た目と操作を試すためだけの部品で、アプリからは呼ばない。形が決まったら WorkspaceSwitcher.tsx に移す。
// 試すために、名前を変える・閉じる・作るの結果は、この部品の中の行の写しに入れる（アプリでは呼んだ側が状態を持つ）。
import { T } from "../../../i18n/index.ts";
import { createEffect, createSignal, For, Show, type JSX } from "solid-js";

import type {
  Health,
  Row,
  TabItem,
} from "../../../features/workspaces/rows.ts";
import { ModalCard, CardBody, CardTitle } from "../../components/Card.tsx";
import { InlineInput } from "../../components/InlineInput.tsx";
import { Kbd, KeyHints } from "../../components/KeyHints.tsx";
import { isComposingKey } from "../../../features/commands/ime.ts";
import { ICON } from "../sidebar/icons.ts";
import { TabRow } from "../sidebar/workspaces/TabRow.tsx";
import { startDrag } from "../sidebar/drag.ts";
import { confirmKey } from "./switcherKey.ts";
import { startTabDrag } from "./tabMoveDrag.ts";
import { type MachineChoice, NewTabDraft } from "./NewTabDraft.tsx";
import "./treeDraft.css";

const healthLabel = (h: Health): string => T(`health.${h}`);

type Col = "ws" | "tab";
/** 名前を変えている・閉じる確認をしている行（key があればタブの行） */
type Target = { gws: string; key?: string };

let seq = 0;

export function WorkspaceColumnsDraft(props: {
  rows: readonly Row[];
  onGo: (gws: string) => void;
  onTab: (gws: string, key: string) => void;
  onCancel: () => void;
  /** 作る入力欄を出した状態から始める（Storybook で見るため。"list" はマシンの一覧も開く） */
  startCreate?: "ws" | "tab" | "list";
  /** 内蔵ブラウザを有効にしているか（省くと有効）。無効なら地球儀のボタンと N を出さない */
  browser?: boolean;
}): JSX.Element {
  const [rows, setRows] = createSignal<Row[]>([...props.rows]);
  const first = rows().find((r) => r.band.focused) ?? rows()[0];
  const [gws, setGws] = createSignal(first?.gws);
  // キーが動かす列。ワークスペースの列か、タブの列か
  const [col, setCol] = createSignal<Col>("ws");
  // タブの列で選んでいるタブ（ワークスペースごとに覚える）
  const [tabSel, setTabSel] = createSignal<Record<string, string>>({});
  const [renaming, setRenaming] = createSignal<Target & { error?: string }>();
  const [confirming, setConfirming] = createSignal<Target>();
  // 作る入力欄を出している列
  const [creating, setCreating] = createSignal<Col | undefined>(
    props.startCreate === "list" ? "tab" : props.startCreate,
  );
  // キーでつかんでいるタブ（m）。from はつかんだときのワークスペース（やめたら戻す）。
  // pos は、右の列のタブ（つかんだタブを除く）の何番目の前に入るか
  const [held, setHeld] = createSignal<{
    tab: TabItem;
    from: string;
    /** つかんだときの位置（元のワークスペースに戻ったら、ここに戻す） */
    index: number;
  }>();
  const [pos, setPos] = createSignal(0);
  let root!: HTMLDivElement;

  const row = () => rows().find((r) => r.gws === gws());
  /** 右の列のタブ（つかんだタブを除く） */
  const others = () =>
    (row()?.tabs.items ?? []).filter((t) => t.key !== held()?.tab.key);
  /** 右の列に出すタブ。つかんでいる間は、つかんだタブを入る位置に出す */
  const shownTabs = (): TabItem[] => {
    const h = held();
    if (!h) return row()?.tabs.items ?? [];
    const list = others();
    return [...list.slice(0, pos()), h.tab, ...list.slice(pos())];
  };
  const tabKey = () => {
    const r = row();
    if (!r) return undefined;
    const k = tabSel()[r.gws];
    return r.tabs.items.some((t) => t.key === k) ? k : r.tabs.items[0]?.key;
  };
  const setTab = (k: string) => {
    const g = gws();
    if (g) setTabSel({ ...tabSel(), [g]: k });
  };
  /** いまキーが効いている列の、選んでいる行 */
  const target = (): Target | undefined => {
    const g = gws();
    if (!g) return undefined;
    if (col() === "ws") return { gws: g };
    const k = tabKey();
    return k ? { gws: g, key: k } : undefined;
  };
  const isTarget = (a: Target | undefined, b: Target) =>
    !!a && a.gws === b.gws && a.key === b.key;
  /** 入力欄・確認をやめて、キーを窓に戻す */
  function reset() {
    setRenaming(undefined);
    setConfirming(undefined);
    setCreating(undefined);
    root.focus();
  }

  // 選んでいるタブの行に印を付ける（タブの行は TabRow をそのまま使うので、属性はここで付ける）
  createEffect(() => {
    const h = held();
    // つかんでいる間は、つかんだタブに印を付ける
    const k = h ? h.tab.key : col() === "tab" ? tabKey() : undefined;
    shownTabs();
    root
      .querySelectorAll(".cols-tabs [data-selected], .cols-tabs [data-held]")
      .forEach((el) => {
        el.removeAttribute("data-selected");
        el.removeAttribute("data-held");
      });
    if (!k) return;
    const el = root.querySelector(`.cols-tabs li.tab-row[data-key="${k}"]`);
    el?.setAttribute(h ? "data-held" : "data-selected", "");
    el?.scrollIntoView?.({ block: "nearest" });
  });

  /** つかんだタブを落とす。左の列にいれば一番後ろ、右の列にいれば今の位置 */
  function drop() {
    const h = held();
    const g = gws();
    if (!h || !g) return;
    // 見えている位置（右の列でつかんだタブを出している所）に入れる
    const before = others()[pos()]?.key ?? null;
    setHeld(undefined);
    moveTab(h.tab.key, g, before);
    setTab(h.tab.key);
    setCol("tab");
  }
  /** つかむのをやめて、つかんだときのワークスペースに戻る */
  function cancelHold() {
    const h = held();
    if (!h) return;
    setHeld(undefined);
    setGws(h.from);
    setTab(h.tab.key);
    setCol("tab");
  }
  /** つかんでいる間のキー。動かすのは、選ぶワークスペースと入る位置だけ */
  function holdKey(e: KeyboardEvent): boolean {
    const d =
      e.key === "j" || e.key === "ArrowDown"
        ? 1
        : e.key === "k" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (d !== 0) {
      if (col() === "ws") {
        const list = rows();
        const i = list.findIndex((r) => r.gws === gws());
        const to = list[Math.max(0, Math.min(list.length - 1, i + d))];
        if (to) setGws(to.gws);
        // 別のワークスペースなら一番後ろ、元のワークスペースに戻ったら元の位置
        const h = held();
        setPos(h && to?.gws === h.from ? h.index : others().length);
      } else setPos(Math.max(0, Math.min(others().length, pos() + d)));
      return true;
    }
    switch (e.key) {
      case "h":
      case "ArrowLeft":
        // 列を移るだけでは、入る位置は変えない
        setCol("ws");
        return true;
      case "l":
      case "ArrowRight":
        setCol("tab");
        return true;
      case "Enter":
      case "m":
        drop();
        return true;
      case "Escape":
        cancelHold();
        return true;
    }
    // ほかのキーは、つかんでいる間は何もしない（窓も閉じない）
    return e.key !== "Tab";
  }

  // ---- 行の写しを変える（アプリでは呼んだ側がする）----
  const nameOf = (t: Target): string => {
    const r = rows().find((x) => x.gws === t.gws);
    if (!t.key) return r?.band.title ?? "";
    return r?.tabs.items.find((x) => x.key === t.key)?.title ?? "";
  };
  function rename(t: Target, name: string) {
    setRows(
      rows().map((r) => {
        if (r.gws !== t.gws) return r;
        if (!t.key)
          return {
            ...r,
            band: { ...r.band, title: name || r.band.autoTitle },
          };
        return {
          ...r,
          tabs: {
            ...r.tabs,
            items: r.tabs.items.map((x) =>
              x.key === t.key
                ? {
                    ...x,
                    title: name || (x.kind === "browser" ? x.tip : "zsh"),
                  }
                : x,
            ),
          },
        };
      }),
    );
  }
  function remove(t: Target) {
    if (!t.key) {
      const i = rows().findIndex((r) => r.gws === t.gws);
      const next = rows().filter((r) => r.gws !== t.gws);
      setRows(next);
      setGws(next[Math.min(i, next.length - 1)]?.gws);
      return;
    }
    setRows(
      rows().map((r) =>
        r.gws === t.gws
          ? {
              ...r,
              tabs: {
                ...r.tabs,
                items: r.tabs.items.filter((x) => x.key !== t.key),
              },
            }
          : r,
      ),
    );
    if (!row()?.tabs.items.length) setCol("ws");
  }
  function createWs(name: string) {
    const base = rows()[0];
    if (!base) return;
    const id = `new-ws-${++seq}`;
    const auto = String(rows().length + 1);
    setRows([
      ...rows(),
      {
        ...base,
        gws: id,
        band: {
          ...base.band,
          id,
          title: name || auto,
          autoTitle: auto,
          focused: false,
        },
        tabs: { items: [], shown: "", focused: false },
      },
    ]);
    setGws(id);
    setCol("ws");
  }
  /** 選べるマシン（試作では、行に出てくるマシン） */
  const machines = (): MachineChoice[] => {
    const seen = new Map<string, MachineChoice>();
    for (const r of rows())
      if (!seen.has(r.machine))
        seen.set(r.machine, {
          name: r.machine,
          color: r.color,
          health: r.health,
        });
    return [...seen.values()];
  };
  /** 選んでいるワークスペースに、新しいタブのページのブラウザのタブを開く（アプリでは、開いて窓を閉じる） */
  function createBrowserTab() {
    const r = row();
    if (!r) return;
    reset();
    const key = `new-browser-${++seq}`;
    const tab: TabItem = {
      key,
      kind: "browser",
      title: T("newTab.title"),
      path: "",
      git: "",
      tip: "",
      incognito: false,
      tab: key,
      closable: true,
    };
    setRows(
      rows().map((x) =>
        x.gws === r.gws
          ? { ...x, tabs: { ...x.tabs, items: [...x.tabs.items, tab] } }
          : x,
      ),
    );
    setTab(key);
    setCol("tab");
  }
  function createTab(name: string, machine?: string) {
    const r = row();
    const m = machines().find((x) => x.name === machine);
    const like = r?.tabs.items.find(
      (x) => x.kind === "term" && (!m || x.machine?.name === m.name),
    );
    if (!r) return;
    const key = `new-tab-${++seq}`;
    const tab: TabItem = like
      ? { ...like, key, title: name || "zsh" }
      : {
          key,
          kind: "term",
          title: name || "zsh",
          path: r.band.root,
          git: "",
          tip: r.band.root,
          incognito: false,
          machine: m ?? { name: r.machine, color: r.color, health: r.health },
          health: m?.health ?? r.health,
          term: { target: m?.name ?? r.machine, ws: key },
          closable: true,
        };
    setRows(
      rows().map((x) =>
        x.gws === r.gws
          ? { ...x, tabs: { ...x.tabs, items: [...x.tabs.items, tab] } }
          : x,
      ),
    );
    setTab(key);
    setCol("tab");
  }

  // ---- 押した・キー ----
  /** ワークスペースの行を押した：選んでいなければ選ぶ。選んでいれば移る */
  function pressWs(g: string) {
    if (col() === "ws" && gws() === g && !renaming()) props.onGo(g);
    else {
      if (gws() !== g) reset();
      setGws(g);
      setCol("ws");
    }
    root.focus();
  }
  /** タブの行を押した：選んでいなければ選ぶ。選んでいれば開く */
  function pressTab(k: string) {
    const g = gws();
    if (!g) return;
    if (col() === "tab" && tabKey() === k) props.onTab(g, k);
    else {
      setTab(k);
      setCol("tab");
    }
    root.focus();
  }
  function startRename(t: Target) {
    reset();
    setRenaming(t);
  }
  function startClose(t: Target) {
    reset();
    setConfirming(t);
  }
  function startCreate(c: Col) {
    reset();
    setCol(c);
    setCreating(c);
  }

  function onKeyDown(e: KeyboardEvent) {
    // 入力欄の中のキーは、入力欄が受ける
    if (e.target instanceof HTMLInputElement) return;
    if (isComposingKey(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    const c = confirming();
    if (c) {
      // 閉じる確認の間は y / n / Esc だけ（Esc は、窓ではなく確認をやめる）
      const k = confirmKey(e);
      if (k === "yes") remove(c);
      if (k || e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setConfirming(undefined);
      }
      return;
    }
    if (held()) {
      if (holdKey(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (e.key === "m") {
      // 右の列で選んでいるタブをつかむ
      const t = target();
      const tab = row()?.tabs.items.find((x) => x.key === t?.key);
      if (col() === "tab" && t && tab) {
        e.preventDefault();
        // 今の位置から始める（元の並びでの番号が、つかんだタブを除いた並びでの入る位置になる）
        const items = row()?.tabs.items ?? [];
        const index = items.findIndex((x) => x.key === tab.key);
        setPos(index);
        setHeld({ tab, from: t.gws, index });
        // m は別のワークスペースへ移すための操作なので、すぐ左の列（移す先を選ぶ列）へ移る
        setCol("ws");
      }
      return;
    }
    const step = (d: 1 | -1) => {
      if (col() === "ws") {
        const list = rows();
        const i = list.findIndex((r) => r.gws === gws());
        const to = list[Math.max(0, Math.min(list.length - 1, i + d))];
        if (to) setGws(to.gws);
      } else {
        const items = row()?.tabs.items ?? [];
        const i = items.findIndex((t) => t.key === tabKey());
        const to = items[Math.max(0, Math.min(items.length - 1, i + d))];
        if (to) setTab(to.key);
      }
    };
    switch (e.key) {
      case "j":
      case "ArrowDown":
        step(1);
        break;
      case "k":
      case "ArrowUp":
        step(-1);
        break;
      case "h":
      case "ArrowLeft":
        setCol("ws");
        break;
      case "l":
      case "ArrowRight":
        if (row()?.tabs.items.length) setCol("tab");
        break;
      case "Enter": {
        const t = target();
        if (t?.key) props.onTab(t.gws, t.key);
        else if (t) props.onGo(t.gws);
        break;
      }
      case "r": {
        const t = target();
        if (t) startRename(t);
        break;
      }
      case "x": {
        const t = target();
        if (t) startClose(t);
        break;
      }
      case "N":
        if (props.browser ?? true) createBrowserTab();
        break;
      case "n":
        startCreate(col());
        break;
      case "J":
      case "K": {
        const d = e.key === "J" ? 1 : -1;
        const g = gws();
        if (!g) break;
        if (col() === "ws") {
          const order = rows().map((r) => r.gws);
          const i = order.indexOf(g);
          const j = i + d;
          if (j < 0 || j >= order.length) break;
          // 1 つ下なら 2 つ下の行の前へ、1 つ上なら 1 つ上の行の前へ
          moveWs(g, d === 1 ? (order[j + 1] ?? null) : order[j]!);
        } else {
          const items = row()?.tabs.items.map((t) => t.key) ?? [];
          const k = tabKey();
          const i = k ? items.indexOf(k) : -1;
          const j = i + d;
          if (!k || j < 0 || j >= items.length) break;
          moveTab(k, g, d === 1 ? (items[j + 1] ?? null) : items[j]!);
        }
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  }

  // ---- 並べ替え（アプリでは呼んだ側がする）----
  /** ワークスペース g を、before の前へ（null なら一番後ろ） */
  function moveWs(g: string, before: string | null) {
    const me = rows().find((r) => r.gws === g);
    if (!me || before === g) return;
    const rest = rows().filter((r) => r.gws !== g);
    const at =
      before === null ? rest.length : rest.findIndex((r) => r.gws === before);
    rest.splice(at < 0 ? rest.length : at, 0, me);
    setRows(rest);
  }
  /** タブ key を、ワークスペース to の before の前へ（null なら一番後ろ。別のワークスペースへも移す） */
  function moveTab(key: string, to: string, before: string | null) {
    const tab = rows()
      .flatMap((r) => r.tabs.items)
      .find((t) => t.key === key);
    if (!tab || before === key) return;
    setRows(
      rows().map((r) => {
        const items = r.tabs.items.filter((t) => t.key !== key);
        if (r.gws === to) {
          const at =
            before === null
              ? items.length
              : items.findIndex((t) => t.key === before);
          items.splice(at < 0 ? items.length : at, 0, tab);
        }
        return items.length === r.tabs.items.length && r.gws !== to
          ? r
          : { ...r, tabs: { ...r.tabs, items } };
      }),
    );
  }
  let list!: HTMLUListElement;
  let right!: HTMLDivElement;
  /** ワークスペースの行のつかむ所を押した */
  function grabWs(e: PointerEvent, g: string) {
    startDrag(e, {
      scroller: list,
      self: g,
      rows: () =>
        [...list.querySelectorAll<HTMLElement>("li.switch-row[data-gws]")].map(
          (el) => ({ key: el.dataset.gws!, el, ref: el }),
        ),
      onDrop: (before) => moveWs(g, before),
    });
  }
  /** タブの行のつかむ所を押した。左の行の上へ来たら、そのワークスペースのタブに替える（落とすと、そこへ移る） */
  function grabTab(e: PointerEvent, key: string) {
    const from = gws();
    const el = (e.currentTarget as HTMLElement).closest<HTMLElement>(
      "li.tab-row",
    );
    if (from === undefined || !el) return;
    startTabDrag(e, {
      row: el,
      self: key,
      left: list,
      right,
      shown: () => gws(),
      onOver: (g) => setGws(g),
      onDrop: (g, before) => {
        moveTab(key, g, before);
        setTab(key);
        setCol("tab");
      },
      onCancel: () => setGws(from),
    });
  }

  /** 作る入力欄。空で決めると、番号の名前（ワークスペース）か zsh（タブ）になる */
  const createInput = (c: Col, auto: string) => (
    <InlineInput
      value=""
      label={c === "ws" ? T("sidebar.nameLabel") : T("sidebar.tabNameLabel")}
      placeholder={T("sidebar.namePlaceholder", { auto })}
      onSubmit={(name) => {
        if (c === "ws") createWs(name);
        else createTab(name);
        reset();
      }}
      onCancel={() => reset()}
    />
  );
  const confirmMark = (title: string) => (
    <span
      class="switch-confirm"
      role="alert"
      aria-label={T("switcher.confirmClose", { title })}
    >
      <Kbd>y</Kbd> <Kbd>n</Kbd>
    </span>
  );

  return (
    <ModalCard
      label={T("switcher.label")}
      closeOnOutside
      onCancel={props.onCancel}
      header={<CardTitle>{T("switcher.title")}</CardTitle>}
      footer={
        <CardBody>
          <Show when={held()}>
            <KeyHints
              items={[
                { keys: ["j", "k"], label: T("switcher.keys.holdMove") },
                { keys: ["h", "l"], label: T("switcher.keys.cols") },
                { keys: ["Enter"], label: T("switcher.keys.holdDrop") },
                { keys: ["Esc"], label: T("switcher.keys.holdCancel") },
              ]}
            />
          </Show>
          <Show when={!held()}>
            <KeyHints
              items={[
                { keys: ["j", "k"], label: T("machineDialog.keys.select") },
                { keys: ["h", "l"], label: T("switcher.keys.cols") },
                { keys: ["Enter"], label: T("switcher.keys.open") },
                {
                  keys: ["n"],
                  label:
                    col() === "tab"
                      ? T("switcher.keys.newTermTab")
                      : T("switcher.keys.new"),
                },
                ...((props.browser ?? true)
                  ? [{ keys: ["N"], label: T("switcher.keys.newBrowser") }]
                  : []),
                { keys: ["r"], label: T("switcher.keys.rename") },
                { keys: ["x"], label: T("switcher.keys.closeItem") },
                { keys: ["J", "K"], label: T("switcher.keys.reorder") },
                ...(col() === "tab"
                  ? [{ keys: ["m"], label: T("switcher.keys.hold") }]
                  : []),
                { keys: ["Esc"], label: T("switcher.keys.close") },
              ]}
            />
          </Show>
        </CardBody>
      }
    >
      <div
        class="tree-draft cols-draft"
        data-col={col()}
        data-holding={held() ? "" : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        ref={(el) => {
          root = el;
          queueMicrotask(() => el.focus());
        }}
      >
        <div class="cols-left">
          <ul class="cols-ws" ref={list}>
            <For each={rows()}>
              {(r) => {
                const t = { gws: r.gws };
                const on = () => gws() === r.gws;
                return (
                  <li
                    class="switch-row cols-ws-row"
                    data-gws={r.gws}
                    data-on={on() ? "" : undefined}
                    data-held-from={held()?.from === r.gws ? "" : undefined}
                    onClick={() => pressWs(r.gws)}
                  >
                    <span
                      class="grip"
                      data-grab=""
                      aria-hidden="true"
                      onPointerDown={(e) => grabWs(e, r.gws)}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span
                      class="switch-dot"
                      data-health={r.health}
                      style={{ "--machine-color": r.color }}
                      role="img"
                      aria-label={healthLabel(r.health)}
                    />
                    <Show
                      when={isTarget(renaming(), t)}
                      fallback={
                        <span class="tree-ws-name">
                          {r.band.title}
                          <Show
                            when={
                              held() &&
                              on() &&
                              col() === "ws" &&
                              held()?.from !== r.gws
                            }
                          >
                            <span class="cols-drop-here">
                              {T("switcher.dropHere")}
                            </span>
                          </Show>
                        </span>
                      }
                    >
                      <InlineInput
                        value={nameOf(t)}
                        label={T("sidebar.nameLabel")}
                        placeholder={T("sidebar.namePlaceholder", {
                          auto: r.band.autoTitle,
                        })}
                        onSubmit={(name) => {
                          rename(t, name);
                          reset();
                        }}
                        onCancel={() => reset()}
                      />
                    </Show>
                    <Show
                      when={isTarget(confirming(), t)}
                      fallback={
                        <Show when={!isTarget(renaming(), t)}>
                          <button
                            type="button"
                            class="switch-btn"
                            tabIndex={-1}
                            aria-label={T("sidebar.renameBand", {
                              title: r.band.title,
                            })}
                            onClick={(e) => {
                              e.stopPropagation();
                              startRename(t);
                            }}
                          >
                            <span class="nf" aria-hidden="true">
                              {ICON.pencil}
                            </span>
                          </button>
                          <button
                            type="button"
                            class="switch-btn"
                            tabIndex={-1}
                            aria-label={T("sidebar.closeBand", {
                              title: r.band.title,
                            })}
                            onClick={(e) => {
                              e.stopPropagation();
                              startClose(t);
                            }}
                          >
                            <span class="nf" aria-hidden="true">
                              {ICON.close}
                            </span>
                          </button>
                        </Show>
                      }
                    >
                      {confirmMark(r.band.title)}
                    </Show>
                  </li>
                );
              }}
            </For>
            <Show when={creating() === "ws"}>
              <li class="cols-ws-row cols-create">
                {createInput("ws", String(rows().length + 1))}
              </li>
            </Show>
          </ul>
          <button
            type="button"
            class="switch-new cols-new"
            tabIndex={-1}
            onClick={() => startCreate("ws")}
          >
            <span>+ {T("switcher.new")}</span>
            <Kbd>n</Kbd>
          </button>
        </div>
        <div class="cols-panel" ref={right}>
          <Show when={row()}>
            {(r) => (
              <div class="switch-tabs cols-tabs">
                <div class="cols-head">
                  <Show
                    when={held()}
                    fallback={
                      <span>
                        {T("switcher.tabCount", { n: r().tabs.items.length })}
                      </span>
                    }
                  >
                    {(h) => (
                      <span class="cols-holding">
                        {T("switcher.holding", { title: h().tab.title })}
                      </span>
                    )}
                  </Show>
                  <span class="cols-head-btns">
                    <Show when={props.browser ?? true}>
                      <button
                        type="button"
                        class="switch-btn cols-add"
                        tabIndex={-1}
                        aria-label={T("leader.browser.new")}
                        title={`${T("leader.browser.new")} (N)`}
                        onClick={() => createBrowserTab()}
                      >
                        <span class="nf" aria-hidden="true">
                          {ICON.globe}
                        </span>
                      </button>
                    </Show>
                    <button
                      type="button"
                      class="switch-btn cols-add"
                      tabIndex={-1}
                      aria-label={T("switcher.newTab")}
                      title={`${T("switcher.newTab")} (n)`}
                      onClick={() => startCreate("tab")}
                    >
                      <span class="nf" aria-hidden="true">
                        {ICON.plus}
                      </span>
                    </button>
                  </span>
                </div>
                <ul class="tab-rows">
                  <For each={shownTabs()}>
                    {(t) => {
                      const me = () => ({ gws: r().gws, key: t.key });
                      return (
                        <TabRow
                          t={t}
                          shown={r().tabs.shown === t.key}
                          current={r().tabs.shown === t.key && r().tabs.focused}
                          onTab={() => pressTab(t.key)}
                          onGrab={(e) => grabTab(e, t.key)}
                          onRename={() => startRename(me())}
                          onClose={() => startClose(me())}
                          edit={
                            isTarget(renaming(), me())
                              ? t.kind === "browser"
                                ? { current: t.title, auto: t.tip }
                                : { current: t.title, auto: "zsh" }
                              : undefined
                          }
                          onRenameSubmit={(name) => {
                            rename(me(), name);
                            reset();
                          }}
                          onRenameCancel={() => reset()}
                        />
                      );
                    }}
                  </For>
                  <Show when={creating() === "tab"}>
                    <li class="tab-row cols-create">
                      <div class="tab-line">
                        <NewTabDraft
                          machines={machines()}
                          initial={r().machine}
                          listOpen={props.startCreate === "list"}
                          placeholder={T("sidebar.namePlaceholder", {
                            auto: "zsh",
                          })}
                          onSubmit={(name, machine) => {
                            createTab(name, machine);
                            reset();
                          }}
                          onCancel={() => reset()}
                        />
                      </div>
                    </li>
                  </Show>
                </ul>
                <Show when={confirming()?.key && confirming()?.gws === r().gws}>
                  <p class="cols-confirm">
                    {confirmMark(nameOf(confirming()!))}{" "}
                    {T("switcher.confirmClose", {
                      title: nameOf(confirming()!),
                    })}
                  </p>
                </Show>
                <Show
                  when={r().tabs.items.length === 0 && creating() !== "tab"}
                >
                  <p class="card-empty">{T("switcher.noTabs")}</p>
                </Show>
              </div>
            )}
          </Show>
        </div>
      </div>
    </ModalCard>
  );
}
