// リーダーの案内を運ぶキャラクター（実験的）。案内の描画（LeaderMenu.tsx）とは分けてある。
// 画像は設定のフォルダの `mascot/` に置く（mascot.ts・README）。動きは見た目だけで、キーの処理には関わらない。
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
import { carryDistance, startCarry, startLeave } from "./mascotMotion.ts";
import {
  loadMascot,
  MASCOT_HEIGHT,
  nextAction,
  reducedMotion,
  type LoadedMascot,
} from "./mascot.ts";

type Scene = { kind: "walk"; frame: number } | { kind: "stop" };

/** `open` が true の間、`menu`（案内の要素）を左端から今の位置まで押して運ぶ。閉じるとき、出ていれば歩いて去る */
export function MascotCarrier(props: {
  open: () => boolean;
  menu: () => HTMLElement | undefined;
}): JSX.Element {
  const [mascot, setMascot] = createSignal<LoadedMascot | null>(null);
  const [scene, setScene] = createSignal<Scene | null>(null);
  let charEl: HTMLDivElement | undefined;
  let stopTimers: () => void = () => {};

  onMount(() => void loadMascot().then(setMascot));
  onCleanup(() => stopTimers());

  /** 案内とキャラクターを、左端（サイドバーの右端）から今の位置まで動かす */
  const carry = (m: LoadedMascot) => {
    const menu = props.menu();
    if (!menu) return;
    const dx = carryDistance(menu, MASCOT_HEIGHT * m.aspect);
    stopTimers = startCarry(
      menu,
      () => charEl,
      dx,
      (frame) => setScene({ kind: "walk", frame }),
      () => setScene({ kind: "stop" }),
    );
  };

  /** 案内を閉じるとき、キャラクターが歩いて右へ去る */
  const leave = () => {
    stopTimers = startLeave(
      () => charEl,
      (frame) => setScene({ kind: "walk", frame }),
      () => setScene(null),
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
        shown: scene() !== null,
      });
      if (action === "carry" && m) carry(m);
      else if (action === "leave") leave();
      else setScene(null);
    }),
  );

  const image = (): string => {
    const m = mascot();
    const s = scene();
    if (!m || !s) return "";
    if (s.kind === "walk") return m.walk[s.frame] ?? m.walk[0];
    return m.stop;
  };

  return (
    <Show when={scene()}>
      <div
        ref={(e) => (charEl = e)}
        class={styles.mascot}
        style={{ height: `${MASCOT_HEIGHT}px` }}
        aria-hidden="true"
      >
        <img src={image()} alt="" draggable={false} />
      </div>
    </Show>
  );
}
