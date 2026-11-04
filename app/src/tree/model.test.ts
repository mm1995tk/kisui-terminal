import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Files, Pane, TreeEntry } from "../rpc/protocol.ts";
import { RpcError } from "../rpc/message.ts";
import { iconFor } from "./icons.ts";
import {
  applyGitChanged,
  applyGitStatus,
  applyList,
  applyTreeChanged,
  currentFile,
  openErrorText,
  dropDir,
  emptyTree,
  nest,
  ROOT,
  rowAction,
  rows,
  toggle,
  watchPaths,
  type TreeState,
} from "./model.ts";

const dir = (name: string, more: Partial<TreeEntry> = {}): TreeEntry => ({
  name,
  kind: "dir",
  ...more,
});
const file = (name: string, more: Partial<TreeEntry> = {}): TreeEntry => ({
  name,
  kind: "file",
  ...more,
});

/** ルートに internal/ と README.md、internal に ui/ と a.go がある木。internal を開いてある。 */
function sample(): TreeState {
  let s = emptyTree();
  s = applyList(s, ROOT, {
    entries: [dir("internal"), file("README.md")],
    rev: 1,
  });
  s = toggle(s, "internal");
  s = applyList(s, "internal", {
    entries: [dir("ui"), file("a.go")],
    rev: 1,
  });
  return s;
}

describe("rows", () => {
  it("開いたフォルダの中身を、深さを付けてフォルダの下に並べる", () => {
    const r = rows(sample());
    assert.deepEqual(
      r.map((x) => [x.path, x.depth, x.dir, x.expanded]),
      [
        ["internal", 0, true, true],
        ["internal/ui", 1, true, false],
        ["internal/a.go", 1, false, false],
        ["README.md", 0, false, false],
      ],
    );
    assert.equal(r[0].icon.kind, "folder-open");
    assert.equal(r[1].icon.kind, "folder");
    assert.equal(r[2].icon.kind, "go");
  });

  it("開いたがまだ取っていないフォルダは loading", () => {
    const s = toggle(sample(), "internal/ui");
    const ui = rows(s).find((x) => x.path === "internal/ui");
    assert.equal(ui?.expanded, true);
    assert.equal(ui?.loading, true);
  });

  it("閉じたら中身は出さないが、子の開閉は覚えておく", () => {
    let s = toggle(sample(), "internal/ui");
    s = applyList(s, "internal/ui", { entries: [file("b.go")], rev: 1 });
    s = toggle(s, "internal");
    assert.deepEqual(
      rows(s).map((x) => x.path),
      ["internal", "README.md"],
    );
    s = toggle(s, "internal");
    assert.deepEqual(
      rows(s).map((x) => x.path),
      [
        "internal",
        "internal/ui",
        "internal/ui/b.go",
        "internal/a.go",
        "README.md",
      ],
    );
  });

  it("5000 件で切れたフォルダの最後に「ここから先は出していない」の行を出す", () => {
    const s = applyList(emptyTree(), ROOT, {
      entries: [file("a"), file("b")],
      truncated: true,
      rev: 1,
    });
    const r = rows(s);
    assert.equal(r.length, 3);
    assert.equal(r[2].truncated, true);
  });

  it("git.status より前は tree.list の git と gitChildren で印を出す", () => {
    let s = applyList(emptyTree(), ROOT, {
      entries: [
        dir("internal", { gitChildren: true }),
        dir("node_modules", { git: "!" }),
        file("a.go", { git: "M" }),
        file("b.go"),
      ],
      rev: 1,
    });
    assert.deepEqual(
      rows(s).map((x) => x.mark),
      [
        { kind: "children" },
        { kind: "ignored" },
        { kind: "file", letter: "M" },
        null,
      ],
    );
    // git.status のあとは全体の印から求める（フォルダの「•」も）
    s = applyGitStatus(s, { branch: "main", marks: { "b.go": "?" }, rev: 3 });
    assert.deepEqual(
      rows(s).map((x) => x.mark),
      [null, { kind: "ignored" }, null, { kind: "file", letter: "?" }],
    );
    s = applyGitChanged(s, {
      workspaceId: "w",
      marks: { "internal/x/y.go": "A" },
      rev: 4,
    });
    assert.deepEqual(rows(s)[0].mark, { kind: "children" });
  });
});

