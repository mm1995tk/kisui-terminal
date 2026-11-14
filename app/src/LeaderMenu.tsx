// リーダーの案内。リーダー（Mac は Cmd+K、Linux は Ctrl+Shift+K）を押すと、次に押せるキーとその動きを画面の右下に出す（which-key。
// shijimi-editor の Space の案内と同じ考え）。中身は、コマンドの表（commands.ts）の今の段の一覧そのもの。
// 一覧は押せず、フォーカスも取らない。キーは押した瞬間にフォーカスがあったペインに向いたまま。
//
// 実験的: 設定のフォルダの `mascot/` に画像があるときだけ、キャラクターが案内を左端から右下まで押して運ぶ（mascot.ts）。
// 動きは見た目だけで、キーの処理には関わらない（運んでいる途中でも、次のキーはすぐ効く）。
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";

import { leaderKeyName, menuRows, type Path } from "./commands.ts";
import { IS_MAC } from "./guiKeys.ts";
import styles from "./LeaderMenu.module.css";
import {
  CARRY_MS,
  LEAVE_MS,
  loadMascot,
  MASCOT_HEIGHT,
  reducedMotion,
  walkFrame,
} from "./mascot.ts";

const [leaderPath, setLeaderPath] = createSignal<Path | null>(null);

/** リーダーに入っているときの木の中の位置（入っていなければ null）。App のキーの処理が書く。 */
export { leaderPath, setLeaderPath };

type Loaded = NonNullable<Awaited<ReturnType<typeof loadMascot>>>;
type Scene =
  { kind: "walk"; frame: number } | { kind: "stop" } | { kind: "leave" };

/** リーダーの中のとき、次に押せるキーの一覧を出す。入っていなければ何も出さない。 */
export function LeaderMenu(): JSX.Element {
  const [mascot, setMascot] = createSignal<Loaded | null>(null);
  const [scene, setScene] = createSignal<Scene | null>(null);
  let menuEl: HTMLDivElement | undefined;
  let charEl: HTMLDivElement | undefined;
  let stopTimers: () => void = () => {};
  const open = createMemo(() => leaderPath() !== null);

  onMount(() => void loadMascot().then(setMascot));
  onCleanup(() => stopTimers());

  /** 案内とキャラクターを、左端（サイドバーの右端）から今の位置まで動かす */
  const carry = (m: Loaded) => {
    const menu = menuEl;
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
    on(open, (isOpen, wasOpen) => {
      stopTimers();
      stopTimers = () => {};
      const m = mascot();
      const moving = m !== null && !reducedMotion();
      if (isOpen) {
        if (moving) carry(m);
        else setScene(null);
      } else if (wasOpen && moving && m.leave && scene() !== null) {
        leave();
      } else {
        setScene(null);
      }
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
    <>
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
      <Show when={leaderPath()}>
        {(path) => {
          const rows = () => menuRows(path(), IS_MAC);
          return (
            <div
              ref={(e) => (menuEl = e)}
              class={styles.menu}
              role="status"
              aria-label="リーダー"
            >
              <p class={styles.path}>
                {[leaderKeyName(IS_MAC), ...path()].join(" ")}
              </p>
              <ul class={styles.rows}>
                <For each={rows()}>
                  {(n) => (
                    <li class={styles.row}>
                      <kbd class={styles.key}>{n.keys}</kbd>
                      <span classList={{ [styles.group]: n.group }}>
                        {n.label}
                        {n.group ? " ›" : ""}
                      </span>
                    </li>
                  )}
                </For>
              </ul>
              <p class={styles.foot}>
                Esc で出る{path().length > 0 ? " ・ Backspace で一段戻る" : ""}
              </p>
            </div>
          );
        }}
      </Show>
    </>
  );
}
