import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Row, TabItem } from "../../../features/workspaces/rows.ts";
import { createSwitcherColumns } from "./switcherColumns.ts";

const tab = (key: string): TabItem => ({ key, title: key }) as TabItem;
const row = (shown: string | undefined, ...keys: string[]): Row =>
  ({ tabs: { items: keys.map(tab), shown } }) as unknown as Row;

describe("ワークスペースの窓の初めの列（#454）", () => {
  it("指定が無ければ、左のワークスペースの列", () => {
    const c = createSwitcherColumns(() => row("b", "a", "b"));
    assert.equal(c.activeCol(), "ws");
  });

  it("tab を指すと、右のタブの列にキーを置き、今出しているタブを選んでいる", () => {
    const c = createSwitcherColumns(() => row("b", "a", "b", "c"), "tab");
    assert.equal(c.activeCol(), "tab");
    assert.equal(c.selectedTab()?.key, "b");
  });

  it("tab を指して、タブの無いワークスペースで開いたら、あとでタブのあるワークスペースを選んでも、左の列のまま", () => {
    let cur = row(undefined);
    const c = createSwitcherColumns(() => cur, "tab");
    assert.equal(c.activeCol(), "ws");
    cur = row("b", "a", "b");
    assert.equal(c.activeCol(), "ws");
  });

  it("tab を指しても、タブが無いワークスペースでは左のまま（操作できなくならない）", () => {
    const c = createSwitcherColumns(() => row(undefined), "tab");
    assert.equal(c.activeCol(), "ws");
    assert.equal(c.selectedTab(), undefined);
    const none = createSwitcherColumns(() => undefined, "tab");
    assert.equal(none.activeCol(), "ws");
    assert.equal(none.selectedTab(), undefined);
  });
});
