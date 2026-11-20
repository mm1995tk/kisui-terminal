// タブの段・ファイルツリーの段・CHANGES の境目の見た目（#303）。アプリと同じ CSS（sidebar.css・changes.css）と同じクラス名の並びで出す。
// 「変える前」は、変える前の線（1px の薄い線・棒なし）を、この story の中で書き戻して見せる。変えた後の見た目はアプリの CSS そのまま。
import type { JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";

import "./sidebar.css";
import "./changes/changes.css";

/** 変える前の境目（1px の薄い線。棒なし）。story の中だけで使う */
const BEFORE = `
.pane-border-before .tree-section { border-top: 1px solid var(--gh-border); }
.pane-border-before .changes { border-top: 1px solid var(--gh-border); }
.pane-border-before .tabs-resizer::after,
.pane-border-before .changes-resizer::after { display: none; }
`;

const TABS = ["zsh  ~/work/app", "shj  README.md", "zsh  ~/work/server"];
const FILES = ["app/", "docs/", "internal/", "README.md", "go.mod"];

function Column(props: { before?: boolean }): JSX.Element {
  return (
    <div
      class={`sidebar-column${props.before ? " pane-border-before" : ""}`}
      style={{ width: "280px", height: "420px", "border-right": "none" }}
    >
      <style>{BEFORE}</style>
      <ul class="tab-rows" style={{ flex: "none", margin: "0" }}>
        {TABS.map((t) => (
          <li class="tab-row">
            <div class="tab-line">{t}</div>
          </li>
        ))}
      </ul>
      <div class="panes">
        <div class="tabs-border">
          <div class="tabs-resizer" aria-hidden="true" />
        </div>
        <div class="tree-section">
          <ul style={{ margin: "0", padding: "8px", "list-style": "none" }}>
            {FILES.map((f) => (
              <li style={{ padding: "2px 0" }}>{f}</li>
            ))}
          </ul>
        </div>
        <section class="changes" aria-label="CHANGES">
          <div class="changes-resizer" aria-hidden="true" />
          <h3 class="changes-title">CHANGES</h3>
          <div class="changes-list" style={{ padding: "0 8px" }}>
            README.md
          </div>
        </section>
      </div>
    </div>
  );
}

const meta = {
  title: "main-window/sidebar/PaneBorder",
  parameters: { layout: "centered" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** 変えた後：2px の濃い線に、真ん中の短い棒。タブとツリー・ツリーと CHANGES の両方 */
export const After: Story = { render: () => <Column /> };

/** 変える前：1px の薄い線で、ツリーが一番下のタブに属して見える */
export const Before: Story = { render: () => <Column before /> };

/** 前後を並べる */
export const BeforeAndAfter: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "24px" }}>
      <Column before />
      <Column />
    </div>
  ),
};
