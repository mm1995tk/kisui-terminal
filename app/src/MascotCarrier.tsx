// リーダーの案内を運ぶキャラクター（実験的）。案内の描画（LeaderMenu.tsx）とは分けてある。
// キャラクターは設定のフォルダの `mascot/<名前>/` に置き、`[gui] mascot` で選ぶ（mascot.ts・docs/mascot.md）。
// いつどの場面になるかはここが決める。動きは見た目だけで、キーの処理には関わらない（キーはアニメーションを待たずに効く）。
import {
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";

import styles from "./LeaderMenu.module.css";
import {
  carryDistance,
  startBye,
  startCarry,
  startRest,
} from "./mascotMotion.ts";
import {
  loadMascot,
  MASCOT_HEIGHT,
  nextAction,
  pickVariant,
  reducedMotion,
  restingScene,
  type LoadedMascot,
} from "./mascot.ts";

/** ダイアログ（`?` のキーの一覧・クリップボードの履歴など）が開いているか。開いていれば、キャラクターはその場ですぐ消える */
const dialogOpen = () => !!document.querySelector("dialog[open]");

/**
 * `open` が true の間、`menu`（案内の要素）を左端から今の位置まで押して運び、運び終えたら一息つく。
 * 閉じたら、その場でさようならを 1 回再生して消える（ダイアログが開いたときは、すぐ消える）。
 */
export function MascotCarrier(props: {
  open: () => boolean;
  menu: () => HTMLElement | undefined;
}): JSX.Element {
  const [mascot, setMascot] = createSignal<LoadedMascot | null>(null);
  /** 今出しているコマの画像（null は出していない） */
  const [frame, setFrame] = createSignal<string | null>(null);
  let charEl: HTMLDivElement | undefined;
  let stopTimers: () => void = () => {};

  onMount(() => void loadMascot().then(setMascot));
  onCleanup(() => stopTimers());

  /** 一息つく（無ければ運ぶ場面の 1 コマ目で止まる） */
  const sigh = (m: LoadedMascot) => {
    stopTimers = startRest(m, setFrame, Math.random);
  };

  /** 案内とキャラクターを、左端（サイドバーの右端）から今の位置まで動かす */
  const carry = (m: LoadedMascot) => {
    const menu = props.menu();
    if (!menu) return;
    const dx = carryDistance(menu, MASCOT_HEIGHT * m.aspect);
    stopTimers = startCarry(
      menu,
      () => charEl,
      dx,
      m.carry,
      setFrame,
      () => sigh(m),
    );
  };

  /** 案内を閉じたとき、その場でさようならを 1 回再生して消える。さようならの場面が無ければ、すぐ消える */
  const bye = (m: LoadedMascot) => {
    const scene = pickVariant(m.bye, Math.random());
    if (!scene || dialogOpen()) {
      setFrame(null);
      return;
    }
    stopTimers = startBye(
      () => charEl,
      scene,
      setFrame,
      () => setFrame(null),
      dialogOpen,
    );
  };

  createEffect(
    on(props.open, (isOpen, wasOpen) => {
      stopTimers();
      stopTimers = () => {};
      const m = mascot();
      const action = nextAction({
        isOpen,
        wasOpen,
        hasMascot: m !== null,
        reduced: reducedMotion(),
        shown: frame() !== null,
      });
      if (!m || action === "clear") {
        setFrame(null);
        return;
      }
      // さようならの後に残った位置を、新しく出すときは戻す
      if (action !== "bye" && charEl) charEl.style.transform = "";
      if (action === "carry") carry(m);
      // 視差効果を減らすとき: 動かさず、右下で一息つく場面の 1 コマ目に止まる
      else if (action === "still") setFrame(restingScene(m).frames[0]);
      else bye(m);
    }),
  );

  return (
    <Show when={frame()}>
      {(src) => (
        <div
          ref={(e) => (charEl = e)}
          class={styles.mascot}
          style={{ height: `${MASCOT_HEIGHT}px` }}
          aria-hidden="true"
        >
          <img src={src()} alt="" draggable={false} />
        </div>
      )}
    </Show>
  );
}
