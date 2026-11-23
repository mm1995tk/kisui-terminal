// プロキシのパネル（ProxyPanel.tsx）の見た目の案を並べて見比べる。案を選ぶための stories で、選んだら消す。
// 部品のコードと ProxyPanel.module.css は書き換えず、案ごとの CSS（looks/*.css）を、その上に重ねて出す。
// 案の CSS は ProxyPanel.module.css のクラスの名前（.row など）で書き、ここで、読み込んだ CSS モジュールの本当の名前に置き換える。
// どの案も、パネルの字は部品と同じく翻訳の表から引き、色・余白・字は ui/styles/tokens.css の役割だけを使う。
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type { JSX } from "solid-js";

import { ProxyPanel } from "./ProxyPanel.tsx";
import styles from "./ProxyPanel.module.css";
import cardsCss from "./looks/cards.css?raw";
import inspectorCss from "./looks/inspector.css?raw";
import tableCss from "./looks/table.css?raw";
import { lookPanels, type LookState } from "./looks/proxyLookFixtures.ts";

type Look = "now" | "cards" | "table" | "inspector";

const lookCss: Record<Look, string> = {
  now: "",
  cards: cardsCss,
  table: tableCss,
  inspector: inspectorCss,
};

/** 案の CSS のクラスの名前（ProxyPanel.module.css のもの）を、CSS モジュールが付けた名前に置き換える。 */
function scoped(css: string): string {
  const names = styles as Record<string, string>;
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\.([A-Za-z_][\w-]*)/g, (all, name: string) =>
      names[name] ? `.${names[name]}` : all,
    );
}

/** パネルの左に出す、ターミナルのタブの代わり（パネルとの見分けを確かめるため）。 */
function FakeTerminal(): JSX.Element {
  const lines = [
    "~/work/api $ curl -s https://api.example.com/v1/items | jq .",
    "[",
    '  { "id": 1, "name": "kisui" },',
    '  { "id": 2, "name": "shijimi" }',
    "]",
    "~/work/api $ npm run dev",
    "> api@0.1.0 dev",
    "> node server.js",
    "listening on http://127.0.0.1:3000",
    "~/work/api $ ",
  ];
  return (
    <pre
      style={{
        margin: 0,
        padding: "var(--space-8)",
        height: "100%",
        "box-sizing": "border-box",
        background: "var(--color-bg)",
        color: "var(--color-text)",
        "font-family": "var(--font-mono)",
        "font-size": "13px",
        "line-height": "1.4",
        overflow: "hidden",
      }}
    >
      {lines.join("\n")}
    </pre>
  );
}

const noop = () => {};

/** 案 look で、状態 state のパネルを出す。width はパネルの外（右のペイン）の幅、panelW はパネルの幅。 */
function LookView(props: {
  look: Look;
  state: LookState;
  width?: string;
  panelW?: string;
}): JSX.Element {
  return (
    <div
      data-look={props.look}
      style={{
        position: "relative",
        width: props.width ?? "100%",
        height: "640px",
        "--proxy-panel-w": props.panelW ?? "clamp(280px, 45%, 70%)",
      }}
    >
      <style>{scoped(lookCss[props.look])}</style>
      <div
        style={{
          position: "absolute",
          inset: 0,
          "margin-right": "var(--proxy-panel-w)",
        }}
      >
        <FakeTerminal />
      </div>
      <ProxyPanel
        panel={lookPanels[props.state]}
        machine="local"
        mac={true}
        onSelect={noop}
        onStep={noop}
        onSide={noop}
        onBack={noop}
        onClose={noop}
        onHelp={noop}
        onEdit={noop}
        onDraft={noop}
        onSend={noop}
        onCancelEdit={noop}
        onHold={noop}
        onRelease={noop}
        focusRef={noop}
      />
    </div>
  );
}

const meta = {
  title: "main-window/content/ProxyPanelLooks",
  component: LookView,
  args: { look: "now", state: "list" },
  argTypes: {
    look: {
      control: "inline-radio",
      options: ["now", "cards", "table", "inspector"],
    },
    state: {
      control: "inline-radio",
      options: ["list", "detail", "held", "edit"],
    },
  },
} satisfies Meta<typeof LookView>;

export default meta;
type Story = StoryObj<typeof meta>;

// 狭い幅：窓を画面の半分にしたくらい。右のペインが 800px、パネルが 360px
const narrow = { width: "800px", panelW: "360px" } as const;

/** Now: the current look. List, nothing selected. */
export const NowList: Story = { args: { look: "now", state: "list" } };
/** Now: a selected exchange, response side. */
export const NowDetail: Story = { args: { look: "now", state: "detail" } };
/** Now: a held request (Drop / Edit / Forward). */
export const NowHeld: Story = { args: { look: "now", state: "held" } };
/** Now: editing a request to resend it. */
export const NowEdit: Story = { args: { look: "now", state: "edit" } };
/** Now: narrow window (panel 360px), held request. */
export const NowNarrow: Story = {
  args: { look: "now", state: "held", ...narrow },
};

/** A. Cards: the panel is a raised surface; list and detail sit in rounded boxes; Button-style toggles; card-row selection. */
export const CardsList: Story = { args: { look: "cards", state: "list" } };
/** A. Cards: a selected exchange, response side. */
export const CardsDetail: Story = { args: { look: "cards", state: "detail" } };
/** A. Cards: a held request (Drop / Edit / Forward). */
export const CardsHeld: Story = { args: { look: "cards", state: "held" } };
/** A. Cards: editing a request to resend it. */
export const CardsEdit: Story = { args: { look: "cards", state: "edit" } };
/** A. Cards: narrow window (panel 360px), held request. */
export const CardsNarrow: Story = {
  args: { look: "cards", state: "held", ...narrow },
};

/** B. Table: like the DB tab's result table. Bold sticky header, column lines, zebra rows, a colored dot before the status; headers as a 2-column table. */
export const TableList: Story = { args: { look: "table", state: "list" } };
/** B. Table: a selected exchange, response side. */
export const TableDetail: Story = { args: { look: "table", state: "detail" } };
/** B. Table: a held request (Drop / Edit / Forward). */
export const TableHeld: Story = { args: { look: "table", state: "held" } };
/** B. Table: editing a request to resend it. */
export const TableEdit: Story = { args: { look: "table", state: "edit" } };
/** B. Table: narrow window (panel 360px), held request. */
export const TableNarrow: Story = {
  args: { look: "table", state: "held", ...narrow },
};

/** C. Inspector: two-line rows (host / path) with a status badge, no column header; headers as a name / value grid. */
export const InspectorList: Story = {
  args: { look: "inspector", state: "list" },
};
/** C. Inspector: a selected exchange, response side. */
export const InspectorDetail: Story = {
  args: { look: "inspector", state: "detail" },
};
/** C. Inspector: a held request (Drop / Edit / Forward). */
export const InspectorHeld: Story = {
  args: { look: "inspector", state: "held" },
};
/** C. Inspector: editing a request to resend it. */
export const InspectorEdit: Story = {
  args: { look: "inspector", state: "edit" },
};
/** C. Inspector: narrow window (panel 360px), held request. */
export const InspectorNarrow: Story = {
  args: { look: "inspector", state: "held", ...narrow },
};
