import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Workspace } from "../rpc/protocol.ts";
import { LOCAL } from "../ssh/api.ts";
import { MACHINE_COLORS } from "./colors.ts";
import {
  adoptFocus,
  band,
  buildSidebar,
  health,
  keepFocus,
  splitAtFocus,
  UNSET_TITLE,
} from "./model.ts";

/** root はフォルダ（省くか null ならフォルダ未定）。 */
const ws = (
  w: Partial<Workspace> & { id: string; root?: string | null },
): Workspace => {
  const { root, ...rest } = w;
  const folder = root ?? null;
  return {
    folder,
    kind: folder === null ? null : "git",
    name: folder === null ? null : (folder.split("/").at(-1) ?? ""),
    primary: `p-${w.id}`,
    terms: [],
    files: [],
    ...rest,
  };
};

describe("band", () => {
  it("git のワークスペースは名前とブランチ", () => {
    const b = band(
      ws({ id: "a", root: "/src/shijimi-editor", branch: "main" }),
      false,
    );
    assert.equal(b.title, "shijimi-editor");
    assert.equal(b.detail, "main");
    assert.equal(b.path, false);
    assert.equal(b.root, "/src/shijimi-editor");
  });

  it("目印が無いワークスペースはルートのパスと「git なし」", () => {
    const b = band(
      ws({ id: "n", root: "/etc/nginx", kind: "cwd", name: "nginx" }),
      true,
    );
    assert.equal(b.title, "/etc/nginx");
    assert.equal(b.path, true);
    assert.equal(b.detail, "git なし");
    assert.equal(b.focused, true);
  });

  it("フォルダ未定のワークスペースは「（フォルダ未定）」", () => {
    const b = band(ws({ id: "u" }), false);
    assert.equal(b.title, UNSET_TITLE);
    assert.equal(b.unset, true);
    assert.equal(b.path, false);
    assert.equal(b.detail, "");
    assert.equal(b.root, "");
  });

  it("プライマリで shj が動いているときだけ showTree が true（ツリーを出す）", () => {
    assert.equal(band(ws({ id: "a", root: "/x" }), true).showTree, false);
    assert.equal(
      band(ws({ id: "a", root: "/x", primaryShj: null }), true).showTree,
      false,
    );
    const on = ws({
      id: "a",
      root: "/x",
      primaryShj: { socket: "/s", pid: 1 },
    });
    assert.equal(band(on, true).showTree, true);
    assert.equal(
      band(ws({ id: "u", primaryShj: { socket: "/s", pid: 1 } }), true)
        .showTree,
      true,
    );
  });

  it("同じフォルダの 2 つ目からは番号を付けて見分ける", () => {
    const g = buildSidebar(
      ["a"],
      {},
      {
        a: [
          ws({ id: "1", root: "/src/app", branch: "main" }),
          ws({ id: "2", root: "/src/app", branch: "main" }),
          ws({ id: "3" }),
          ws({ id: "4", root: "/src/app", branch: "main" }),
        ],
      },
      null,
    )[0];
    assert.deepEqual(
      g.bands.map((b) => [b.title, b.detail]),
      [
        ["app", "main"],
        ["app", "main #2"],
        [UNSET_TITLE, ""],
        ["app", "main #3"],
      ],
    );
  });

  it("ブランチが無ければ右は空", () => {
    const b = band(ws({ id: "s", root: "/x/notes", kind: "shijimi" }), false);
    assert.equal(b.detail, "");
  });
});

describe("health", () => {
  it("状態を 3 つに分ける", () => {
    assert.equal(health({ kind: "connected", hello: {} as never }), "up");
    assert.equal(
      health({ kind: "reconnecting", attempt: 1, max: 3, reason: "" }),
      "pending",
    );
    assert.equal(health({ kind: "failed", message: "x" }), "down");
    assert.equal(health(undefined), "down");
  });
});

describe("buildSidebar", () => {
  it("つなぎ先の順に見出しを並べ、帯は作った順、フォーカス中の帯に印を付ける", () => {
    const groups = buildSidebar(
      [LOCAL, "dev-vm"],
      { "dev-vm": { kind: "connected", hello: {} as never } },
      {
        "dev-vm": [
          ws({ id: "p", root: "/src/platform" }),
          ws({ id: "s", root: "/src/app" }),
        ],
      },
      { target: "dev-vm", id: "p" },
    );
    assert.deepEqual(
      groups.map((g) => [g.label, g.health]),
      [
        ["ローカル", "down"],
        ["dev-vm", "up"],
      ],
    );
    assert.deepEqual(groups[0].bands, []);
    assert.deepEqual(
      groups[1].bands.map((b) => [b.id, b.focused]),
      [
        ["p", true],
        ["s", false],
      ],
    );
  });

  it("マシンの色を付ける。決まっていなければ候補の最初の色", () => {
    const groups = buildSidebar(["a", "b"], {}, {}, null, { b: "#e5b567" });
    assert.deepEqual(
      groups.map((g) => g.color),
      [MACHINE_COLORS[0], "#e5b567"],
    );
    const s = splitAtFocus(
      buildSidebar(
        ["a"],
        {},
        { a: [ws({ id: "x", root: "/x" }), ws({ id: "y", root: "/y" })] },
        { target: "a", id: "x" },
        { a: "#c49cff" },
      ),
    );
    assert.equal(s.after.color, "#c49cff");
  });

  it("同じ id でも別のマシンの帯には印を付けない", () => {
    const groups = buildSidebar(
      ["a", "b"],
      {},
      { a: [ws({ id: "x", root: "/x" })], b: [ws({ id: "x", root: "/x" })] },
      { target: "b", id: "x" },
    );
    assert.equal(groups[0].bands[0].focused, false);
    assert.equal(groups[1].bands[0].focused, true);
  });
});

