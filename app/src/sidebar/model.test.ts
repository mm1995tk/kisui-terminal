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
  shouldSendMoveTo,
  stepFrom,
  stepMachine,
  stepWorkspace,
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

  it("display があれば、パスの帯はそれを出す（root は絶対パスのまま）", () => {
    const b = band(
      ws({
        id: "h",
        root: "/Users/me/x",
        kind: "cwd",
        display: "~/x",
      }),
      false,
    );
    assert.equal(b.title, "~/x");
    assert.equal(b.root, "/Users/me/x");
  });

  it("つけた名前（label）があれば、自動の名前の代わりに出す。ブランチと「git なし」はそのまま、2 つ目の番号は付けない", () => {
    const g = band(
      ws({ id: "a", root: "/src/x", branch: "main", label: "作業用" }),
      false,
      2,
    );
    assert.equal(g.title, "作業用");
    assert.equal(g.label, "作業用");
    assert.equal(g.autoTitle, "x");
    assert.equal(g.path, false);
    assert.equal(g.detail, "main");
    const n = band(
      ws({ id: "n", root: "/etc/nginx", kind: "cwd", label: "設定" }),
      false,
    );
    assert.equal(n.title, "設定");
    assert.equal(n.path, false);
    assert.equal(n.detail, "git なし");
    assert.equal(n.autoTitle, "/etc/nginx");
  });

  it("フォルダ未定でも、つけた名前を出す。名前が無ければ label は空で、autoTitle が title と同じ", () => {
    const u = band(ws({ id: "u", label: "メモ" }), false);
    assert.equal(u.title, "メモ");
    assert.equal(u.unset, false);
    assert.equal(u.autoTitle, UNSET_TITLE);
    const a = band(ws({ id: "a", root: "/src/x" }), false);
    assert.equal(a.label, "");
    assert.equal(a.autoTitle, a.title);
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

  it("名前をつけたワークスペースは、同じフォルダの番号を数えない", () => {
    const g = buildSidebar(
      ["a"],
      {},
      {
        a: [
          ws({ id: "1", root: "/src/app", branch: "main", label: "作業用" }),
          ws({ id: "2", root: "/src/app", branch: "main" }),
        ],
      },
      null,
    )[0];
    assert.deepEqual(
      g.bands.map((b) => [b.title, b.detail]),
      [
        ["作業用", "main"],
        ["app", "main"],
      ],
    );
  });
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

  it("移り先（prefer）が一覧にあれば、shj のフォーカスより先に使う", () => {
    const lists = {
      a: [ws({ id: "y", root: "/y" })],
      b: [ws({ id: "z", root: "/z" })],
    };
    const cur = { target: "a", id: "x" };
    const prefer = { target: "a", id: "y" };
    assert.deepEqual(keepFocus(cur, lists, { b: "z" }, prefer), prefer);
    // 一覧に無い移り先は使わない
    assert.deepEqual(
      keepFocus(cur, lists, { b: "z" }, { target: "a", id: "gone" }),
      { target: "b", id: "z" },
    );
    // まだあれば動かさない
    assert.deepEqual(keepFocus({ target: "b", id: "z" }, lists, {}, prefer), {
      target: "b",
      id: "z",
    });
  });

  // フォーカスしているワークスペース x を閉じると、閉じる返事より先に
  // workspace.changed（x が消えた）→ shj のフォーカスが外れた（null）の順に知らせが届く。
  // App はそれぞれで keepFocus（後者は adoptFocus も）を通すので、その間に描く一覧で
  // フォーカスが一度も無くならない（サイドバーの並びが一瞬崩れない）ことを確かめる。
  it("フォーカスしているワークスペースを閉じても、途中でフォーカスが無くならない", () => {
    const before = {
      a: [
        ws({ id: "w", root: "/w" }),
        ws({ id: "x", root: "/x" }),
        ws({ id: "y", root: "/y" }),
      ],
      b: [ws({ id: "z", root: "/z" })],
    };
    const after = { ...before, a: before.a.filter((w) => w.id !== "x") };
    const closing = { target: "a", id: "x" };
    const next = { target: "a", id: "y" };
    const drawn = (f: ReturnType<typeof keepFocus>) =>
      splitAtFocus(buildSidebar(["a", "b"], {}, after, f)).focused;

    // 1. 一覧から x が消えた（shj のフォーカスはまだ x）
    const f1 = keepFocus(closing, after, { a: "x", b: "z" }, next);
    assert.deepEqual(f1, next);
    assert.deepEqual(
      drawn(f1)?.bands.map((b) => b.id),
      ["w", "y"],
    );
    // 2. shj のフォーカスが外れた
    const f2 = keepFocus(
      adoptFocus(f1, "a", null),
      after,
      { a: null, b: "z" },
      next,
    );
    assert.deepEqual(f2, next);
    assert.notEqual(drawn(f2), null);

    // 移り先が無ければ、ほかのマシンの shj のフォーカス（b）に移る
    assert.deepEqual(keepFocus(closing, after, { a: "x", b: "z" }), {
      target: "b",
      id: "z",
    });
  });
});

