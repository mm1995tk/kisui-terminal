// ワークスペースの中のタブの行（ターミナルのタブとブラウザのタブ）。サイドバーの帯と、ワークスペースを切り替える窓（ui/main-window/workspaces/SwitcherParts.tsx）が使う。
import { T } from "../../../../i18n/index.ts";
import { Show, type JSX } from "solid-js";

import type { Health, TabItem } from "../../../../features/workspaces/rows.ts";
import { startDrag } from "../drag.ts";
import type { Handlers } from "../handlers.ts";
import { ICON } from "../icons.ts";
import { Grip, Nf, titleIfClipped } from "./parts.tsx";

const healthLabel = (h: Health): string => T(`health.${h}`);

/** 一覧にいまある帯（li.band-item）。上から順。 */
const bandElements = (scroller: HTMLElement): HTMLElement[] => [
  ...scroller.querySelectorAll<HTMLElement>("li.band-item[data-gws]"),
];

/** タブの行のつかむ所を押した。同じ帯の中のタブの行だけを相手にする（別の帯には落とせない）。 */
export function grabTab(
  e: PointerEvent,
  gws: string,
  key: string,
  onMove: NonNullable<Handlers["onTabMove"]>,
) {
  const nav = (e.currentTarget as HTMLElement).closest<HTMLElement>(
    "nav.sidebar",
  );
  if (!nav) return;
  // 3 段のときは、タブの段がスクロールする
  const scroller =
    (nav.hasAttribute("data-sections")
      ? nav.querySelector<HTMLElement>(".tab-rows")
      : null) ?? nav;
  startDrag(e, {
    scroller,
    self: key,
    confine: true,
    // 帯もタブの行も、描き直されて作り直されることがあるので、そのたびに一覧から引き直す
    rows: () => {
      const band = bandElements(nav).find((el) => el.dataset.gws === gws);
      return [
        ...(band?.querySelectorAll<HTMLElement>(
          ":scope > ul.tab-rows > li.tab-row[data-key]",
        ) ?? []),
      ].map((el) => ({
        key: el.dataset.key!,
        el,
        ref: el.querySelector<HTMLElement>(".tab-line") ?? el,
      }));
    },
    onDrop: (before) => onMove(gws, key, before),
  });
}

/**
 * タブの行 1 つ（ターミナルのタブもブラウザのタブも）。
 * ターミナルのタブは 1 行目にアイコン・名前・マシンの札、2 行目にフォルダ、3 行目に git。ブラウザのタブは 1 行目にアイコン・名前、2 行目に URL。
 * 鉛筆と ✕ は、1 行目の右に場所を空けておき、出ているときだけ見せる（選んでも行の高さが変わらないように）。
 */
export function TabRow(props: {
  t: TabItem;
  /** そのワークスペースで出しているタブか */
  shown: boolean;
  /** 出しているタブで、そのワークスペースにフォーカスしているか（強く光らせる） */
  current: boolean;
  onTab: () => void;
  /** 省くと ✕ を出さない（切り替えの窓の右のタブの一覧） */
  onClose?: () => void;
  onRename?: () => void;
  /** つかむ所を押した（ドラッグで並べ替える）。省くと動かせない */
  onGrab?: (e: PointerEvent) => void;
}): JSX.Element {
  const t = () => props.t;
  return (
    <li
      class="tab-row"
      data-key={t().key}
      data-kind={t().kind}
      data-health={t().health}
      data-shown={props.shown ? "" : undefined}
      data-current={props.current ? "" : undefined}
    >
      <div class="tab-line">
        <Grip onGrab={props.onGrab} />
        <button
          type="button"
          class="tab-main"
          title={t().tip || undefined}
          aria-current={props.current ? "page" : undefined}
          onClick={() => props.onTab()}
        >
          <span class="tab-l1">
            <Show
              when={t().favicon}
              fallback={
                <Nf
                  class="tab-icon"
                  c={t().kind === "term" ? ICON.terminal : ICON.globe}
                />
              }
            >
              {(src) => <img class="tab-icon tab-favicon" src={src()} alt="" />}
            </Show>
            <Show when={t().incognito}>
              <span class="tab-incognito">{T("sidebar.incognito")}</span>
            </Show>
            <span class="tab-title">{t().title}</span>
            <Show when={t().machine}>
              {(m) => (
                <span
                  class="tab-machine"
                  style={{ color: m().color }}
                  title={T("sidebar.machineHealth", {
                    machine: m().name,
                    health: healthLabel(m().health),
                  })}
                >
                  <Nf c={ICON.machine} />
                  <span
                    class="health"
                    data-health={m().health}
                    role="img"
                    aria-label={healthLabel(m().health)}
                  />
                  <span class="tab-machine-name">{m().name}</span>
                </span>
              )}
            </Show>
          </span>
          <Show when={t().path}>
            <span class="tab-l2">
              <Nf c={t().kind === "term" ? ICON.folder : ICON.link} />
              <span class="tab-text" {...titleIfClipped(t().path)}>
                {t().path}
              </span>
            </span>
          </Show>
          <Show when={t().git}>
            <span class="tab-l3">
              <Nf c={ICON.git} />
              <span class="tab-text" {...titleIfClipped(t().git)}>
                {t().git}
              </span>
            </span>
          </Show>
        </button>
        <div class="tab-actions">
          <button
            type="button"
            class="band-btn band-close tab-edit"
            data-off={props.onRename ? undefined : ""}
            aria-label={T("sidebar.renameTabLabel", { title: t().title })}
            title={T("sidebar.renameTab")}
            onClick={() => props.onRename?.()}
          >
            <Nf c={ICON.pencil} />
          </button>
          <button
            type="button"
            class="band-btn band-close tab-close"
            data-off={t().closable && props.onClose ? undefined : ""}
            aria-label={T(
              t().incognito
                ? "sidebar.closeTabLabelIncognito"
                : "sidebar.closeTabLabel",
              { title: t().title },
            )}
            title={T("sidebar.closeTab")}
            onClick={() => props.onClose?.()}
          >
            <Nf c={ICON.close} />
          </button>
        </div>
      </div>
    </li>
  );
}