describe("adoptFocus", () => {
  it("フォーカスが無ければ、先に分かったマシンのものを使う", () => {
    assert.deepEqual(adoptFocus(null, "a", "x"), { target: "a", id: "x" });
    assert.equal(adoptFocus(null, "a", null), null);
  });

  it("別のマシンのフォーカスでは動かさない", () => {
    const cur = { target: "a", id: "x" };
    assert.equal(adoptFocus(cur, "b", "y"), cur);
  });

  it("同じマシンで shj のフォーカスが変われば追い、消えれば外す", () => {
    const cur = { target: "a", id: "x" };
    assert.deepEqual(adoptFocus(cur, "a", "y"), { target: "a", id: "y" });
    assert.equal(adoptFocus(cur, "a", null), null);
    assert.equal(adoptFocus(cur, "a", "x"), cur);
  });
});

describe("keepFocus", () => {
  it("フォーカス先が一覧から消えたら（切った・無くなった）外す", () => {
    const cur = { target: "a", id: "x" };
    assert.equal(keepFocus(cur, { a: [ws({ id: "x", root: "/x" })] }), cur);
    assert.equal(keepFocus(cur, { a: [] }), null);
    assert.equal(keepFocus(cur, {}), null);
    assert.equal(keepFocus(null, {}), null);
  });

  it("外れたら、ほかのマシンの shj のフォーカスで一覧にあるものを使う", () => {
    const cur = { target: "a", id: "x" };
    const lists = {
      a: [],
      b: [ws({ id: "y", root: "/y" })],
      c: [ws({ id: "z", root: "/z" })],
    };
    assert.deepEqual(keepFocus(cur, lists, { a: "x", b: null, c: "z" }), {
      target: "c",
      id: "z",
    });
    assert.deepEqual(keepFocus(null, lists, { b: "y", c: "z" }), {
      target: "b",
      id: "y",
    });
    // 一覧に無いフォーカスは使わない
    assert.equal(keepFocus(cur, lists, { b: "gone" }), null);
    // まだあれば、ほかの候補では動かさない
    assert.equal(
      keepFocus({ target: "b", id: "y" }, lists, { c: "z" })?.target,
      "b",
    );
  });
});

describe("splitAtFocus", () => {
  const lists = {
    a: [ws({ id: "a1", root: "/a1" }), ws({ id: "a2", root: "/a2" })],
    b: [
      ws({ id: "b1", root: "/b1" }),
      ws({ id: "b2", root: "/b2" }),
      ws({ id: "b3", root: "/b3" }),
    ],
    c: [ws({ id: "c1", root: "/c1" })],
  };
  const groups = (focus: { target: string; id: string } | null) =>
    buildSidebar(["a", "b", "c"], {}, lists, focus);
  const ids = (bs: { id: string }[]) => bs.map((b) => b.id);

  it("フォーカスまでを上に、残りの帯と後ろのマシンを下に分ける", () => {
    const s = splitAtFocus(groups({ target: "b", id: "b2" }));
    assert.deepEqual(
      s.before.map((g) => g.target),
      ["a"],
    );
    assert.equal(s.focused?.target, "b");
    assert.deepEqual(ids(s.focused!.bands), ["b1", "b2"]);
    assert.equal(s.after.target, "b");
    assert.deepEqual(ids(s.after.rest), ["b3"]);
    assert.deepEqual(
      s.after.groups.map((g) => g.target),
      ["c"],
    );
  });

  it("最後の帯なら下は空", () => {
    const s = splitAtFocus(groups({ target: "c", id: "c1" }));
    assert.deepEqual(
      s.before.map((g) => g.target),
      ["a", "b"],
    );
    assert.deepEqual(ids(s.focused!.bands), ["c1"]);
    assert.deepEqual(s.after.rest, []);
    assert.deepEqual(s.after.groups, []);
  });

  it("フォーカスが無ければ全部上", () => {
    const g = groups(null);
    const s = splitAtFocus(g);
    assert.equal(s.before, g);
    assert.equal(s.focused, null);
    assert.deepEqual(s.after.rest, []);
    assert.deepEqual(s.after.groups, []);
  });
});

describe("buildSidebar の見出し", () => {
  it("labelOf で名前を差し替え、「ローカル」だけ外せない", () => {
    const groups = buildSidebar([LOCAL, "dev"], {}, {}, null, {}, (t) =>
      t === "dev" ? "開発" : "ローカル",
    );
    assert.deepEqual(
      groups.map((g) => [g.label, g.removable]),
      [
        ["ローカル", false],
        ["開発", true],
      ],
    );
  });
});

describe("buildSidebar の fixed", () => {
  it("fixedOf が true のマシンだけ fixed になる（省くと全部 false）", () => {
    const g = buildSidebar(
      [LOCAL, "dev"],
      {},
      {},
      null,
      {},
      undefined,
      (t) => t === "dev",
    );
    assert.deepEqual(
      g.map((x) => x.fixed),
      [false, true],
    );
    assert.deepEqual(
      buildSidebar([LOCAL, "dev"], {}, {}, null).map((x) => x.fixed),
      [false, false],
    );
  });
});
