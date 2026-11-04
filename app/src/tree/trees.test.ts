import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ErrorCode, RpcError } from "../rpc/message.ts";
import type { TreeEntry } from "../rpc/protocol.ts";
import { rows } from "./model.ts";
import { WorkspaceTrees, type TreeRequest } from "./trees.ts";

/** フォルダごとの中身を返す偽の shj。送った要求を順に覚える。 */
function fakeShj(fs: Record<string, TreeEntry[]>) {
  const sent: { method: string; params: any }[] = [];
  let rev = 1;
  const request = (async (method: string, params: any) => {
    sent.push({ method, params });
    switch (method) {
      case "tree.watch":
        return {};
      case "git.status":
        return { branch: "main", marks: {}, rev: 1 };
      case "tree.list": {
        const e = fs[params.path];
        if (!e)
          throw new RpcError({ code: ErrorCode.NotFound, message: "gone" });
        return { entries: e, rev };
      }
    }
    throw new Error(`unexpected ${method}`);
  }) as TreeRequest;
  return {
    sent,
    request,
    setRev: (r: number) => {
      rev = r;
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

const dir = (name: string): TreeEntry => ({ name, kind: "dir" });
const file = (name: string): TreeEntry => ({ name, kind: "file" });

describe("WorkspaceTrees", () => {
  it("フォーカスしたら tree.watch を送ってからルートと git の印を取る", async () => {
    const f = fakeShj({ "": [dir("src"), file("a")] });
    const t = new WorkspaceTrees({ request: f.request, onChange: () => {} });
    t.activate("w");
    await settle();
    assert.deepEqual(
      f.sent.map((x) => x.method),
      ["tree.watch", "tree.list", "git.status"],
    );
    assert.deepEqual(f.sent[0].params, { workspaceId: "w", paths: [""] });
    assert.deepEqual(
      rows(t.get("w")!).map((r) => r.path),
      ["src", "a"],
    );
  });

  it("開いたら監視に足して中身を取り、フォーカスを外して戻しても開閉とスクロールを覚えている", async () => {
    const f = fakeShj({ "": [dir("src")], src: [file("b")] });
    const t = new WorkspaceTrees({ request: f.request, onChange: () => {} });
    t.activate("w");
    await settle();
    t.toggle("w", "src");
    await settle();
    assert.deepEqual(f.sent.at(-2), {
      method: "tree.watch",
      params: { workspaceId: "w", paths: ["", "src"] },
    });
    assert.deepEqual(f.sent.at(-1)?.params, { workspaceId: "w", path: "src" });
    t.setScroll("w", 120);

    f.sent.length = 0;
    t.activate("v"); // 別のワークスペースへ
    await settle();
    // 外したほうは監視をやめる
    assert.deepEqual(f.sent[0], {
      method: "tree.watch",
      params: { workspaceId: "w", paths: [] },
    });

    f.sent.length = 0;
    t.activate("w");
    assert.equal(t.get("w")?.scrollTop, 120);
    assert.deepEqual(
      rows(t.get("w")!).map((r) => r.path),
      ["src", "src/b"],
    );
    await settle();
    // 戻ったら、開いているフォルダを監視し直して取り直す
    assert.deepEqual(f.sent[1], {
      method: "tree.watch",
      params: { workspaceId: "w", paths: ["", "src"] },
    });
    assert.deepEqual(
      f.sent.filter((x) => x.method === "tree.list").map((x) => x.params.path),
      ["", "src"],
    );
  });

  it("tree.changed で画面に出ているフォルダを取り直す", async () => {
    const fs = { "": [file("a")] };
    const f = fakeShj(fs);
    const t = new WorkspaceTrees({ request: f.request, onChange: () => {} });
    t.activate("w");
    await settle();
    fs[""] = [file("a"), file("b")];
    f.setRev(2);
    t.handleTreeChanged({ workspaceId: "w", paths: [""], rev: 2 });
    await settle();
    assert.deepEqual(
      rows(t.get("w")!).map((r) => r.path),
      ["a", "b"],
    );
  });

  it("消えたフォルダは開いていた印ごと忘れ、監視を教え直す", async () => {
    const fs: Record<string, TreeEntry[]> = { "": [dir("src")], src: [] };
    const f = fakeShj(fs);
    const t = new WorkspaceTrees({ request: f.request, onChange: () => {} });
    t.activate("w");
    await settle();
    t.toggle("w", "src");
    await settle();
    t.activate(null);
    await settle();
    // 外している間に src が消えた
    fs[""] = [];
    delete fs.src;
    t.activate("w");
    await settle();
    await settle();
    assert.equal(t.get("w")?.expanded.src, undefined);
    assert.deepEqual(f.sent.at(-1), {
      method: "tree.watch",
      params: { workspaceId: "w", paths: [""] },
    });
  });

  it("子を開いたまま親を閉じて開くと、子も取り直し、子が消えていたら監視を教え直す", async () => {
    const fs: Record<string, TreeEntry[]> = {
      "": [dir("a")],
      a: [dir("b")],
      "a/b": [file("old")],
    };
    const f = fakeShj(fs);
    const t = new WorkspaceTrees({ request: f.request, onChange: () => {} });
    t.activate("w");
    await settle();
    t.toggle("w", "a");
    await settle();
    t.toggle("w", "a/b");
    await settle();
    t.toggle("w", "a"); // 閉じる
    await settle();

    // 閉じている間に a/b の中身が変わった
    fs["a/b"] = [file("new")];
    f.sent.length = 0;
    t.toggle("w", "a");
    await settle();
    assert.deepEqual(
      f.sent.filter((x) => x.method === "tree.list").map((x) => x.params.path),
      ["a", "a/b"],
    );
    assert.deepEqual(
      rows(t.get("w")!).map((r) => r.path),
      ["a", "a/b", "a/b/new"],
    );

    // 閉じている間に a/b が消えた
    t.toggle("w", "a");
    await settle();
    fs.a = [];
    delete fs["a/b"];
    f.sent.length = 0;
    t.toggle("w", "a");
    await settle();
    await settle();
    assert.equal(t.get("w")?.expanded["a/b"], undefined);
    assert.deepEqual(f.sent.at(-1), {
      method: "tree.watch",
      params: { workspaceId: "w", paths: ["", "a"] },
    });
  });

  it("git.changed を当てる", async () => {
    const f = fakeShj({ "": [file("a")] });
    let changes = 0;
    const t = new WorkspaceTrees({
      request: f.request,
      onChange: () => changes++,
    });
    t.activate("w");
    await settle();
    const before = changes;
    t.handleGitChanged({ workspaceId: "w", marks: { a: "M" }, rev: 2 });
    assert.equal(changes, before + 1);
    assert.deepEqual(rows(t.get("w")!)[0].mark, { kind: "file", letter: "M" });
  });

  it("フォルダが切り替わったら開閉を捨てて、今のワークスペースなら取り直す", async () => {
    const f = fakeShj({ "": [dir("src")], src: [file("b")] });
    const t = new WorkspaceTrees({ request: f.request, onChange: () => {} });
    t.activate("w");
    await settle();
    t.toggle("w", "src");
    await settle();
    f.sent.length = 0;
    t.reset("w");
    assert.deepEqual(rows(t.get("w")!), [], "いったん空にする");
    await settle();
    assert.deepEqual(
      f.sent.map((x) => x.method),
      ["tree.watch", "tree.list", "git.status"],
    );
    assert.deepEqual(f.sent[0].params, { workspaceId: "w", paths: [""] });
    assert.deepEqual(
      rows(t.get("w")!).map((r) => r.path),
      ["src"],
    );

    // フォーカスしていないワークスペースは、フォーカスしたときに取る
    t.activate("v");
    await settle();
    f.sent.length = 0;
    t.reset("w");
    await settle();
    assert.deepEqual(f.sent, []);
    t.reset("nobody"); // 知らないワークスペースは何もしない
  });

  it("一覧から消えたワークスペースは忘れる", async () => {
    const f = fakeShj({ "": [] });
    const t = new WorkspaceTrees({ request: f.request, onChange: () => {} });
    t.activate("w");
    await settle();
    t.retain(["v"]);
    assert.equal(t.get("w"), undefined);
    assert.equal(t.activeId, null);
  });
});