describe("shouldSendMoveTo", () => {
  const lists = {
    a: [ws({ id: "y", root: "/y" }), ws({ id: "w", root: "/w" })],
  };
  const moveTo = { target: "a", id: "y" };

  it("GUI のフォーカスがまだ移り先で、移り先が一覧にあれば伝える", () => {
    assert.equal(
      shouldSendMoveTo({ target: "a", id: "y" }, moveTo, lists),
      true,
    );
  });

  it("待つあいだに別の帯を選んでいたら伝えない", () => {
    assert.equal(
      shouldSendMoveTo({ target: "a", id: "w" }, moveTo, lists),
      false,
    );
    assert.equal(shouldSendMoveTo(null, moveTo, lists), false);
  });

  it("移り先も一覧から消えていたら伝えない", () => {
    assert.equal(
      shouldSendMoveTo(moveTo, moveTo, { a: [ws({ id: "w", root: "/w" })] }),
      false,
    );
    assert.equal(shouldSendMoveTo(moveTo, moveTo, {}), false);
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

describe("stepWorkspace / stepMachine（キーで移る）", () => {
  const g = (target: string, ...ids: string[]) => ({
    target,
    bands: ids.map((id) => ({ id })),
  });
  const groups = [g("local", "a", "b"), g("empty"), g("ssh", "c", "d")];

  it("ワークスペースは、マシンをまたいで下へ・上へ。10 番目以降にも移れる", () => {
    assert.deepEqual(
      stepWorkspace(groups, { target: "local", id: "a" }, "next"),
      { target: "local", id: "b" },
    );
    // 最後のワークスペースから、ワークスペースが無いマシンを飛ばして次のマシンの先頭へ
    assert.deepEqual(
      stepWorkspace(groups, { target: "local", id: "b" }, "next"),
      { target: "ssh", id: "c" },
    );
    assert.deepEqual(
      stepWorkspace(groups, { target: "ssh", id: "c" }, "prev"),
      { target: "local", id: "b" },
    );
    const many = [g("m", ...Array.from({ length: 12 }, (_, i) => `w${i}`))];
    assert.deepEqual(stepWorkspace(many, { target: "m", id: "w9" }, "next"), {
      target: "m",
      id: "w10",
    });
  });

  it("返事を待つあいだに続けて押しても、向かっている先を起点にして進む", () => {
    const current = { target: "local", id: "a" };
    let heading: { target: string; id: string } | null = null;
    const seen: string[] = [];
    // フォーカスは前のまま（current）。向かっている先だけが進む
    for (let n = 0; n < 3; n++) {
      const next = stepWorkspace(groups, stepFrom(heading, current), "next");
      assert.ok(next);
      heading = next;
      seen.push(next.id);
    }
    assert.deepEqual(seen, ["b", "c", "d"]);
    // 向かっている先が無ければ、今のフォーカス
    assert.deepEqual(stepFrom(null, current), current);
    // マシンも、向かっている先のマシンから数える
    assert.equal(stepMachine(groups, heading?.target, "prev")?.target, "empty");
  });

  it("ワークスペースの無いマシンに止まっているときは、そのマシンの位置から移る", () => {
    const cur = { target: "local", id: "a" };
    assert.deepEqual(stepWorkspace(groups, cur, "next", "empty"), {
      target: "ssh",
      id: "c",
    });
    assert.deepEqual(stepWorkspace(groups, cur, "prev", "empty"), {
      target: "local",
      id: "b",
    });
    // 先頭のマシンなら、前は無い（端で止まる）
    assert.equal(stepWorkspace([g("e"), g("x", "a")], null, "prev", "e"), null);
  });

  it("ワークスペースは、端で止まる（回らない）", () => {
    assert.equal(
      stepWorkspace(groups, { target: "ssh", id: "d" }, "next"),
      null,
    );
    assert.equal(
      stepWorkspace(groups, { target: "local", id: "a" }, "prev"),
      null,
    );
  });

  it("ワークスペースは、フォーカスが無ければ次は先頭・前は末尾。1 つも無ければ null", () => {
    assert.deepEqual(stepWorkspace(groups, null, "next"), {
      target: "local",
      id: "a",
    });
    assert.deepEqual(stepWorkspace(groups, null, "prev"), {
      target: "ssh",
      id: "d",
    });
    assert.deepEqual(
      stepWorkspace(groups, { target: "gone", id: "x" }, "next"),
      { target: "local", id: "a" },
    );
    assert.equal(stepWorkspace([g("empty")], null, "next"), null);
  });

  it("マシンは、前・次へ。移り先は最後に選んでいたワークスペース、無ければ先頭", () => {
    assert.deepEqual(stepMachine(groups, "ssh", "prev"), {
      target: "empty",
      ws: null,
    });
    assert.deepEqual(stepMachine(groups, "empty", "next"), {
      target: "ssh",
      ws: "c",
    });
    assert.deepEqual(
      stepMachine(groups, "empty", "next", (t) =>
        t === "ssh" ? "d" : undefined,
      ),
      { target: "ssh", ws: "d" },
    );
    // 覚えていたワークスペースが無くなっていたら先頭
    assert.deepEqual(
      stepMachine(groups, "empty", "next", () => "gone"),
      { target: "ssh", ws: "c" },
    );
  });

  it("マシンは、端で止まる。今のマシンが分からなければ次は先頭・前は末尾", () => {
    assert.equal(stepMachine(groups, "ssh", "next"), null);
    assert.equal(stepMachine(groups, "local", "prev"), null);
    assert.equal(stepMachine(groups, undefined, "next")?.target, "local");
    assert.equal(stepMachine(groups, undefined, "prev")?.target, "ssh");
    assert.equal(stepMachine([], undefined, "next"), null);
  });
});
