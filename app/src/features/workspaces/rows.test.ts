import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Workspace } from "../../infrastructure/rpc/protocol.ts";
import { LOCAL } from "../sessions/shell.ts";
import { MACHINE_COLORS } from "../sessions/colors.ts";
import { EMPTY_GWS, reconcile, type GwsState } from "./model.ts";
import type { SessionState } from "../sessions/session.ts";
import {
  tabToReveal,
  band,
  buildSidebar,
  health,
  gwsRows,
  isTermless,
  machineLabel,
  type Row,
  stepRow,
  gwsOfShjFocus,
  shownIsBrowser,
  focusedRow,
  unsetTitle,
  type BandTabs,
} from "./rows.ts";
import { setLang } from "../../i18n/index.ts";

// 日本語の文で確かめる（画面の言葉の既定は英語）
setLang("ja");

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

/**
 * マシンの一覧から、サイドバーの行を作る（ワークスペース 1 つ = ターミナルのタブ 1 つ = GUI のワークスペース 1 つ）。
 * state を渡すと、その GUI のワークスペースで作る。
 */
function rowsOf(
  targets: string[],
  lists: Record<string, Workspace[]>,
  focus: { target: string; id: string } | null,
  opts: {
    states?: Record<string, SessionState | undefined>;
    colors?: Record<string, string>;
    legacy?: { target: string; id: string }[];
    state?: GwsState;
  } = {},
): Row[] {
  const groups = buildSidebar(
    targets,
    opts.states ?? {},
    lists,
    focus,
    opts.colors ?? {},
  );
  const state =
    opts.state ??
    reconcile(EMPTY_GWS, {
      lists: Object.fromEntries(
        Object.entries(lists).map(([t, l]) => [
          t,
          l.map((w) => ({ id: w.id, title: band(w, false).title })),
        ]),
      ),
      legacyOrder: opts.legacy,
    }).state;
  const group = (t: string) => groups.find((g) => g.target === t)!;
  return gwsRows(state, {
    groups,
    workspaces: lists,
    focus,
    browser: new Map(),
    views: {},
    labelOf: machineLabel,
    colorOf: (t) => group(t).color,
    healthOf: (t) => group(t).health,
  });
}

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

  it("2 行目は「ブランチ (short sha)」。detached HEAD なら「(sha)」、sha が読めなければブランチだけ", () => {
    const b = band(
      ws({ id: "a", root: "/src/x", branch: "main", sha: "9e11274" }),
      false,
    );
    assert.equal(b.detail, "main (9e11274)");
    assert.equal(b.dir, "");
    assert.equal(b.branch, "main");
    assert.equal(b.sha, "9e11274");
    assert.equal(
      band(ws({ id: "d", root: "/src/x", sha: "9e11274" }), false).detail,
      "(9e11274)",
    );
    assert.equal(
      band(ws({ id: "u", root: "/src/x", branch: "main" }), false).detail,
      "main",
    );
    assert.equal(band(ws({ id: "e", root: "/src/x" }), false).detail, "");
  });

  it("名前を変えた帯は、2 行目の先頭にディレクトリ名を足す。変えていない帯は足さない", () => {
    const l = band(
      ws({
        id: "a",
        root: "/src/shijimi-editor",
        branch: "main",
        sha: "9e11274",
        label: "エディタ",
      }),
      false,
    );
    assert.equal(l.title, "エディタ");
    assert.equal(l.dir, "shijimi-editor");
    assert.equal(l.detail, "shijimi-editor · main (9e11274)");
    const d = band(
      ws({ id: "b", root: "/src/x", sha: "9e11274", label: "名前" }),
      false,
    );
    assert.equal(d.detail, "x · (9e11274)");
    const n = band(
      ws({
        id: "c",
        root: "/src/x",
        kind: "cwd",
        sha: "9e11274",
        label: "名前",
      }),
      false,
    );
    assert.equal(n.detail, "x · git なし");
    assert.equal(n.sha, "");
    const plain = band(
      ws({ id: "p", root: "/src/x", branch: "main", sha: "9e11274" }),
      false,
      2,
    );
    assert.equal(plain.dir, "");
    assert.equal(plain.detail, "main (9e11274) #2");
    assert.equal(band(ws({ id: "u", label: "メモ" }), false).dir, "");
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
    assert.equal(g.detail, "x · main");
    const n = band(
      ws({ id: "n", root: "/etc/nginx", kind: "cwd", label: "設定" }),
      false,
    );
    assert.equal(n.title, "設定");
    assert.equal(n.path, false);
    assert.equal(n.detail, "nginx · git なし");
    assert.equal(n.autoTitle, "/etc/nginx");
  });

  it("フォルダ未定でも、つけた名前を出す。名前が無ければ label は空で、autoTitle が title と同じ", () => {
    const u = band(ws({ id: "u", label: "メモ" }), false);
    assert.equal(u.title, "メモ");
    assert.equal(u.unset, false);
    assert.equal(u.autoTitle, unsetTitle());
    const a = band(ws({ id: "a", root: "/src/x" }), false);
    assert.equal(a.label, "");
    assert.equal(a.autoTitle, a.title);
  });

  it("フォルダ未定のワークスペースは「（フォルダ未定）」", () => {
    const b = band(ws({ id: "u" }), false);
    assert.equal(b.title, unsetTitle());
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
        [unsetTitle(), ""],
        ["app", "main #3"],
      ],
    );
  });

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
        ["作業用", "app · main"],
        ["app", "main"],
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

