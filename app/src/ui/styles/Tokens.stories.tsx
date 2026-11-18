// デザインシステムの基礎（tokens.css）を、アプリと同じ CSS・字で並べる（#315）。
// 名前・書いてある値・ブラウザが解いた値・説明（tokens.css の各値のすぐ上のコメント）は、tokens.css の文から読む。
// ここに値や説明を書き写さないので、tokens.css を直せばそのまま変わる。役割と使い分けは docs/design/design-system.md。
import { For, type JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";

import { T } from "../../i18n/index.ts";
import css from "./tokens.css?raw";
import { parseTokens, type Token } from "./tokens.ts";

const all = parseTokens(css);

/** 値の見本。名前の頭で、色・余白・字・角などを見分ける */
function Sample(props: { token: Token }): JSX.Element {
  const n = props.token.name;
  const v = `var(${n})`;
  const box = {
    width: "48px",
    height: "28px",
    "box-sizing": "border-box",
  } as const;
  if (n.startsWith("--space-"))
    return (
      <div
        style={{ width: v, height: "12px", background: "var(--color-accent)" }}
      />
    );
  if (n.startsWith("--radius-"))
    return (
      <div
        style={{
          ...box,
          border: "1px solid var(--color-border-strong)",
          "border-radius": v,
        }}
      />
    );
  if (n.startsWith("--text-"))
    return <span style={{ "font-size": v }}>{T("keys.label")}</span>;
  if (n.startsWith("--weight-"))
    return <span style={{ "font-weight": v }}>{T("keys.label")}</span>;
  // 等幅の字はコマンド・パスに使うので、見本もコマンドにする（等幅の字の並びには日本語の字が無い）
  if (n === "--font-mono")
    return <span style={{ "font-family": v }}>kisui attach</span>;
  if (n.startsWith("--font-"))
    return <span style={{ "font-family": v }}>{T("keys.label")}</span>;
  if (n.startsWith("--leading-"))
    return (
      <p style={{ margin: 0, "max-width": "260px", "line-height": v }}>
        {T("closeWorkspace.text", { name: "kisui-terminal" })}
      </p>
    );
  if (n.startsWith("--shadow-"))
    return (
      <div
        style={{ ...box, background: "var(--color-surface)", "box-shadow": v }}
      />
    );
  if (n === "--state-disabled-opacity")
    return (
      <div style={{ ...box, background: "var(--color-accent)", opacity: v }} />
    );
  if (n.startsWith("--state-focus-ring-"))
    return (
      <div
        style={{
          ...box,
          border: "1px solid var(--color-border-strong)",
          outline:
            "var(--state-focus-ring-width) solid var(--state-focus-ring)",
          "outline-offset": "var(--state-focus-ring-offset)",
        }}
      />
    );
  return (
    <div
      style={{
        ...box,
        background: v,
        border: "1px solid var(--color-border)",
        "border-radius": "var(--radius-4)",
      }}
    />
  );
}

/** 頭が prefixes のどれかの値を、見出しごとに並べる */
function TokenTable(props: { prefixes: string[] }): JSX.Element {
  const tokens = all.filter((t) =>
    props.prefixes.some((p) => t.name.startsWith(p)),
  );
  const groups = [...new Set(tokens.map((t) => t.group))];
  const resolved = (name: string) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return (
    <div style={{ padding: "var(--space-16)" }}>
      <For each={groups}>
        {(g) => (
          <section style={{ "margin-bottom": "var(--space-16)" }}>
            <h2
              style={{
                margin: "0 0 var(--space-8)",
                "font-size": "var(--text-title)",
                "font-weight": "var(--weight-strong)",
              }}
            >
              {g}
            </h2>
            <div
              style={{
                display: "grid",
                "grid-template-columns":
                  "minmax(64px, max-content) minmax(0, 28em) minmax(12em, 1fr)",
                gap: "var(--space-12) var(--space-16)",
                "align-items": "center",
              }}
            >
              <For each={tokens.filter((t) => t.group === g)}>
                {(t) => (
                  <>
                    <Sample token={t} />
                    <div
                      style={{
                        "font-family": "var(--font-mono)",
                        "overflow-wrap": "anywhere",
                        "font-size": "var(--text-caption)",
                      }}
                    >
                      <div style={{ color: "var(--color-text-strong)" }}>
                        {t.name}
                      </div>
                      <div style={{ color: "var(--color-text-muted)" }}>
                        {t.value.includes("var(")
                          ? `${t.value} → ${resolved(t.name)}`
                          : t.value}
                      </div>
                    </div>
                    <div style={{ color: "var(--color-text-muted)" }}>
                      {t.note}
                    </div>
                  </>
                )}
              </For>
            </div>
          </section>
        )}
      </For>
    </div>
  );
}

const meta = {
  title: "styles/Tokens",
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** 色の役割（地・字・縁・主の操作・幕・影）。パレット（theme.css）の上に名前を付けたもの。 */
export const Colors: Story = {
  render: () => <TokenTable prefixes={["--color-", "--shadow-"]} />,
};

/** 状態（hover・フォーカス・選択・無効と処理中・成功・警告・失敗）と、接続の状態。 */
export const States: Story = {
  render: () => <TokenTable prefixes={["--state-", "--connection-"]} />,
};

/** 余白の段。部品の余白はこの中から選ぶ。 */
export const Spacing: Story = {
  render: () => <TokenTable prefixes={["--space-"]} />,
};

/** 字（字の並び・大きさ・太さ・行の高さ）。見本の文は story を出すときの言語で引く。 */
export const Typography: Story = {
  render: () => (
    <TokenTable prefixes={["--font-", "--text-", "--weight-", "--leading-"]} />
  ),
};

/** 角の丸み。 */
export const Radius: Story = {
  render: () => <TokenTable prefixes={["--radius-"]} />,
};
