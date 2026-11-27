import { T } from "../../../i18n/index.ts";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  type JSX,
} from "solid-js";

import { startDrag } from "../sidebar/drag.ts";
import type { Row } from "../../../features/workspaces/rows.ts";
import { type RowEdit, SwitcherRow, SwitcherTabs } from "./SwitcherParts.tsx";
import { ModalCard, CardTitle } from "../../components/Card.tsx";
import { KeyFooter } from "../../components/KeyFooter.tsx";
import { openKeyList } from "../commands/KeyListDialog.tsx";
import { InlineInput } from "../../components/InlineInput.tsx";
import type { MachineChoice } from "./SwitcherNewTab.tsx";
import { Kbd } from "../../components/KeyHints.tsx";
import { isCancelKey } from "../../components/cancelKey.ts";
import { moveRow } from "../../../features/sessions/machineList.ts";
import {
  confirmKey,
  holdKey,
  switcherFooter,
  switcherKey,
  type SwitcherState,
} from "./switcherKey.ts";
import { newTabKindKey } from "./newTabKey.ts";
import { createSwitcherColumns, type Col } from "./switcherColumns.ts";
import { createSwitcherTabActions } from "./switcherTabActions.ts";
import { createSwitcherNewTab } from "./switcherNewTab.ts";
import {
  createSwitcherHold,
  dropTarget,
  holdItems,
  startPos,
  stepPos,
  without,
  type Hold,
} from "./switcherHold.ts";
import { startTabDrag } from "./tabMoveDrag.ts";
import "./switcher.css";

const rowId = (i: number) => `switcher-row-${i}`;
const tabId = (key: string) => `switcher-tab-${key}`;

/**
 * Workspace switcher（リーダーの `w`。#282・#296）。ワークスペースの操作（移る・作る・名前を変える・閉じる・並べ替える）は、すべてここでする。
 * Dialog の大きさはメインのウィンドウの 60%（幅も高さも。switcher.css）に固定し、中身の数では伸び縮みしない。
 * 左に全ワークスペース（サイドバーと同じ並び）、右に左で選んでいる行のタブの一覧だけを出す（左右は半分ずつ。選んでいる行と右の列は 1 枚につなげて見せる）。
 * キーは 1 つの列にだけ効く（col。左がワークスペース、右がタブ）。h l で列を移り、j k でその列の選ぶ行を動かし、Enter で開く。
 * キーは switcherKey.ts、決まりは docs/key-design.md。行を 1 回押すと選ぶだけで、選んでいる行をもう 1 回押すと開く（Enter と同じ）。
 * 行の左端のつかむ所からのドラッグで並べ替える（サイドバーの帯と同じ drag.ts。並びを覚えるのは呼んだ側）。
 * 右のタブの行を開くと、そのワークスペースのそのタブへ移る。移ったあとに Dialog を閉じるのは、呼んだ側（出すのをやめる）。
 * 右のタブの行のつかむ所からのドラッグで、タブを並べ替える・別のワークスペースへ移す（#308。tabMoveDrag.ts）。ドラッグ中に左の行の上へ来ると、
 * 右の列がそのワークスペースのタブに替わり、落とした位置に入る（左の行の上で落とすと、一番後ろに入る。空のワークスペースにも落とせる）。
 * 右の列の上の「＋」か、タブの列の n か、N（どちらの列でも）で、作るタブの種類を選ぶ（#456。種類は Dialog の Key footer にボタンで出し、字か、ボタンで決める。#487。リーダーの n は、種類を選ぶ間にして Dialog を開く）。
 * ターミナルに決めると、同じ所に、名前の入力欄とマシンを 1 行で出し、Enter でそのワークスペースのそのマシンにターミナルのタブを作る（#331。SwitcherNewTab.tsx）。
 * マシンのダイアログ（リーダーの m）の Enter は、種類を選ぶのを飛ばして、この行を、そこで選んだマシンを選んでおいて出した状態で Dialog を開く（#461。initialTerminal）。
 * ブラウザ・シークレットに決めると、そのワークスペースに新しいタブのページのブラウザのタブを開く（内蔵ブラウザが有効なときだけ選べる）。どちらも Dialog は閉じず、作ったタブを右の列で選ぶ。
 * DB に決めると、Dialog を閉じて、接続を選ぶ Dialog を出す（呼んだ側）。種類を選んでいる間は、種類の字と Esc だけを受ける（Esc は種類を選ぶのだけをやめる）。
 * タブの列の m で、選んでいるタブをキーでつかみ、別のワークスペースへ移す（#332。switcherHold.ts）。つかむとキーは左側の列へ移り、j k で移す先を選ぶと、右の列がそのワークスペースのタブに替わって、つかんだタブが一番後ろに出る。
 * 右の列で j k を押すと入る位置を 1 つずつ動かし、Enter か m で、見えている位置に落とす（onTabMove。ドラッグと同じ）。Esc で、つかんだときのワークスペースと位置に戻す（Dialog は閉じない）。つかんでいる間は、ほかのキーは効かない。
 * 名前を変えるのは、行の中の入力欄（サイドバーの帯と同じ。変換を確定する Enter では決めない）。閉じるのは、y / n で確かめてから。
 */