describe("gwsOfShjFocus（今いるワークスペースが無いときに入る先）", () => {
  const state: GwsState = {
    list: [
      {
        id: "g1",
        name: "",
        num: 1,
        tabs: [{ kind: "term", target: "a", ws: "x", title: "" }],
      },
      {
        id: "g2",
        name: "",
        num: 2,
        tabs: [{ kind: "term", target: "b", ws: "y", title: "" }],
      },
      { id: "g3", name: "", num: 3, tabs: [] },
    ],
  };

  it("shj のフォーカスのターミナルのタブを持つワークスペースと、そのタブ（マシンの順で最初のもの）", () => {
    assert.deepEqual(gwsOfShjFocus(state, { a: null, b: "y" }), {
      gws: state.list[1],
      term: { target: "b", ws: "y" },
    });
    assert.equal(gwsOfShjFocus(state, { a: "x", b: "y" })?.gws.id, "g1");
  });

  it("どのワークスペースにも入っていない・フォーカスが無ければ undefined", () => {
    assert.equal(gwsOfShjFocus(state, { a: "gone", b: null }), undefined);
    assert.equal(gwsOfShjFocus(state, {}), undefined);
  });
});

describe("gwsRows", () => {
  const lists = {
    a: [ws({ id: "a1", root: "/a1" }), ws({ id: "a2", root: "/a2" })],
    b: [ws({ id: "b1", root: "/b1" }), ws({ id: "b2", root: "/b2" })],
  };
  const up = { b: { kind: "connected", hello: {} as never } } as const;
  const ids = (rows: { band: { id: string } }[]) => rows.map((r) => r.band.id);

  it("GUI のワークスペースの順に 1 列にする。マシンの名前・色・状態を添え、名前の無いものは ws1・ws2…", () => {
    const rows = rowsOf(["a", "b"], lists, null, {
      states: up,
      colors: { b: "#e5b567" },
    });
    assert.deepEqual(ids(rows), ["a1", "a2", "b1", "b2"]);
    assert.deepEqual(
      rows.map((r) => [r.target, r.machine, r.health]),
      [
        ["a", "a", "down"],
        ["a", "a", "down"],
        ["b", "b", "up"],
        ["b", "b", "up"],
      ],
    );
    assert.equal(rows[2].color, "#e5b567");
    assert.deepEqual(
      rows.map((r) => r.band.title),
      ["ws1", "ws2", "ws3", "ws4"],
    );
    assert.equal(rows[0].band.label, "");
    assert.equal(rows[0].band.autoTitle, "ws1");
    // タブが 1 つのワークスペースも、タブの行を 1 つ出す。最後のタブにも ✕ を出す（閉じると、ワークスペースも閉じる）
    assert.deepEqual(
      rows[0].tabs.items.map((i) => [i.kind, i.closable]),
      [["term", true]],
    );
  });

  it("ターミナルのタブの行：フォルダ（ホームは ~）・「ブランチ (sha)」・マシンの札。git の無いフォルダは git を出さない。ターミナルのタブが 2 つ以上なら ✕ を出す", () => {
    const l = {
      a: [
        ws({
          id: "a1",
          root: "/home/u/src/x",
          display: "~/src/x",
          branch: "main",
          sha: "9e11274",
        }),
        ws({ id: "a2", root: "/tmp/y", display: "/tmp/y", kind: "cwd" }),
      ],
    };
    const state: GwsState = {
      list: [
        {
          id: "g1",
          name: "",
          num: 1,
          tabs: [
            { kind: "term", target: "a", ws: "a1", title: "x" },
            { kind: "term", target: "a", ws: "a2", title: "y" },
          ],
        },
      ],
    };
    const [r] = rowsOf(["a"], l, null, {
      state,
      states: { a: { kind: "connected", hello: {} as never } },
      colors: { a: "#123456" },
    });
    assert.deepEqual(
      r.tabs.items.map((i) => [i.path, i.git, i.closable]),
      [
        ["~/src/x", "main (9e11274)", true],
        ["/tmp/y", "", true],
      ],
    );
    assert.deepEqual(r.tabs.items[0].machine, {
      name: "a",
      color: "#123456",
      health: "up",
    });
    assert.deepEqual(r.tabs.items[0].term, { target: "a", ws: "a1" });
  });

  it("前の並び順の記録（#88）があれば、新しく作るワークスペースをその順に並べる", () => {
    const rows = rowsOf(["a", "b"], lists, null, {
      legacy: [
        { target: "b", id: "b2" },
        { target: "a", id: "a1" },
        { target: "gone", id: "x" },
      ],
    });
    assert.deepEqual(ids(rows), ["b2", "a1", "a2", "b1"]);
  });

  it("名前を付けたワークスペースは、その名前を帯に出し、フォルダ名を 2 行目に出す", () => {
    let state = reconcile(EMPTY_GWS, {
      lists: { a: [{ id: "a1", title: "a1" }] },
    }).state;
    state = { list: [{ ...state.list[0], name: "調査" }] };
    const [r] = rowsOf(["a"], { a: [lists.a[0]] }, null, { state });
    assert.equal(r.band.title, "調査");
    assert.equal(r.band.label, "調査");
    assert.equal(r.band.dir, "a1");
  });

  it("ターミナルのタブとブラウザのタブを、開いた順の 1 つの並びにして出す。切れているマシンのタブは薄く出す。ブラウザのタブは favicon も出す", () => {
    const state: GwsState = {
      list: [
        {
          id: "g1",
          name: "",
          num: 1,
          tabs: [
            { kind: "term", target: "a", ws: "a1", title: "a1" },
            { kind: "browser", id: "t1", name: "メモ" },
            { kind: "term", target: "b", ws: "b9", title: "古い名前" },
            { kind: "browser", id: "gone" },
          ],
        },
      ],
    };
    const groups = buildSidebar(["a", "b"], up, { a: [lists.a[0]] }, null);
    const [r] = gwsRows(state, {
      groups,
      workspaces: { a: [lists.a[0]] },
      focus: { target: "a", id: "a1" },
      browser: new Map([
        [
          "t1",
          {
            id: "t1",
            target: "a",
            workspace: "a1",
            url: "https://x.example/p",
            title: "題",
            favicon: "data:image/png;base64,AAAA",
          },
        ],
      ]),
      views: { g1: "t1" },
      labelOf: machineLabel,
      colorOf: () => "#000",
      healthOf: (t) => groups.find((g) => g.target === t)!.health,
    });
    assert.equal(r.band.focused, true);
    assert.deepEqual(
      r.tabs.items.map((i) => [i.kind, i.title, i.path, i.health, i.favicon]),
      [
        ["term", "a1", "/a1", "down", undefined],
        [
          "browser",
          "メモ",
          "https://x.example/p",
          undefined,
          "data:image/png;base64,AAAA",
        ],
        ["term", "古い名前", "", "up", undefined],
      ],
    );
    assert.equal(r.tabs.shown, JSON.stringify(["b", "t1"]));
    assert.equal(r.tabs.focused, true);
  });

  it("ターミナルのタブが無いワークスペース（ブラウザのタブだけ）は、マシンの名前を出さずに行にする。出すブラウザのタブが 1 つも無ければ行を出さない（#257）", () => {
    const state: GwsState = {
      list: [
        {
          id: "g1",
          name: "調べもの",
          num: 1,
          tabs: [
            { kind: "browser", id: "t1" },
            { kind: "browser", id: "t2" },
          ],
        },
        { id: "g2", name: "", num: 2, tabs: [{ kind: "browser", id: "gone" }] },
      ],
    };
    const groups = buildSidebar(["a"], up, { a: [lists.a[0]] }, null);
    const tab = (id: string) => ({
      id,
      target: "a",
      workspace: "",
      url: `https://${id}.example/`,
      title: "",
    });
    const rows = gwsRows(state, {
      groups,
      workspaces: { a: [lists.a[0]] },
      focus: { target: "a", id: "a1" },
      current: "g1",
      browser: new Map([
        ["t1", tab("t1")],
        ["t2", tab("t2")],
      ]),
      views: { g1: "t2" },
      labelOf: machineLabel,
      colorOf: () => "#000",
      healthOf: () => "up",
    });
    assert.equal(rows.length, 1);
    const [r] = rows;
    assert.equal(r.gws, "g1");
    assert.equal(r.target, "");
    assert.equal(r.machine, "");
    assert.equal(r.band.title, "調べもの");
    assert.equal(r.band.focused, true);
    assert.equal(r.band.showTree, false);
    assert.deepEqual(
      r.tabs.items.map((i) => [i.kind, i.closable]),
      [
        ["browser", true],
        ["browser", true],
      ],
    );
    assert.equal(r.tabs.shown, JSON.stringify(["b", "t2"]));
    // 出しているタブが決まっていなければ、最初のタブ
    const [r2] = gwsRows(state, {
      groups,
      workspaces: {},
      focus: null,
      browser: new Map([["t1", tab("t1")]]),
      views: {},
      labelOf: machineLabel,
      colorOf: () => "#000",
      healthOf: () => "up",
    });
    assert.equal(r2.tabs.shown, JSON.stringify(["b", "t1"]));
    assert.equal(r2.band.focused, false);
  });

  it("タブが 1 つも無い空のワークスペースも、名前だけの行にする（#307）。内蔵ブラウザを使っていなくても出す", () => {
    const state: GwsState = {
      list: [
        { id: "g1", name: "", num: 1, tabs: [] },
        { id: "g2", name: "あとで", num: 2, tabs: [] },
      ],
    };
    const groups = buildSidebar(["a"], up, { a: [lists.a[0]] }, null);
    const rows = gwsRows(state, {
      groups,
      workspaces: { a: [lists.a[0]] },
      focus: { target: "a", id: "a1" },
      current: "g2",
      browser: new Map(),
      views: { g2: "gone" },
      labelOf: machineLabel,
      colorOf: () => "#000",
      healthOf: () => "up",
    });
    assert.deepEqual(
      rows.map((r) => [r.gws, r.target, r.band.id, r.band.title]),
      [
        ["g1", "", "g1", "ws1"],
        ["g2", "", "g2", "あとで"],
      ],
    );
    assert.ok(rows.every(isTermless));
    const r = rows[1];
    assert.equal(r.band.focused, true);
    assert.equal(r.band.showTree, false);
    assert.deepEqual(r.tabs.items, []);
    assert.equal(r.tabs.shown, "");
    assert.equal(r.tabs.focused, true);
  });

  it("今出しているターミナルのタブが切れているマシンのものなら、最後に分かった名前で薄く出す", () => {
    const state: GwsState = {
      list: [
        {
          id: "g1",
          name: "",
          num: 1,
          tabs: [{ kind: "term", target: "a", ws: "a1", title: "前の名前" }],
        },
      ],
    };
    const [r] = rowsOf(["a"], {}, null, { state });
    assert.equal(r.health, "down");
    assert.equal(r.band.title, "ws1");
    assert.equal(r.band.dir, "前の名前");
    assert.equal(r.band.id, "a1");
  });
});