describe("watchPaths", () => {
  it("ルートと、画面に出ている開いたフォルダ", () => {
    let s = toggle(sample(), "internal/ui");
    assert.deepEqual(watchPaths(s), [ROOT, "internal", "internal/ui"]);
    s = toggle(s, "internal");
    assert.deepEqual(watchPaths(s), [ROOT]);
  });
});

describe("applyList", () => {
  it("tree.changed の版より古い返事は捨てる", () => {
    const { state } = applyTreeChanged(sample(), ["internal"], 5);
    const s = applyList(state, "internal", { entries: [], rev: 4 });
    assert.equal(s, state);
    const t = applyList(state, "internal", { entries: [], rev: 5 });
    assert.deepEqual(t.listings.internal.entries, []);
  });

  it("中身から消えたフォルダは、開いていた印と中身も消す", () => {
    let s = toggle(sample(), "internal/ui");
    s = applyList(s, "internal/ui", { entries: [file("b.go")], rev: 1 });
    s = applyList(s, "internal", { entries: [file("a.go")], rev: 2 });
    assert.equal(s.expanded["internal/ui"], undefined);
    assert.equal(s.listings["internal/ui"], undefined);
    assert.equal(s.expanded.internal, true);
  });
});

describe("dropDir", () => {
  it("読めなかったフォルダを、中のものごと忘れる", () => {
    let s = toggle(sample(), "internal/ui");
    s = dropDir(s, "internal");
    assert.deepEqual(s.expanded, {});
    assert.deepEqual(Object.keys(s.listings), [ROOT]);
  });
});

describe("applyTreeChanged", () => {
  it("画面に出ているフォルダだけを取り直す", () => {
    const s = toggle(sample(), "internal"); // 閉じる
    const r = applyTreeChanged(s, [ROOT, "internal"], 2);
    assert.deepEqual(r.refetch, [ROOT]);
    assert.equal(r.state.minRev.internal, 2);
  });
});

describe("git の印", () => {
  it("版の古い git.changed は捨て、null の印は消す", () => {
    let s = applyGitStatus(emptyTree(), {
      branch: "main",
      marks: { a: "M", b: "A" },
      rev: 2,
    });
    s = applyGitChanged(s, { workspaceId: "w", marks: { c: "M" }, rev: 2 });
    assert.deepEqual(s.marks, { a: "M", b: "A" });
    s = applyGitChanged(s, { workspaceId: "w", marks: { a: null }, rev: 3 });
    assert.deepEqual(s.marks, { b: "A" });
  });

  it("git.status の返事より先に来た git.changed は、返事より新しいものだけ当てる", () => {
    let s = applyGitChanged(emptyTree(), {
      workspaceId: "w",
      marks: { old: "M" },
      rev: 1,
    });
    s = applyGitChanged(s, { workspaceId: "w", marks: { new: "M" }, rev: 3 });
    s = applyGitStatus(s, { branch: "", marks: { base: "A" }, rev: 2 });
    assert.deepEqual(s.marks, { base: "A", new: "M" });
    assert.equal(s.gitRev, 3);
  });
});

describe("iconFor", () => {
  it("TUI と同じく、名前が拡張子より先", () => {
    assert.equal(iconFor("go.mod", false, false).kind, "go");
    assert.equal(iconFor("flake.lock", false, false).kind, "nix");
    assert.equal(iconFor("Cargo.lock", false, false).kind, "lock");
    assert.equal(iconFor("App.TSX", false, false).kind, "ts");
    assert.equal(iconFor(".gitignore", false, false).kind, "git");
    assert.equal(iconFor("LICENSE", false, false).kind, "license");
    assert.equal(iconFor("noext", false, false).kind, "default");
    assert.equal(iconFor("src", true, true).kind, "folder-open");
  });
});

describe("nest", () => {
  it("深さで親子に組む", () => {
    let s = toggle(sample(), "internal/ui");
    s = applyList(s, "internal/ui", { entries: [file("b.go")], rev: 1 });
    const shape = (ns: ReturnType<typeof nest>): unknown =>
      ns.map((n) =>
        n.children.length ? [n.row.name, shape(n.children)] : n.row.name,
      );
    assert.deepEqual(shape(nest(rows(s))), [
      ["internal", [["ui", ["b.go"]], "a.go"]],
      "README.md",
    ]);
  });

  it("空なら空", () => {
    assert.deepEqual(nest([]), []);
  });
});

