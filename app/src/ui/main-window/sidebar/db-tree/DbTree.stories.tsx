// DB のタブを出している間の、サイドバーの接続の木（DbTree）。アプリと同じ部品と CSS で出す。
// 一覧（db.schema の答え）は見本のデータ。操作は fn() で受ける。
import { createSignal, type JSX } from "solid-js";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";

import type { DbCatalog } from "../../../../infrastructure/rpc/protocol.ts";
import { DbSchemaPicker } from "./DbSchemaPicker.tsx";
import { DbTree } from "./DbTree.tsx";

const table = (name: string, kind: "table" | "view" = "table") => ({
  name,
  kind,
  columns: [{ name: "id", type: "integer" }],
});

/** PostgreSQL の、スキーマが 2 つある接続 */
const CATALOG: DbCatalog = {
  schemas: [
    { name: "analytics", tables: [table("page_views")] },
    {
      name: "public",
      tables: [
        table("customers"),
        table("items"),
        table("order_items"),
        table("orders"),
        table("sales_by_customer", "view"),
      ],
    },
  ],
  defaultSchema: "public",
  truncated: false,
};

/** サイドバーの段と同じ幅・高さの中に出す。選んだスキーマと開けている枝は、この story の中で持つ */
function Frame(props: { catalog?: DbCatalog }): JSX.Element {
  const [chosen, setChosen] = createSignal<string | undefined>();
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(
    new Set(["analytics", "public"]),
  );
  return (
    <div
      style={{
        width: "360px",
        height: "480px",
        display: "flex",
        background: "var(--color-surface)",
      }}
    >
      <DbTree
        catalog={{ catalog: props.catalog ?? CATALOG, kind: "postgres" }}
        expanded={expanded()}
        onToggle={(node, open) => {
          const s = new Set(expanded());
          if (open) s.add(node);
          else s.delete(node);
          setExpanded(s);
        }}
        onPreview={fn()}
        chosenSchema={chosen()}
        onSchema={(o) => setChosen(o ?? undefined)}
        onReload={fn()}
        onLeave={fn()}
      />
    </div>
  );
}

const meta = {
  title: "main-window/sidebar/db-tree/DbTree",
  parameters: { layout: "centered" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** 既定のスキーマ（public）のテーブルだけを出す。絞り込みに打つと、ほかのスキーマの合うテーブルも出る（例：「page」） */
export const OneSchema: Story = { render: () => <Frame /> };

/** 示す既定のスキーマが無い接続（MySQL で DB を指定せずに接続したなど）：スキーマ → テーブル の 2 段 */
export const NoDefaultSchema: Story = {
  render: () => <Frame catalog={{ ...CATALOG, defaultSchema: null }} />,
};

/** 既定のスキーマを選ぶ所（木の `s`・木の上の既定のスキーマの欄で、その場所に開く） */
export const SchemaPicker: Story = {
  render: () => (
    <div style={{ width: "336px" }}>
      <DbSchemaPicker
        options={["analytics", "public"]}
        selected="public"
        onChoose={fn()}
        onCancel={fn()}
      />
    </div>
  ),
};
