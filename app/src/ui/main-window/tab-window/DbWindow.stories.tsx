// 組み合わせの例：DB のタブの Dialog（DbWindow.tsx。リーダーの a。#458）を、アプリと同じ部品・CSS・字・翻訳で出す。
// 結果のタブは見本のデータ（下の run）で、閉じる・切り替える・ページなどの操作は Actions に出るだけ（一覧は変わらない）。
// 選ぶ（j k・クリック）・理由の表示（Structure の無いタブで s など）・`?` は、そのまま動く。
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";

import type { DbRun } from "../../../features/db/results.ts";
import type { DbStructureState } from "../../../features/db/structure.ts";
import type { DbQueryResult } from "../../../infrastructure/rpc/protocol.ts";
import { KeyListDialog } from "../commands/KeyListDialog.tsx";
import { DbWindow } from "./DbWindow.tsx";

const result = (rowCount: number, elapsedMs: number): DbQueryResult => ({
  columns: [{ name: "id", type: "integer", kind: "number" }],
  rows: [],
  rowCount,
  truncated: false,
  elapsedMs,
});

/** 木で選んだテーブル（仮のタブ）・上書きした結果・実行中・失敗の 4 つ。2 つ目を出している。 */
const run: DbRun = {
  tabs: [
    {
      id: "r1",
      sql: 'SELECT * FROM "public"."users" LIMIT 100',
      label: "users",
      result: result(100, 12.4),
    },
    {
      id: "r2",
      sql: "SELECT id, name FROM orders WHERE created_at > now() - interval '1 day'",
      result: result(42, 3.1),
    },
    { id: "r3", sql: "SELECT pg_sleep(30)" },
    {
      id: "r4",
      sql: "SELEC 1",
      failure: {
        kind: "error",
        message: 'syntax error at or near "SELEC"',
        sqlState: "42601",
      },
    },
  ],
  active: "r2",
  preview: "r1",
  running: { queryId: "q1", target: "local", tab: "r3" },
};

const structure: DbStructureState = {
  table: { schema: "public", table: "users" },
  view: "structure",
};

/** 見本の結果のタブを返す、DB のタブの持ち物の代わり。 */
const db = (r: DbRun, elevated: string[] = []) => ({
  shownDbTab: () => ({
    kind: "db" as const,
    id: "d1",
    target: "local",
    connection: "app",
    variant: "staging",
  }),
  refOf: () => ({
    kind: "db" as const,
    id: "d1",
    target: "local",
    connection: "app",
    variant: "staging",
  }),
  runOf: () => r,
  resultStructureOf: (tab: string) => (tab === "r1" ? structure : undefined),
  catalogOf: () => ({}),
  elevatedOf: () => elevated,
  showResult: fn(),
  closeResult: fn(() => true),
  showView: fn(() => false),
  stepPage: fn(() => "none" as const),
  cancel: fn(),
  reloadCatalog: fn(async () => undefined),
  reloadStructure: fn(),
  openExport: fn(() => true),
  openHistory: fn(async () => undefined),
  openElevate: fn(async () => undefined),
  endElevation: fn(async () => undefined),
});

const meta = {
  title: "main-window/tab-window/DbWindow",
  component: DbWindow,
  args: {
    db: db(run, ["agent → app_rw · 25m"]),
    labelOf: () => "local",
    connected: (): boolean => true,
    mac: false,
    onFocusTree: fn(),
    onClose: fn(),
  },
  // `?` の一覧は、アプリと同じく、Dialog の上に重ねて出す
  render: (args) => (
    <>
      <DbWindow {...args} />
      <KeyListDialog />
    </>
  ),
} satisfies Meta<typeof DbWindow>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 4 つの結果のタブ。開いたときは、出している結果のタブ（2 つ目）を選んでいる。 */
export const Results: Story = {};

/** マシンにつながっていない。結果のタブはメモリにあるので出る。 */
export const Offline: Story = {
  args: { connected: () => false, db: db({ ...run, running: undefined }) },
};

/** 結果のタブが無い（まだ実行していない）。t r h p P c は使える。 */
export const Empty: Story = {
  args: { db: db({ tabs: [] }) },
};