describe("rowAction", () => {
  const fileRow = { dir: false, expanded: false };
  const closed = { dir: true, expanded: false };
  const open = { dir: true, expanded: true };

  it("ファイルは押す・Enter・Space で開く。ほかのキーでは何もしない", () => {
    assert.equal(rowAction(fileRow), "open");
    assert.equal(rowAction(fileRow, "Enter"), "open");
    assert.equal(rowAction(fileRow, " "), "open");
    assert.equal(rowAction(fileRow, "ArrowRight"), null);
    assert.equal(rowAction(fileRow, "a"), null);
  });

  it("フォルダは押す・Enter・Space で開閉し、→ は閉じているとき、← は開いているときだけ", () => {
    assert.equal(rowAction(closed), "toggle");
    assert.equal(rowAction(open, "Enter"), "toggle");
    assert.equal(rowAction(open, " "), "toggle");
    assert.equal(rowAction(closed, "ArrowRight"), "toggle");
    assert.equal(rowAction(open, "ArrowRight"), null);
    assert.equal(rowAction(open, "ArrowLeft"), "toggle");
    assert.equal(rowAction(closed, "ArrowLeft"), null);
  });

  it("5000 件より先の印の行は何もしない", () => {
    assert.equal(rowAction({ ...fileRow, truncated: true }), null);
    assert.equal(rowAction({ ...fileRow, truncated: true }, "Enter"), null);
  });
});

describe("currentFile", () => {
  const pane = (id: string, kind = "text"): Pane => ({
    id,
    kind,
    title: { text: id },
    viewport: { top: 0, rows: 1, cols: 1, left: 0, total: 1 },
    curLine: 0,
  });
  const files = (active: number, ...panes: Pane[]): Files => ({
    panes,
    active,
  });

  it("フォーカスしているペインのファイルを、ルートからの相対パスにする", () => {
    const f = files(
      1,
      pane("/w/README.md"),
      pane("/w/internal/ui/explorer.go"),
    );
    assert.equal(currentFile(f, "/w"), "internal/ui/explorer.go");
    assert.equal(currentFile(f, "/w/"), "internal/ui/explorer.go");
    assert.equal(
      currentFile(files(0, pane("/w/a.png", "image")), "/w"),
      "a.png",
    );
  });

  it("ルートの外・名前が前だけ同じフォルダ・差分やプレビューは無し", () => {
    assert.equal(currentFile(files(0, pane("/x/a.go")), "/w"), undefined);
    assert.equal(currentFile(files(0, pane("/wx/a.go")), "/w"), undefined);
    assert.equal(
      currentFile(files(0, pane("/w/a.md#preview", "preview")), "/w"),
      undefined,
    );
    assert.equal(
      currentFile(files(0, pane("/w/a.go:base", "diff")), "/w"),
      undefined,
    );
    assert.equal(currentFile(files(0, pane("", "welcome")), "/w"), undefined);
  });

  it("画面やルートがまだ無ければ無し", () => {
    assert.equal(currentFile(undefined, "/w"), undefined);
    assert.equal(currentFile(files(0, pane("/w/a.go")), undefined), undefined);
    assert.equal(currentFile(files(3, pane("/w/a.go")), "/w"), undefined);
  });
});

describe("openErrorText", () => {
  it("shj のエラーコードを言葉にする。知らないものは文言をそのまま", () => {
    const err = (code: number) => new RpcError({ code, message: "m" });
    assert.equal(
      openErrorText("a/link", err(-32004)),
      "a/link を開けませんでした（ワークスペースの外を指しています）",
    );
    assert.equal(
      openErrorText("gone.go", err(-32003)),
      "gone.go を開けませんでした（見つかりません）",
    );
    assert.equal(
      openErrorText("x", err(-32603)),
      "x を開けませんでした（rpc error -32603 (internal_error): m）",
    );
    assert.equal(
      openErrorText("x", new Error("connection closed")),
      "x を開けませんでした（connection closed）",
    );
  });
});
