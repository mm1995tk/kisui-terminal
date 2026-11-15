import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addTab,
  closeTab,
  cycle,
  EMPTY_TABS,
  fromStored,
  isFolded,
  newTabId,
  normalizeUrl,
  pruneWorkspaces,
  shownTab,
  showTab,
  tabsOf,
  toggleFold,
  toStored,
  updateTab,
  validTabId,
  type BrowserTab,
  type TabsState,
} from "./tabs.ts";

const tab = (id: string, workspace = "w1", target = "@local"): BrowserTab => ({
  id,
  target,
  workspace,
  url: `https://${id}.example/`,
  title: "",
});

/** w1 に a・b・c、w2 に d（どれも出していない）。 */
function three(): TabsState {
  let s = EMPTY_TABS;
  for (const t of [tab("a"), tab("b"), tab("c"), tab("d", "w2")])
    s = addTab(s, t);
  return showTab(showTab(s, "@local", "w1", null), "@local", "w2", null);
}

describe("内蔵ブラウザのタブ", () => {
  it("足したタブはワークスペースの最後に入り、それを出す", () => {
    const s = addTab(EMPTY_TABS, tab("a"));
    assert.equal(shownTab(s, "@local", "w1")?.id, "a");
    assert.equal(shownTab(s, "@local", "w2"), undefined);
    // 同じ id のワークスペースでも、マシンが違えば別
    assert.equal(shownTab(s, "dev", "w1"), undefined);
    assert.deepEqual(
      tabsOf(three(), "@local", "w1").map((t) => t.id),
      ["a", "b", "c"],
    );
  });

  it("o j は グリッド → 1 番目 → 2 番目 → … → グリッド、o k は逆に回る", () => {
    let s = three();
    const seq: (string | undefined)[] = [];
    for (let i = 0; i < 4; i++) {
      s = cycle(s, "@local", "w1", "next");
      seq.push(shownTab(s, "@local", "w1")?.id);
    }
    assert.deepEqual(seq, ["a", "b", "c", undefined]);
    s = cycle(s, "@local", "w1", "prev");
    assert.equal(shownTab(s, "@local", "w1")?.id, "c");
    // タブの無いワークスペースでは何もしない
    assert.equal(cycle(s, "@local", "w9", "next"), s);
    // ほかのワークスペースの表示は変えない
    assert.equal(shownTab(s, "@local", "w2"), undefined);
  });

  it("出しているタブを閉じたら、次（無ければ前、それも無ければグリッド）を出す", () => {
    let s = showTab(three(), "@local", "w1", "b");
    s = closeTab(s, "b");
    assert.equal(shownTab(s, "@local", "w1")?.id, "c");
    s = closeTab(s, "c");
    assert.equal(shownTab(s, "@local", "w1")?.id, "a");
    s = closeTab(s, "a");
    assert.equal(shownTab(s, "@local", "w1"), undefined);
    assert.deepEqual(
      s.tabs.map((t) => t.id),
      ["d"],
    );
    // 出していないタブを閉じても、表示は変えない
    let t = showTab(three(), "@local", "w1", "a");
    t = closeTab(t, "c");
    assert.equal(shownTab(t, "@local", "w1")?.id, "a");
    assert.equal(closeTab(t, "nope"), t);
  });

  it("ほかのワークスペースのタブは出さない", () => {
    const s = three();
    assert.equal(showTab(s, "@local", "w1", "d"), s);
  });

  it("並びを畳む・開く", () => {
    let s = toggleFold(three(), "@local", "w1");
    assert.equal(isFolded(s, "@local", "w1"), true);
    assert.equal(isFolded(s, "@local", "w2"), false);
    s = toggleFold(s, "@local", "w1");
    assert.equal(isFolded(s, "@local", "w1"), false);
  });

  it("URL と題を書き換える。変わらなければ同じものを返す", () => {
    const s = three();
    const t = updateTab(s, "a", { url: "https://x.example/", title: "X" });
    assert.equal(t.tabs[0].url, "https://x.example/");
    assert.equal(t.tabs[0].title, "X");
    assert.equal(updateTab(t, "a", { title: "X" }), t);
    assert.equal(updateTab(t, "nope", { title: "Y" }), t);
  });

  it("閉じたワークスペースのタブ・表示・畳みを捨てる。ほかのマシンのものは残す", () => {
    let s = addTab(three(), tab("e", "w1", "dev"));
    s = toggleFold(s, "@local", "w2");
    s = toggleFold(s, "dev", "w1");
    s = showTab(s, "@local", "w2", "d");
    const p = pruneWorkspaces(s, "@local", ["w1"]);
    assert.deepEqual(
      p.tabs.map((t) => t.id),
      ["a", "b", "c", "e"],
    );
    assert.equal(shownTab(p, "@local", "w2"), undefined);
    assert.equal(isFolded(p, "@local", "w2"), false);
    assert.equal(isFolded(p, "dev", "w1"), true);
    assert.equal(shownTab(p, "dev", "w1")?.id, "e");
    // 何も捨てなければ同じもの
    assert.equal(pruneWorkspaces(p, "@local", ["w1", "w2"]), p);
  });

  it("覚える形に直して戻すと、タブと畳みが戻る。表示はグリッドから始める", () => {
    let s = toggleFold(three(), "@local", "w2");
    s = showTab(s, "@local", "w1", "a");
    const back = fromStored(JSON.parse(JSON.stringify(toStored(s))));
    assert.deepEqual(back.tabs, s.tabs);
    assert.deepEqual(back.collapsed, s.collapsed);
    assert.deepEqual(back.views, {});
  });

  it("覚えていたものの、形の違うもの・重なり・使えない id は捨てる", () => {
    const got = fromStored({
      tabs: [
        { id: "a", target: "@local", workspace: "w", url: "https://a/" },
        { id: "a", target: "@local", workspace: "w", url: "https://b/" },
        { id: "bad id", target: "@local", workspace: "w", url: "https://c/" },
        { id: "n", target: 1, workspace: "w", url: "https://d/" },
        "x",
      ],
      collapsed: [{ target: "@local", workspace: "w" }, { target: 1 }],
    });
    assert.deepEqual(
      got.tabs.map((t) => [t.id, t.url, t.title]),
      [["a", "https://a/", ""]],
    );
    assert.deepEqual(got.collapsed, [JSON.stringify(["@local", "w"])]);
    assert.deepEqual(fromStored(null), EMPTY_TABS);
    assert.deepEqual(fromStored({ tabs: "x" }).tabs, []);
  });

  it("シークレットのタブは覚えない（#204）", () => {
    let s = addTab(EMPTY_TABS, tab("a"));
    s = addTab(s, { ...tab("b"), incognito: true });
    s = addTab(s, { ...tab("c"), opener: "b", incognito: true, made: true });
    assert.deepEqual(
      toStored(s).tabs.map((t) => t.id),
      ["a"],
    );
    // 覚える形に、シークレット・開いた元・作ってあるかは入れない
    assert.deepEqual(Object.keys(toStored(s).tabs[0]).sort(), [
      "id",
      "target",
      "title",
      "url",
      "workspace",
    ]);
  });

  it("ページが自分を閉じたら、開いた元のタブに戻る（#204）", () => {
    let s = three();
    s = addTab(s, { ...tab("p"), opener: "a" });
    s = closeTab(s, "p", "a");
    assert.equal(shownTab(s, "@local", "w1")?.id, "a");
    // 元のタブがもう無い・ほかのワークスペースなら、ふつうに閉じたときと同じ
    s = addTab(three(), tab("p"));
    s = closeTab(s, "p", "gone");
    assert.equal(shownTab(s, "@local", "w1")?.id, "c");
    s = addTab(three(), tab("p"));
    s = closeTab(s, "p", "d");
    assert.equal(shownTab(s, "@local", "w1")?.id, "c");
    // 出していないタブを閉じても、出すものは変わらない
    s = showTab(addTab(three(), tab("p")), "@local", "w1", "b");
    s = closeTab(s, "p", "a");
    assert.equal(shownTab(s, "@local", "w1")?.id, "b");
  });

  it("新しいタブの id は、殻のラベルに使える形", () => {
    for (let i = 0; i < 20; i++) assert.ok(validTabId(newTabId()));
    assert.equal(
      newTabId(() => 0),
      "t000000000000",
    );
    assert.equal(validTabId("a/b"), false);
    assert.equal(validTabId(""), false);
  });
});

