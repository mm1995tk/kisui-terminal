import { T } from "../../../i18n/index.ts";
import { For, type JSX } from "solid-js";

import { Kbd } from "../../components/KeyHints.tsx";
import { NEW_TAB_KIND_KEYS, type NewTabChoice } from "./newTabKey.ts";

/** 種類の名前（サイドバーの「+」のメニューと同じ言葉）。 */
function kindLabel(kind: NewTabChoice): string {
  switch (kind) {
    case "terminal":
      return T("sidebar.addTerminal");
    case "browser":
      return T("sidebar.addBrowser");
    case "incognito":
      return T("switcher.newTab.incognito");
    case "db":
      return T("sidebar.addDb");
  }
}

/**
 * 切り替える窓の右の列の一番下に出す、作るタブの種類を選ぶ一覧（n・N・「＋」・リーダーの n。#456）。行の左に、その種類にすぐ決める字を出す。
 * キーは窓（WorkspaceSwitcher.tsx）が受ける（newTabKey.ts の newTabKindKey）。ここは、選んでいる行を見せ、行を押したら onPick を呼ぶだけ。
 * フォーカスは窓に置いたままなので、選んでいる行は id（optionId）で窓の aria-activedescendant が指す。
 */
export function SwitcherNewTabKinds(props: {
  /** 出す種類（上から。内蔵ブラウザが無効なら、ブラウザとシークレットは無い） */
  kinds: readonly NewTabChoice[];
  /** 選んでいる行の種類 */
  selected: NewTabChoice;
  optionId: (kind: NewTabChoice) => string;
  onHover: (kind: NewTabChoice) => void;
  onPick: (kind: NewTabChoice) => void;
}): JSX.Element {
  return (
    <div class="switch-newkind">
      <span class="switch-newkind-title">{T("switcher.newTabKind")}</span>
      <ul
        class="switch-newkind-list"
        role="listbox"
        aria-label={T("switcher.newTabKind")}
        // 行を押しても、フォーカスは窓に置いたまま（キーを窓が受け続ける）
        onPointerDown={(e) => e.preventDefault()}
      >
        <For each={props.kinds}>
          {(k) => (
            <li
              id={props.optionId(k)}
              role="option"
              aria-selected={props.selected === k ? "true" : "false"}
              data-cursor={props.selected === k ? "" : undefined}
              onPointerEnter={() => props.onHover(k)}
              onClick={() => props.onPick(k)}
            >
              <Kbd>{NEW_TAB_KIND_KEYS[k]}</Kbd>
              <span>{kindLabel(k)}</span>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
