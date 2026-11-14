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
import {
  CARRY_MS,
  LEAVE_MS,
  loadMascot,
  MASCOT_HEIGHT,
  nextAction,
  reducedMotion,
  walkFrame,
  type LoadedMascot,
} from "./mascot.ts";

type Scene =
  { kind: "walk"; frame: number } | { kind: "stop" } | { kind: "leave" };

/** `open` が true の間、`menu`（案内の要素）を左端から今の位置まで押して運ぶ。閉じるとき、あれば去る */
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
    const width = MASCOT_HEIGHT * m.aspect;
    const sidebarRight =
      document.querySelector(".sidebar-column")?.getBoundingClientRect()
        .right ?? 0;
    const dx = Math.max(
      0,
      menu.getBoundingClientRect().left - (sidebarRight + width),
    );
    const t0 = performance.now();
    setScene({ kind: "walk", frame: 0 });
    queueMicrotask(() => {
      const keyframes = [
        { transform: `translateX(${-dx}px)` },
        { transform: "none" },
      ];
      const opts = { duration: CARRY_MS, easing: "ease-out" } as const;
      menu.animate?.(keyframes, opts);
      charEl?.animate?.(keyframes, opts);
    });
    const tick = setInterval(
      () =>
        setScene({ kind: "walk", frame: walkFrame(performance.now() - t0) }),
      30,
    );
    const done = setTimeout(() => {
      clearInterval(tick);
      setScene({ kind: "stop" });
    }, CARRY_MS);
    stopTimers = () => {
      clearInterval(tick);
      clearTimeout(done);
    };
  };

  /** 案内を閉じるとき、キャラクターが右へ去る */
  const leave = () => {
    setScene({ kind: "leave" });
    queueMicrotask(() => {
      const el = charEl;
      if (!el) return;
      const dx = window.innerWidth - el.getBoundingClientRect().left;
      el.animate?.(
        [{ transform: "none" }, { transform: `translateX(${dx}px)` }],
        { duration: LEAVE_MS, easing: "ease-in" },
      );
    });
    const done = setTimeout(() => setScene(null), LEAVE_MS);
    stopTimers = () => clearTimeout(done);
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
        hasLeave: !!m?.leave,
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
    if (s.kind === "leave") return m.leave ?? m.stop;
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