describe("URL の入力欄", () => {
  it("scheme を省くと https。localhost などは http", () => {
    assert.equal(normalizeUrl("example.com"), "https://example.com/");
    assert.equal(
      normalizeUrl("  github.com/mm1995tk?q=1 "),
      "https://github.com/mm1995tk?q=1",
    );
    assert.equal(normalizeUrl("localhost:3000"), "http://localhost:3000/");
    assert.equal(normalizeUrl("127.0.0.1:8080/x"), "http://127.0.0.1:8080/x");
    assert.equal(normalizeUrl("[::1]:5173"), "http://[::1]:5173/");
    assert.equal(normalizeUrl("localhost"), "http://localhost/");
    // localhost で始まるだけの名前は https
    assert.equal(
      normalizeUrl("localhost.example.com"),
      "https://localhost.example.com/",
    );
    assert.equal(normalizeUrl("http://a.example/"), "http://a.example/");
    assert.equal(normalizeUrl("HTTPS://A.example"), "https://a.example/");
  });

  it("http と https 以外、host の無いもの、ユーザー名とパスワード入り、空白入りは開かない", () => {
    for (const bad of [
      "",
      "   ",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,hi",
      "tauri://localhost/",
      "kisui-key://key?n=x",
      "ftp://a.example/",
      "https://user:pw@a.example/",
      "user@a.example",
      "a b.example",
      "https://a.example/\nx",
    ])
      assert.equal(normalizeUrl(bad), null, JSON.stringify(bad));
  });
});