describe("focusedRow", () => {
  const lists = {
    a: [ws({ id: "a1", root: "/a1" }), ws({ id: "a2", root: "/a2" })],
    b: [
      ws({ id: "b1", root: "/b1" }),
      ws({ id: "b2", root: "/b2" }),
      ws({ id: "b3", root: "/b3" }),
    ],
  };
  const rows = (focus: { target: string; id: string } | null) =>
    rowsOf(["a", "b"], lists, focus);

  it("フォーカスしている行と、並びの何番目か（1 から）・全部でいくつかを返す", () => {
    const f = focusedRow(rows({ target: "b", id: "b1" }));
    assert.equal(f?.row.band.id, "b1");
    assert.equal(f?.index, 3);
    assert.equal(f?.total, 5);
  });

  it("最後の行は、最後の番号", () => {
    const f = focusedRow(rows({ target: "b", id: "b3" }));
    assert.equal(f?.index, 5);
    assert.equal(f?.total, 5);
  });

  it("フォーカスが無ければ null", () => {
    assert.equal(focusedRow(rows(null)), null);
    assert.equal(focusedRow([]), null);
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

describe("stepRow（キーで移る）", () => {
  const rows = ["a", "c", "b", "d"].map((gws) => ({ gws }));

  it("1 列の並びで、下へ・上へ（ターミナルのタブの有無やマシンによらず、並びのとおり）", () => {
    assert.equal(stepRow(rows, "a", "next"), "c");
    assert.equal(stepRow(rows, "c", "prev"), "a");
    const many = Array.from({ length: 12 }, (_, i) => ({ gws: `g${i}` }));
    assert.equal(stepRow(many, "g9", "next"), "g10");
  });

  it("返事を待つあいだに続けて押しても、向かっている先を起点にして進む", () => {
    let from = "a";
    const seen: string[] = [];
    for (let n = 0; n < 3; n++) {
      const next = stepRow(rows, from, "next");
      assert.ok(next);
      from = next;
      seen.push(next);
    }
    assert.deepEqual(seen, ["c", "b", "d"]);
  });

  it("端で反対の端へ回る。1 つだけなら自分に戻る", () => {
    assert.equal(stepRow(rows, "d", "next"), "a");
    assert.equal(stepRow(rows, "a", "prev"), "d");
    assert.equal(stepRow([{ gws: "x" }], "x", "next"), "x");
  });

  it("今のワークスペースが無ければ次は先頭・前は末尾。並びに無ければ同じ。1 つも無ければ null", () => {
    assert.equal(stepRow(rows, null, "next"), "a");
    assert.equal(stepRow(rows, null, "prev"), "d");
    assert.equal(stepRow(rows, "gone", "next"), "a");
    assert.equal(stepRow([], null, "next"), null);
  });
});

describe("shownIsBrowser（ファイルツリーと CHANGES を隠すか）", () => {
  const item = (key: string, kind: "term" | "browser") =>
    ({ key, kind }) as unknown as BandTabs["items"][number];
  const tabs = (shown: string): BandTabs => ({
    items: [item("t", "term"), item("b", "browser")],
    shown,
    focused: true,
  });
  it("ターミナルのタブを出している間は隠さない", () => {
    assert.equal(shownIsBrowser(tabs("t")), false);
  });
  it("ブラウザのタブを出している間は隠す", () => {
    assert.equal(shownIsBrowser(tabs("b")), true);
  });
  it("出しているタブのキーが items に無ければ隠さない", () => {
    assert.equal(shownIsBrowser(tabs("x")), false);
  });
});

describe("tabToReveal（#284）", () => {
  const snap = (gws: string, keys: string[], shown: string) => ({
    gws,
    keys,
    shown,
  });
  it("初めて描いたとき・別のワークスペースに移ったとき・空から一度に埋まったときは、出しているタブ", () => {
    assert.equal(tabToReveal(undefined, snap("a", ["x", "y"], "y")), "y");
    assert.equal(
      tabToReveal(snap("a", ["x"], "x"), snap("b", ["p", "q"], "q")),
      "q",
    );
    assert.equal(
      tabToReveal(snap("a", [], ""), snap("a", ["x", "y", "z"], "x")),
      "x",
    );
  });
  it("出しているタブが替わったら、出しているタブ（足したタブより先）", () => {
    assert.equal(
      tabToReveal(snap("a", ["x", "y"], "x"), snap("a", ["x", "y", "z"], "z")),
      "z",
    );
    assert.equal(
      tabToReveal(snap("a", ["x", "y"], "x"), snap("a", ["x", "y"], "y")),
      "y",
    );
  });
  it("出しているタブが同じでタブが増えたら、増えた最後のタブ", () => {
    assert.equal(
      tabToReveal(snap("a", ["x"], "x"), snap("a", ["x", "y", "z"], "x")),
      "z",
    );
  });
  it("減った・並べ替えただけなら、スクロールしない", () => {
    assert.equal(
      tabToReveal(snap("a", ["x", "y"], "x"), snap("a", ["x"], "x")),
      undefined,
    );
    assert.equal(
      tabToReveal(snap("a", ["x", "y"], "x"), snap("a", ["y", "x"], "x")),
      undefined,
    );
  });
});
