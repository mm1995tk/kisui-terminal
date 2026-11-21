// DB のタブの画面（DbTabView.tsx）を、アプリと同じ部品・CSS・字・翻訳で出す。結果のタブ（#404）の動き（上書き・新しいタブ・
// 切り替え・閉じる）は、アプリと同じ決まり（features/db/results.ts）で動かし、kisui serve の代わりに見本の結果をすぐ返す。
// ページ送り・並べ替え・木・Structure は、ここでは動かさない。
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";
import { createSignal, type JSX } from "solid-js";

import { firstPage } from "../../../../features/db/paging.ts";
import {
  closeTab,
  EMPTY_RUN,
  startStatement,
  stepTab,
  updateTab,
  type DbRun,
  type RunInto,
} from "../../../../features/db/results.ts";
import type { DbQueryResult } from "../../../../infrastructure/rpc/protocol.ts";
import { DbTabView } from "./DbTabView.tsx";

/** 文 sql の見本の結果（n は何番目に実行したか）。 */
function sampleResult(sql: string, n: number): DbQueryResult {
  return {
    columns: [
      { name: "id", type: "int4", kind: "number" },
      { name: "sql", type: "text", kind: "text" },
      { name: "note", type: "text", kind: "text" },
    ],
    rows: Array.from({ length: 3 + (n % 4) }, (_, i) => [
      String(i + 1),
      sql,
      i === 1 ? null : `run ${n}`,
    ]),
    rowCount: 3 + (n % 4),
    truncated: false,
    elapsedMs: 1.5 * n,
  };
}

/** 文を `;` で分けて実行する見本の DB のタブ。`fail` を含む文は失敗し、後の文は実行しない。 */
function Demo(props: { sql: string; first?: readonly string[] }): JSX.Element {
  const [sql, setSql] = createSignal(props.sql);
  const [run, setRun] = createSignal<DbRun>(EMPTY_RUN);
  let count = 0;
  function exec(text: string, into: RunInto) {
    let prev: string | undefined;
    for (const s of text.split(";").map((x) => x.trim())) {
      if (s === "") continue;
      const n = ++count;
      const begun = startStatement(run(), {
        sql: s,
        running: { queryId: `q${n}`, target: "local" },
        newId: `r${n}`,
        into,
        ...(prev !== undefined ? { prev } : {}),
      });
      prev = begun.tab;
      const failed = s.includes("fail");
      const { running: _, ...done } = updateTab(begun.run, begun.tab, (t) =>
        failed
          ? {
              id: t.id,
              sql: t.sql,
              failure: {
                kind: "error",
                message: 'relation "fail" does not exist',
                sqlState: "42P01",
              },
            }
          : {
              id: t.id,
              sql: t.sql,
              result: sampleResult(s, n),
              page: firstPage(s),
            },
      );
      setRun(done);
      if (failed) break;
    }
  }
  for (const s of props.first ?? []) exec(s, "new");
  return (
    <div style={{ position: "relative", height: "560px" }}>
      <DbTabView
        connection="app (local)"
        machine="localhost"
        mac={true}
        sql={sql()}
        onSql={setSql}
        run={run()}
        onRun={(text, from, to, into) =>
          exec(from === to ? text : text.slice(from, to), into)
        }
        onPage={fn()}
        onSort={fn()}
        onCancel={fn()}
        onCopyCells={fn()}
        onResult={(tab) => setRun((r) => ({ ...r, active: tab }))}
        onStepResult={(step) =>
          setRun((r) => {
            const to = stepTab(r, step);
            return to === undefined ? r : { ...r, active: to };
          })
        }
        onCloseResult={(tab) => setRun((r) => closeTab(r, tab))}
        structure={undefined}
        onView={fn()}
      />
    </div>
  );
}

const meta = {
  title: "main-window/content/db/DbTabView",
  component: Demo,
  args: { sql: "select * from users where id = 3" },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

/** まだ実行していない（結果のタブの列は出ない）。Cmd+Enter で実行すると、結果のタブが 1 つ出る。 */
export const Empty: Story = {};

/**
 * 結果のタブが 3 つある。Cmd+Enter は出しているタブに上書きし、Cmd+Option+Enter は右隣に新しいタブを足す。
 * タブのクリック・`[` `]`（タブか表にキーがあるとき）で切り替え、× かマウスの中ボタンで閉じる。
 */
export const Tabs: Story = {
  args: {
    first: [
      "select * from users",
      "select * from orders where user_id = 3 order by created_at desc",
      "select count(*) from fail",
    ],
  },
};

/** 文を 2 つ以上実行する：入力欄の全部を選んで Cmd+Enter。1 つ目は出しているタブに上書きし、残りは新しいタブに出る。 */
export const Statements: Story = {
  args: {
    sql: "select 1;\nselect 2;\nselect 3",
    first: ["select * from users", "select * from orders"],
  },
};
