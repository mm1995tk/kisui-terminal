import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  endPaneGrant,
  grantPanes,
  grantRemainingText,
  onPaneGrantEnd,
  paneGrantActive,
  paneGrants,
  parseGrantTime,
} from "./paneGrant.ts";

describe("時間を決めた許可（手元の PC のペインの操作）", () => {
  afterEach(() => {
    for (const t of Object.keys(paneGrants())) endPaneGrant(t);
  });

  it("時間の書き方を秒にする（DB の権限の引き上げと同じ書き方）", () => {
    assert.deepEqual(parseGrantTime("30m"), { seconds: 1800 });
    assert.deepEqual(parseGrantTime(" 1h "), { seconds: 3600 });
    assert.deepEqual(parseGrantTime("1H30M"), { seconds: 5400 });
    assert.deepEqual(parseGrantTime("90s"), { seconds: 90 });
    assert.deepEqual(parseGrantTime("8h"), { seconds: 28800 });
  });

  it("読めない・0・8 時間より長い時間は、理由を返す", () => {
    for (const bad of [
      "",
      "30",
      "m",
      "1d",
      "30m1h",
      "-5m",
      "0m",
      "abc",
      "1.5h",
    ])
      assert.ok("error" in parseGrantTime(bad), bad);
    assert.ok("error" in parseGrantTime("8h1s"));
    assert.ok("error" in parseGrantTime("481m"));
  });

  it("残りの時間は、1 分より短ければ秒、長ければ分に切り上げる", () => {
    assert.equal(grantRemainingText(45_000, 0), "45s");
    assert.equal(grantRemainingText(60_000, 0), "1m");
    assert.equal(grantRemainingText(61_000, 0), "2m");
    assert.equal(grantRemainingText(3_600_000, 0), "1h");
    assert.equal(grantRemainingText(3_900_000, 0), "1h5m");
    assert.equal(grantRemainingText(0, 5000), "0s");
  });

  it("許している間だけ効く。途中で終えられ、終わりを知らせる", () => {
    const ended: string[] = [];
    const off = onPaneGrantEnd((t) => ended.push(t));
    assert.equal(paneGrantActive("dev"), false);
    const until = grantPanes("dev", 60, 1000);
    assert.equal(until, 61_000);
    assert.equal(paneGrantActive("dev", 1000), true);
    assert.equal(paneGrantActive("dev", 60_999), true);
    // 時刻が過ぎていれば、タイマーが来る前でも効かない
    assert.equal(paneGrantActive("dev", 61_000), false);
    assert.equal(paneGrantActive("build", 1000), false);
    endPaneGrant("dev");
    assert.equal(paneGrantActive("dev", 1000), false);
    assert.deepEqual(ended, ["dev"]);
    // 許していないマシンを終えても、何も起きない
    endPaneGrant("dev");
    assert.deepEqual(ended, ["dev"]);
    off();
  });

  it("もう許しているマシンに許すと、時間を数え直す", () => {
    grantPanes("dev", 60, 0);
    grantPanes("dev", 120, 10_000);
    assert.equal(paneGrants().dev, 130_000);
  });

  it("時間が来ると、自分で終わる", async () => {
    const ended: string[] = [];
    const off = onPaneGrantEnd((t) => ended.push(t));
    grantPanes("dev", 0.01);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(paneGrants().dev, undefined);
    assert.deepEqual(ended, ["dev"]);
    off();
  });
});