export function WorkspaceSwitcher(props: {
  /** 開いたときにキーを置く列（既定は左のワークスペース。タブが無いワークスペースでは左のまま） */
  initialCol?: Col;
  /** 開いたときに、選んでいるワークスペースについて、作るタブの種類を選ぶ間にしておく（リーダーの n。ワークスペースが無ければしない） */
  initialNewTab?: boolean;
  /**
   * 開いたときに、選んでいるワークスペースについて、このマシンを選んでおいたターミナルのタブを作る行を出しておく
   * （マシンのダイアログの Enter。#461。種類を選ぶのは飛ばす。ワークスペースが無ければ出さない）
   */
  initialTerminal?: string;
  /** サイドバーの行（GUI のワークスペース 1 つが 1 行）。並びは、ユーザーが並べた順 */
  rows: readonly Row[];
  /** 左の行を開いた（ワークスペースの列の Enter・選んでいる行をもう 1 回押した） */
  onGo: (row: Row) => void;
  /** 右のタブの行を開いた（タブの列の Enter・選んでいるタブの行をもう 1 回押した） */
  onTab: (gws: string, key: string) => void;
  /** 1 つ下・上へ並べ替える（J K） */
  onReorder: (gws: string, dir: "up" | "down") => void;
  /** つかんで落とした（before は、その行のすぐ前の GUI のワークスペースの id。一番後ろなら null） */
  onDrop: (gws: string, before: string | null) => void;
  /** 右のタブの行をつかんで落とした（タブ key を、ワークスペース gws の before のタブの前へ。一番後ろなら null。別のワークスペースへも移せる） */
  onTabMove: (key: string, gws: string, before: string | null) => void;
  /** 名前の入力欄で名前を決めた（空なら番号の名前）。タブの無い空のワークスペースを作って id を返す。名前が断られたら、その理由を返す（入力欄は開けたまま。Dialog は閉じない） */
  onCreate: (name: string) => { id: string } | { error: string };
  /** 作る入力欄を開くときの、空にしたときの番号の名前 */
  createInit: () => string;
  /** 名前を変える入力欄を開くときの、今の名前と、空にしたときの番号の名前 */
  renameInit: (gws: string) => { current: string; auto: string } | undefined;
  /** 入力欄で名前を決めた。断られたら、その理由を返す（入力欄は開けたまま） */
  onRename: (gws: string, name: string) => string | undefined;
  /** 閉じることを確かめた（Dialog は開けたまま。閉じられなければ、呼んだ側が理由を出す） */
  onClose: (gws: string) => void;
  /** タブの名前を変える入力欄を開くときの、今の名前と、空にしたときの名前（タブが無ければ undefined） */
  tabRenameInit: (
    gws: string,
    key: string,
  ) => { current: string; auto: string } | undefined;
  /** タブの入力欄で名前を決めた。断られたら、その理由を返す（入力欄は開けたまま） */
  onTabRename: (gws: string, key: string, name: string) => string | undefined;
  /** タブを閉じる（x・✕。確かめずに閉じ、プログラムが動いているターミナルのタブだけ、呼んだ側が確認を出す。Dialog は開けたまま） */
  onTabClose: (gws: string, key: string) => void;
  /** タブを 1 つ下・上へ並べ替える（タブの列の J K） */
  onTabReorder: (gws: string, key: string, dir: "up" | "down") => void;
  /** タブを作る入力欄に出すマシン（つながっているマシン。マシンを選ぶ Dialog と同じ） */
  machines: readonly MachineChoice[];
  /** 名前とマシンを決めた。名前が断られたら、その理由を返す（入力欄は開けたまま）。作れたら、作ったタブの key を待てる形で返す（作れなければ undefined。理由は呼んだ側が出す）。Dialog は閉じない */
  onCreateTab: (
    gws: string,
    machine: string,
    name: string,
  ) => { error: string } | { key: Promise<string | undefined> };
  /** ブラウザのタブ（incognito ならシークレットのタブ）を開く。開いたタブの key を返す。Dialog は閉じない */
  onNewBrowserTab: (gws: string, incognito: boolean) => string | undefined;
  /** DB のタブを作る（Dialog を閉じて、接続を選ぶ Dialog を出すのは、呼んだ側） */
  onNewDbTab: (gws: string) => void;
  /** 内蔵ブラウザが有効か（無効なら、作るタブの種類にブラウザとシークレットが無い） */
  browser: boolean;
  /** タブを作ろうとしたが、つながっているマシンが 1 つも無い（できないことを、呼んだ側が伝える） */
  onNoMachine: () => void;
  onCancel: () => void;
}): JSX.Element {
  // 選んでいるのは位置ではなくワークスペース。並べ替えても、同じワークスペースを選び続ける
  const [sel, setSel] = createSignal<string | undefined>(
    (props.rows.find((r) => r.band.focused) ?? props.rows[0])?.gws,
  );
  // 選んでいたワークスペースが消えたら、前の位置に寄せる（memo の前の値を使う）
  const index = createMemo((prev: number) => {
    const i = props.rows.findIndex((r) => r.gws === sel());
    return i >= 0 ? i : Math.min(prev, Math.max(0, props.rows.length - 1));
  }, 0);
  const selected = (): Row | undefined => props.rows[index()];
  // 名前を変えている行と、閉じる確認をしている行（どちらも、その行のワークスペースの id。ほかの行を選んだら、やめる）
  const [editing, setEditing] = createSignal<
    (RowEdit & { gws: string }) | undefined
  >();
  const [confirming, setConfirming] = createSignal<string | undefined>();
  // 左側の列の一番下に、新しいワークスペースの名前の入力欄を出している間（auto は空にしたときの番号の名前、error は断られた理由）
  const [creating, setCreating] = createSignal<
    { auto: string; error?: string } | undefined
  >();
  // キーが効いている列と、右の列で選んでいるタブ（switcherColumns.ts）
  const { tabs, activeCol, selectedTab, toWs, toTabs, moveTab, pickTab } =
    createSwitcherColumns(selected, props.initialCol);
  // キーでつかんでいるタブ（m）と、入る位置（switcherHold.ts）
  const hold = createSwitcherHold();
  // つかんでいるタブが、Workspace switcher の外の理由（閉じた・移したなど）でつかんだときのワークスペースから消えたら、やめる
  createEffect(() => {
    const h = hold.held();
    if (!h) return;
    const r = props.rows.find((x) => x.gws === h.from);
    if (!r?.tabs.items.some((t) => t.key === h.tab.key)) hold.stop();
  });
  /** つかんでいる間、右の列に出すタブ（つかんだタブを入る位置に入れたもの） */
  const heldItems = () => {
    const h = hold.held();
    const r = selected();
    return h && r ? holdItems(r.tabs.items, h, hold.pos()) : undefined;
  };
  let list!: HTMLUListElement;
  let right!: HTMLDivElement;
  let root!: HTMLDivElement;

  // 選ぶ行が見える所へ（一覧に収まらないと、一覧がスクロールする）
  createEffect(() => {
    const i = index();
    document.getElementById(rowId(i))?.scrollIntoView?.({ block: "nearest" });
  });
  createEffect(() => {
    selectedTab();
    right
      .querySelector(".tab-row[data-selected]")
      ?.scrollIntoView?.({ block: "nearest" });
  });
  // つかんでいる間は、つかんだタブ（入る位置）が見える所へ（移す先や入る位置を動かしたとき）
  createEffect(() => {
    if (!hold.held()) return;
    sel();
    hold.pos();
    right
      .querySelector(".tab-row[data-held]")
      ?.scrollIntoView?.({ block: "nearest" });
  });

  // 確認や入力欄を出している行が、Workspace switcher の外の理由（マシンが切れて記録から外れたなど）で消えたら、やめる（確認が見えないまま、キーが効かなくならないように）
  createEffect(() => {
    const has = (g: string) => props.rows.some((r) => r.gws === g);
    const c = confirming();
    if (c !== undefined && !has(c)) setConfirming(undefined);
    const e = editing();
    if (e && !has(e.gws)) setEditing(undefined);
  });

  /** 選ぶ行を変える。名前を変える・閉じる確認は、その行のものなので、やめる。 */
  function select(gws: string | undefined) {
    if (gws !== sel()) {
      setEditing(undefined);
      setConfirming(undefined);
      newTab.stop();
      tabActions.stop();
    }
    setSel(gws);
  }
  /** 入力欄・確認を全部やめる（どれかを始める前に呼び、ほかのものを残さない） */
  function resetInputs() {
    setEditing(undefined);
    setConfirming(undefined);
    setCreating(undefined);
    hold.stop();
    newTab.stop();
    tabActions.stop();
  }
  /** Dialog のキーが届く所（2 つの列を囲む入れ物）にフォーカスを戻す（ボタンや入力欄を使ったあと） */
  const focusList = () => root.focus();
  // 右の列のタブの操作（switcherTabActions.ts）。選ぶワークスペースを変えたら、名前を変えているタブはやめる
  const tabActions = createSwitcherTabActions({
    tabs,
    selected,
    selectedTab,
    pickTab,
    clearRowState: resetInputs,
    focusList,
    init: props.tabRenameInit,
    rename: props.onTabRename,
    close: props.onTabClose,
  });
  // 右の列のタブを作る操作（switcherNewTab.ts）
  const newTab = createSwitcherNewTab({
    selected,
    sel,
    has: (g) => props.rows.some((r) => r.gws === g),
    machineCount: () => props.machines.length,
    browser: () => props.browser,
    create: props.onCreateTab,
    openBrowser: props.onNewBrowserTab,
    openDb: props.onNewDbTab,
    noMachine: props.onNoMachine,
    pickTab,
    focusList,
    clearOthers: resetInputs,
  });
  // リーダーの n で開いたときは、種類を選ぶ間にしておく（選ぶワークスペースが無ければ、何も出さない）。
  // マシンのダイアログの Enter で開いたときは、そのマシンを選んでおいたターミナルのタブを作る行を出しておく
  if (props.initialNewTab) newTab.start();
  else if (props.initialTerminal !== undefined)
    newTab.startTerminalOn(props.initialTerminal);

  /** ワークスペースの行を押した：選んでいる行（キーが左側の列で効いているとき）をもう 1 回押すと開く。それ以外は選ぶだけ。 */
  function pressRow(r: Row) {
    // つかんでいる間は、キーで決める（押しても何もしない）
    if (hold.held()) return;
    if (
      activeCol() === "ws" &&
      selected()?.gws === r.gws &&
      !editing() &&
      confirming() === undefined
    ) {
      props.onGo(r);
      return;
    }
    select(r.gws);
    toWs();
    if (!editing()) focusList();
  }
  /** タブの行を押した：選んでいる行（キーが右の列で効いているとき）をもう 1 回押すと出す。それ以外は選ぶだけ。 */
  function pressTab(gws: string, key: string) {
    if (hold.held()) return;
    if (activeCol() === "tab" && selectedTab()?.key === key) {
      props.onTab(gws, key);
      return;
    }
    resetInputs();
    pickTab(key);
    focusList();
  }

  function startRename(r: Row) {
    const init = props.renameInit(r.gws);
    if (!init) return;
    // 押した行の操作なので、その行を選ぶ（選ぶ行が変わると、ほかの行の入力欄や確認はやめる）
    select(r.gws);
    toWs();
    resetInputs();
    setEditing({ gws: r.gws, ...init });
  }
  function startClose(r: Row) {
    select(r.gws);
    toWs();
    resetInputs();
    setConfirming(r.gws);
    focusList();
  }
  /** 左側の列の一番下に、名前の入力欄を出す（n・「ワークスペースを作る」）。ほかの入力欄・確認はやめる */
  function startCreate() {
    toWs();
    resetInputs();
    setCreating({ auto: props.createInit() });
  }
  /** 入力欄で名前を決めた。作れたら、作ったワークスペースを選ぶ（Dialog は閉じない）。断られたら、理由を出して入力欄は開けたまま */
  function submitCreate(name: string) {
    const c = creating();
    if (!c) return;
    const r = props.onCreate(name);
    if ("error" in r) {
      setCreating({ ...c, error: r.error });
      return;
    }
    setCreating(undefined);
    select(r.id);
    toWs();
    focusList();
  }
  function submitRename(name: string) {
    const e = editing();
    if (!e) return;
    const bad = props.onRename(e.gws, name);
    if (bad) setEditing({ ...e, error: bad });
    else {
      setEditing(undefined);
      focusList();
    }
  }

  /** 選んでいるタブをつかむ（タブの列の m）。つかむと、キーは左側の列（移す先を選ぶ列）へ移る */
  function startHold() {
    const r = selected();
    const t = selectedTab();
    if (!r || !t) return;
    const index = r.tabs.items.findIndex((x) => x.key === t.key);
    resetInputs();
    hold.start(t, r.gws, index);
    toWs();
  }
  /** つかんだタブを、右の列で見えている位置に落とす。元のワークスペースの元の位置のままなら、何も動かさない */
  function dropHold(h: Hold) {
    const r = selected();
    hold.stop();
    if (!r) return;
    const to = dropTarget(h, r.gws, r.tabs.items, hold.pos());
    if (to) props.onTabMove(h.tab.key, to.gws, to.before);
    // 落としたタブを選んだまま、タブの列へ（移した結果が見える。今いるワークスペースは変えない）
    pickTab(h.tab.key);
  }
  /** やめて、つかんだときのワークスペースとタブに戻す（Dialog は閉じない） */
  function cancelHold(h: Hold) {
    hold.stop();
    select(h.from);
    pickTab(h.tab.key);
  }
  /** つかんでいる間のキー。動かすのは、移す先のワークスペース（左側の列）と入る位置（右の列）だけ */
  function onHoldKey(e: KeyboardEvent, h: Hold) {
    const k = holdKey(e);
    if (!k) {
      // ほかのキーは何もしない（Dialog も閉じない）。Tab と、修飾キー付きのキーは、そのまま通す
      if (e.key !== "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey)
        e.preventDefault();
      return;
    }
    e.preventDefault();
    switch (k.kind) {
      case "move":
        if (activeCol() === "ws") {
          const to = props.rows[moveRow(index(), k.to, props.rows.length)];
          // 別のワークスペースへ移ったときだけ、入る位置を決め直す（別なら一番後ろ、元のワークスペースなら元の位置）
          if (to && to.gws !== sel()) {
            select(to.gws);
            hold.setPos(startPos(h, to.gws, to.tabs.items));
          }
        } else
          hold.setPos(
            stepPos(
              hold.pos(),
              k.to,
              without(selected()?.tabs.items ?? [], h.tab.key).length,
            ),
          );
        break;
      // 列を移るだけでは、入る位置は変えない
      case "col":
        if (k.to === "ws") toWs();
        else toTabs();
        break;
      case "drop":
        dropHold(h);
        break;
      case "cancel":
        cancelHold(h);
        break;
    }
  }

  /** 作るタブの種類を選んでいる間のキー。種類の字と Esc だけを受け、ほかのキーは何もしない（Dialog も閉じない） */
  function onNewTabKindKey(e: KeyboardEvent) {
    const k = newTabKindKey(e, newTab.kinds());
    if (!k) {
      // Tab と、修飾キー付きのキーは、そのまま通す
      if (e.key !== "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey)
        e.preventDefault();
      return;
    }
    e.preventDefault();
    switch (k.kind) {
      case "pick":
        newTab.pick(k.what);
        break;
      case "cancel":
        newTab.cancel();
        break;
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    // 名前を変える入力欄の中のキーは、入力欄が受ける（j や n を打てるように）
    if (e.target instanceof HTMLInputElement) return;
    const h = hold.held();
    if (h) {
      onHoldKey(e, h);
      return;
    }
    if (newTab.choosing()) {
      onNewTabKindKey(e);
      return;
    }
    const c = confirming();
    if (c !== undefined) {
      // 閉じる確認の間は y / n / Esc だけ（Esc は、Dialog ではなく確認をやめる）
      const k = confirmKey(e);
      if (k) {
        e.preventDefault();
        setConfirming(undefined);
        if (k === "yes") props.onClose(c);
      } else if (isCancelKey(e)) {
        e.preventDefault();
        setConfirming(undefined);
      } else if (e.key !== "Tab") e.preventDefault();
      return;
    }
    const k = switcherKey(e);
    if (!k) return;
    e.preventDefault();
    const inTabs = activeCol() === "tab";
    switch (k.kind) {
      case "move":
        if (inTabs) moveTab(k.to);
        else select(props.rows[moveRow(index(), k.to, props.rows.length)]?.gws);
        break;
      case "col":
        if (k.to === "ws") toWs();
        else toTabs();
        break;
      case "go": {
        const r = selected();
        if (!r) break;
        const t = selectedTab();
        if (inTabs && t) props.onTab(r.gws, t.key);
        else if (!inTabs) props.onGo(r);
        break;
      }
      // 並べ替える・名前を変える・閉じる・作る（n）は、効いている列の行に効く（ワークスペースの列ならワークスペース、タブの列ならタブ）。タブを作る（N）は、どちらの列でも
      case "reorder": {
        const r = selected();
        const t = selectedTab();
        if (r && inTabs && t) props.onTabReorder(r.gws, t.key, k.dir);
        else if (r && !inTabs) props.onReorder(r.gws, k.dir);
        break;
      }
      case "new":
        if (inTabs) newTab.start();
        else startCreate();
        break;
      case "newTab":
        newTab.start();
        break;
      case "rename": {
        const r = selected();
        const t = selectedTab();
        if (r && inTabs && t) tabActions.start(r.gws, t.key);
        else if (r && !inTabs) startRename(r);
        break;
      }
      case "close": {
        const r = selected();
        const t = selectedTab();
        if (r && inTabs && t) tabActions.close(r.gws, t.key);
        else if (r && !inTabs) startClose(r);
        break;
      }
      // タブの列だけ（ワークスペースの列の m は、何もしない）
      case "hold":
        if (inTabs) startHold();
        break;
      // 効いている列のキーを先に、もう片方の列のキーを後に出す
      case "help":
        openKeyList(
          inTabs ? ["switcherTabs", "switcher"] : ["switcher", "switcherTabs"],
        );
        break;
    }
  }

  /** つかむ所を押した。左の一覧の行を、真ん中の高さで比べて、落とした先の行の前へ動かす。 */
  function grab(e: PointerEvent, gws: string) {
    if (hold.held()) return;
    startDrag(e, {
      scroller: list,
      self: gws,
      rows: () =>
        [...list.querySelectorAll<HTMLElement>("li.switch-row[data-gws]")].map(
          (el) => ({ key: el.dataset.gws!, el, ref: el }),
        ),
      onDrop: (before) => props.onDrop(gws, before),
    });
  }

  /**
   * 右のタブの行のつかむ所を押した。左の行の上へ来たら、その行を選んで右の列を替える。やめたら、つかんだときのワークスペースを選び直す。
   * 落としたあとは、落とした先のワークスペースを選んだままにする（移した結果が見える）。
   */
  function grabTab(e: PointerEvent, key: string) {
    if (hold.held()) return;
    const from = selected()?.gws;
    const row = (e.currentTarget as HTMLElement).closest<HTMLElement>(
      "li.tab-row",
    );
    if (from === undefined || !row) return;
    startTabDrag(e, {
      row,
      self: key,
      left: list,
      right,
      shown: () => selected()?.gws,
      onOver: select,
      onDrop: (gws, before) => {
        props.onTabMove(key, gws, before);
        // 落としたタブを選んだまま、タブの列へ（移した結果が見える）
        pickTab(key);
      },
      onCancel: () => select(from),
    });
  }

  /** Key footer を決める、Dialog の今の状態（キーを受ける判定の順と同じ。つかんでいる → 種類を選んでいる → 名前を打っている → 確かめている → 列） */
  const footerState = (): SwitcherState => {
    if (hold.held()) return { mode: "hold" };
    if (newTab.choosing()) return { mode: "kinds", kinds: newTab.kinds() };
    if (newTab.creating()) return { mode: "typing", newTab: true };
    if (editing() || creating() || tabActions.editing())
      return { mode: "typing", newTab: false };
    if (confirming() !== undefined) return { mode: "confirm" };
    if (activeCol() === "tab" && selectedTab()) return { mode: "tab" };
    return { mode: "ws", hasWs: selected() !== undefined };
  };

  return (
    <ModalCard
      label={T("switcher.label")}
      closeOnOutside
      onCancel={props.onCancel}
      header={<CardTitle>{T("switcher.title")}</CardTitle>}
      footer={
        <KeyFooter
          rows={switcherFooter(footerState())}
          // 状態で行の数が変わる（一番多いときは 2 行）。高さは 2 行ぶんで保ち、操作の無い行は出さない
          lines={2}
          // 作るタブの種類のボタン（字を押したのと同じ）
          onPress={newTab.pick}
        />
      }
    >
      <div class="machine-dialog switcher">
        <div
          class="switcher-cols"
          role="group"
          aria-label={T("switcher.title")}
          data-holding={hold.held() ? "" : undefined}
          aria-activedescendant={
            newTab.choosing()
              ? undefined
              : activeCol() === "tab"
                ? tabId(hold.held()?.tab.key ?? selectedTab()?.key ?? "")
                : selected()
                  ? rowId(index())
                  : undefined
          }
          data-col={activeCol()}
          tabIndex={0}
          onKeyDown={onKeyDown}
          ref={(el) => {
            root = el;
            queueMicrotask(() => el.focus());
          }}
        >
          <div class="switcher-left">
            <ul
              class="card-rows switch-rows"
              role="listbox"
              aria-label={T("switcher.title")}
              ref={(el) => (list = el)}
            >
              <For each={props.rows}>
                {(r, i) => (
                  <SwitcherRow
                    id={rowId(i())}
                    row={r}
                    selected={index() === i()}
                    edit={editing()?.gws === r.gws ? editing() : undefined}
                    confirming={confirming() === r.gws}
                    heldFrom={hold.held()?.from === r.gws}
                    dropHere={
                      !!hold.held() &&
                      activeCol() === "ws" &&
                      index() === i() &&
                      hold.held()?.from !== r.gws
                    }
                    onPress={() => pressRow(r)}
                    onGrab={(e) => grab(e, r.gws)}
                    onRename={() => startRename(r)}
                    onClose={() => startClose(r)}
                    onRenameSubmit={submitRename}
                    onRenameCancel={(byKey) => {
                      setEditing(undefined);
                      if (byKey) focusList();
                    }}
                  />
                )}
              </For>
              <Show when={props.rows.length === 0 && !creating()}>
                <li class="card-empty">{T("switcher.empty")}</li>
              </Show>
              <Show when={creating()}>
                {(c) => (
                  <li class="card-row switch-row switch-create">
                    <InlineInput
                      value=""
                      label={T("sidebar.nameLabel")}
                      placeholder={T("sidebar.namePlaceholder", {
                        auto: c().auto,
                      })}
                      error={c().error}
                      onSubmit={submitCreate}
                      onCancel={(byKey) => {
                        setCreating(undefined);
                        if (byKey) focusList();
                      }}
                    />
                  </li>
                )}
              </Show>
            </ul>
            <button
              type="button"
              class="switch-new"
              tabIndex={-1}
              onClick={startCreate}
            >
              <span>+ {T("switcher.new")}</span>
              <Kbd>n</Kbd>
            </button>
          </div>
          <div class="switcher-right" ref={right}>
            <Show when={selected()}>
              {(r) => (
                <SwitcherTabs
                  row={r()}
                  items={heldItems()}
                  holding={hold.held()?.tab}
                  selectedKey={hold.held() ? undefined : selectedTab()?.key}
                  rowId={tabId}
                  onTab={pressTab}
                  onGrab={grabTab}
                  onRename={tabActions.start}
                  onClose={tabActions.close}
                  editKey={tabActions.editing()?.key}
                  edit={tabActions.editing()}
                  onRenameSubmit={tabActions.submit}
                  onRenameCancel={(byKey) => {
                    tabActions.stop();
                    if (byKey) focusList();
                  }}
                  onNewTab={newTab.start}
                  newTab={
                    newTab.creating()?.gws === r().gws
                      ? {
                          machines: props.machines,
                          initial: newTab.creating()?.machine ?? r().target,
                          error: newTab.creating()?.error,
                          onSubmit: newTab.submit,
                          onCancel: (byKey) => {
                            newTab.stop();
                            if (byKey) focusList();
                          },
                        }
                      : undefined
                  }
                />
              )}
            </Show>
          </div>
        </div>
      </div>
    </ModalCard>
  );
}
