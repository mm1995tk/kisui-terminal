import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createOrderedSend, type SendInput } from "./filesInput.ts";

function recorder() {
  const sent: [string, unknown][] = [];
  const methods = () => sent.map(([m]) => m);
  const send: SendInput = (method, params) => {
    sent.push([method, params]);
  };
  return { sent, send, methods };
}

describe("createOrderedSend", () => {
  it("待つものが無ければ、すぐ送る", () => {
    const r = recorder();
    const o = createOrderedSend(() => r.send);
    o.send("input.focus", { region: "files" });
    assert.deepEqual(r.sent, [["input.focus", { region: "files" }]]);
  });

  it("貼り付けの文字を読む間に押したキーは、貼り付けの後に送る", async () => {
    const r = recorder();
    const o = createOrderedSend(() => r.send);
    let resolve!: (t: string) => void;
    const reading = new Promise<string>((res) => (resolve = res));
    o.after(reading, (text) =>
      o.send("input.paste", { region: "files", text }),
    );
    o.send("input.key", {
      region: "files",
      key: "Enter",
      mods: [],
      phase: "press",
    });
    assert.equal(r.sent.length, 0, "読み終えるまで送らない");
    resolve("pasted");
    await new Promise((res) => setTimeout(res, 0));
    assert.deepEqual(r.methods(), ["input.paste", "input.key"]);
    // 終わったら、また すぐ送る
    o.send("input.focus", { region: "files" });
    assert.equal(r.sent.length, 3);
  });

  it("読むのに失敗しても、後の入力は送る", async () => {
    const r = recorder();
    const o = createOrderedSend(() => r.send);
    o.after(Promise.reject(new Error("denied")), () => {
      throw new Error("呼ばれない");
    });
    o.send("input.focus", { region: "files" });
    await new Promise((res) => setTimeout(res, 0));
    assert.deepEqual(r.methods(), ["input.focus"]);
  });

  it("送り先が無ければ捨てる", () => {
    const o = createOrderedSend(() => undefined);
    o.send("input.focus", { region: "files" });
  });
});
