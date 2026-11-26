import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  anyAskEach,
  askPaneOp,
  askPaneOpen,
  cancelPaneApproval,
  cancelPaneApprovalsFrom,
  currentPaneApproval,
  markAskEach,
  mustAskEach,
  resetPaneApprovals,
} from "./paneApproval.ts";

const open = (id: string, from: string) =>
  askPaneOpen({
    kind: "open",
    id,
    from,
    workspace: "w",
    isNew: false,
    name: "a",
    cwd: "",
    argv: [],
  });

describe("別のマシンからの頼みを、人に聞く", () => {
  afterEach(() => resetPaneApprovals());

  it("頼みは 1 つずつ、来た順に出す。答えたら次を出す", async () => {
    const a = open("r1", "dev");
    const b = askPaneOp({
      kind: "op",
      id: "r2",
      from: "dev",
      cmd: "send",
      pane: "a",
      text: "ls",
    });
    const first = currentPaneApproval();
    assert.equal(first?.id, "r1");
    if (first?.kind === "open") first.resolve("allow-ask");
    assert.equal(await a, "allow-ask");
    const second = currentPaneApproval();
    assert.equal(second?.id, "r2");
    if (second?.kind === "op") second.resolve(true);
    assert.equal(await b, true);
    assert.equal(currentPaneApproval(), undefined);
  });

  it("取り下げた頼みは、断ったことにして片付ける（同じマシンの、その id だけ）", async () => {
    const a = open("r1", "dev");
    const b = open("r1", "build");
    const c = open("r2", "dev");
    cancelPaneApproval("dev", "r1");
    assert.equal(await a, "deny");
    assert.equal(currentPaneApproval()?.from, "build");
    cancelPaneApprovalsFrom("dev");
    assert.equal(await c, "deny");
    const left = currentPaneApproval();
    if (left?.kind === "open") left.resolve("allow");
    assert.equal(await b, "allow");
  });

  it("「毎回聞く」は、そのペインと、そこから作られたペインに当たる", () => {
    assert.equal(anyAskEach(), false);
    markAskEach("sid", "t8");
    assert.equal(anyAskEach(), true);
    assert.equal(mustAskEach("sid", "t8", []), true);
    assert.equal(mustAskEach("sid", "t9", ["t8"]), true);
    assert.equal(mustAskEach("sid", "t10", ["t3", "t8", "t9"]), true);
    assert.equal(mustAskEach("sid", "t5", []), false);
    assert.equal(mustAskEach("sid", "t5", ["t3"]), false);
    // serve が替われば（id が同じでも）別のペイン
    assert.equal(mustAskEach("other", "t8", []), false);
  });
});
