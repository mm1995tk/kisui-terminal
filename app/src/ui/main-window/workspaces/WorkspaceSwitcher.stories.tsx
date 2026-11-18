// ワークスペースを切り替える窓（WorkspaceSwitcher.tsx）を、アプリと同じ部品・CSS・字・翻訳で出す。
// 行（Row）は見本のデータ。アプリでは features/workspaces/rows.ts の gwsRows が、マシンとタブの状態から作る。
// 右のタブの行はサイドバーの TabRow を使い、その見た目は sidebar.css にあるので、ここで読む（アプリでは page.tsx が先に読む）。
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";

import type {
  Band,
  Health,
  Row,
  TabItem,
} from "../../../features/workspaces/rows.ts";
import { nameErrorText } from "../../../features/workspaces/model.ts";
import "../sidebar/sidebar.css";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.tsx";

const MACHINES = {
  local: { name: "local", color: "#58a6ff" },
  devbox: { name: "devbox", color: "#d2a8ff" },
} as const;

function band(gws: string, title: string, focused: boolean): Band {
  return {
    id: gws,
    title,
    label: "",
    autoTitle: title,
    path: false,
    unset: false,
    detail: "",
    dir: "",
    branch: "main",
    sha: "81c705b",
    note: "",
    num: "",
    root: `~/workspaces/${title}`,
    focused,
    showTree: false,
  };
}

function term(
  key: string,
  title: string,
  path: string,
  git: string,
  m: { name: string; color: string },
  health: Health = "up",
): TabItem {
  return {
    key,
    kind: "term",
    title,
    path,
    git,
    tip: path,
    incognito: false,
    machine: { name: m.name, color: m.color, health },
    health,
    term: { target: m.name, ws: key },
    closable: true,
  };
}

function page(key: string, title: string, url: string): TabItem {
  return {
    key,
    kind: "browser",
    title,
    path: url,
    git: "",
    tip: url,
    incognito: false,
    tab: key,
    closable: true,
  };
}

function row(
  gws: string,
  title: string,
  m: { name: string; color: string },
  tabs: TabItem[],
  opts: { focused?: boolean; health?: Health } = {},
): Row {
  const focused = opts.focused ?? false;
  return {
    gws,
    target: m.name,
    machine: m.name,
    color: m.color,
    health: opts.health ?? "up",
    band: band(gws, title, focused),
    tabs: { items: tabs, shown: tabs[0]?.key ?? "", focused },
  };
}

const ROWS: Row[] = [
  row(
    "g1",
    "kisui-terminal",
    MACHINES.local,
    [
      term(
        "t1",
        "zsh",
        "~/workspaces/kisui-terminal",
        "main (81c705b)",
        MACHINES.local,
      ),
      term(
        "t2",
        "shj",
        "~/workspaces/kisui-terminal/app",
        "main (81c705b)",
        MACHINES.local,
      ),
      page("b1", "Storybook", "http://localhost:6006/"),
    ],
    { focused: true },
  ),
  row("g2", "shijimi-editor", MACHINES.local, [
    term(
      "t3",
      "zsh",
      "~/workspaces/shijimi-editor",
      "feature/diff (3fa2c1e)",
      MACHINES.local,
    ),
  ]),
  row(
    "g3",
    "api-server",
    MACHINES.devbox,
    [
      term(
        "t4",
        "zsh",
        "~/src/api-server",
        "main (9e01b7d)",
        MACHINES.devbox,
        "down",
      ),
    ],
    { health: "down" },
  ),
  row("g4", "docs", MACHINES.local, [
    page("b2", "GitHub", "https://github.com/"),
  ]),
];

const meta = {
  title: "main-window/workspaces/WorkspaceSwitcher",
  component: WorkspaceSwitcher,
  args: {
    rows: ROWS,
    onGo: fn(),
    onTab: fn(),
    onReorder: fn(),
    onDrop: fn(),
    onTabMove: fn(),
    onNew: fn(),
    renameInit: (gws: string) => {
      const r = ROWS.find((x) => x.gws === gws);
      return r ? { current: r.band.label, auto: r.band.autoTitle } : undefined;
    },
    // アプリと同じ決まりで名前を確かめる（長すぎる・制御文字を含む名前は、入力欄の下に理由が出る）
    onRename: fn((_gws: string, name: string) => nameErrorText(name)),
    onClose: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof WorkspaceSwitcher>;

export default meta;
type Story = StoryObj<typeof meta>;

/** ローカルと別のマシン（つながっていない）のワークスペースが並ぶ。j / k で選ぶと、右に選んだ行のタブが出る。r で名前を変え（長すぎる名前は断られる）、x で閉じる確認を出す。 */
export const Default: Story = {};

/** タブが 1 つも無いワークスペースを選んでいるとき。 */
export const NoTabs: Story = {
  args: { rows: [row("g1", "scratch", MACHINES.local, [], { focused: true })] },
};

/** ワークスペースが 1 つも無いとき。 */
export const Empty: Story = {
  args: { rows: [] },
};

const MANY_NAMES = [
  "kisui-terminal",
  "shijimi-editor",
  "api-server",
  "docs",
  "infra",
  "website",
  "blog",
  "dotfiles",
  "scratch",
  "experiments",
  "release",
  "review",
  "mobile",
  "data-pipeline",
  "billing",
  "auth-service",
];

const MANY_ROWS: Row[] = MANY_NAMES.map((name, i) => {
  const m = i % 3 === 2 ? MACHINES.devbox : MACHINES.local;
  const tabs: TabItem[] = Array.from({ length: 4 + (i % 9) }, (_, j) =>
    j % 4 === 3
      ? page(`b${i}-${j}`, `Page ${j}`, `https://example.com/${name}/${j}`)
      : term(
          `t${i}-${j}`,
          j === 0 ? "zsh" : `shell ${j}`,
          `~/workspaces/${name}`,
          "main (81c705b)",
          m,
        ),
  );
  return row(`g${i}`, name, m, tabs, { focused: i === 0 });
});

/** ワークスペースもタブも多いとき。窓の大きさは変わらず、左の一覧と右のタブの一覧がそれぞれスクロールし、「ワークスペースを作る」は左の列の下端に残る。h / l で列を移り、j / k でその列の行を選ぶ。 */
export const Many: Story = {
  args: { rows: MANY_ROWS },
};
