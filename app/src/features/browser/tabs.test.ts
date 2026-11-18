import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addTab,
  closeTab,
  EMPTY_TABS,
  fromStored,
  newTabId,
  normalizeUrl,
  urlOrSearch,
  shownTab,
  showTab,
  tabTitle,
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

/** ワークスペース g1 に a・b・c、g2 に d（どれも出していない）。 */
function three(): TabsState {
  let s = EMPTY_TABS;
  for (const [t, g] of [
    [tab("a"), "g1"],
    [tab("b"), "g1"],
    [tab("c"), "g1"],
    [tab("d", "w2"), "g2"],
  ] as const)
    s = addTab(s, t, g);
  return showTab(showTab(s, "g1", null), "g2", null);
}

describe("内蔵ブラウザのタブ", () => {
  it("足したタブをそのワークスペースで出す。ワークスペースが分からなければ、足すだけ", () => {
    const s = addTab(EMPTY_TABS, tab("a"), "g1");
    assert.equal(shownTab(s, "g1")?.id, "a");
    assert.equal(shownTab(s, "g2"), undefined);
    const t = addTab(EMPTY_TABS, tab("b"));
    assert.equal(t.tabs.length, 1);
    assert.deepEqual(t.views, {});
  });

  it("出すものを替える。ターミナルのタブ（null）に戻せる。無いタブは出さない", () => {
    let s = showTab(three(), "g1", "b");
    assert.equal(shownTab(s, "g1")?.id, "b");
    // ほかのワークスペースの表示は変えない
    assert.equal(shownTab(s, "g2"), undefined);
    s = showTab(s, "g1", null);
    assert.equal(shownTab(s, "g1"), undefined);
    assert.equal(showTab(s, "g1", "nope"), s);
    assert.equal(showTab(s, "g1", null), s);
  });

  it("タブを閉じると、そのタブを出していたワークスペースはターミナルのタブに戻る", () => {
    let s = showTab(three(), "g1", "b");
    s = closeTab(s, "b");
    assert.equal(shownTab(s, "g1"), undefined);
    assert.deepEqual(
      s.tabs.map((t) => t.id),
      ["a", "c", "d"],
    );
    // 出していないタブを閉じても、表示は変えない
    let t = showTab(three(), "g1", "a");
    t = closeTab(t, "c");
    assert.equal(shownTab(t, "g1")?.id, "a");
    assert.equal(closeTab(t, "nope"), t);
  });

  it("URL と題を書き換える。変わらなければ同じものを返す", () => {
    const s = three();
    const t = updateTab(s, "a", { url: "https://x.example/", title: "X" });
    assert.equal(t.tabs[0].url, "https://x.example/");
    assert.equal(t.tabs[0].title, "X");
    assert.equal(updateTab(t, "a", { title: "X" }), t);
    assert.equal(updateTab(t, "nope", { title: "Y" }), t);
  });

  it("favicon を書き換え、消す。覚える形には書かない（#237）", () => {
    const icon = "data:image/png;base64,AAAA";
    const t = updateTab(three(), "a", { favicon: icon });
    assert.equal(t.tabs[0].favicon, icon);
    assert.equal(updateTab(t, "a", { favicon: icon }), t);
    assert.equal(
      updateTab(t, "a", { favicon: undefined }).tabs[0].favicon,
      undefined,
    );
    assert.ok(!JSON.stringify(toStored(t)).includes(icon));
  });

  it("タブの名前は、つけた名前、無ければページの題、それも無ければ host", () => {
    const t = { ...tab("a"), title: "Page" };
    assert.equal(tabTitle(t, "Mine"), "Mine");
    assert.equal(tabTitle(t, ""), "Page");
    assert.equal(tabTitle({ ...t, title: "" }), "a.example");
  });

  it("覚える形に直して戻すと、タブが戻る。畳んだ印は殻に書かない。表示はターミナルから始める", () => {
    const s = showTab(three(), "g1", "a");
    const stored = toStored(s);
    assert.deepEqual(stored.collapsed, []);
    const back = fromStored(JSON.parse(JSON.stringify(stored)));
    assert.deepEqual(back.tabs, s.tabs);
    assert.deepEqual(back.views, {});
  });

  it("表示の大きさ（#205）はタブごとに覚え、百分率で書く。元の大きさと選べない値は書かない・読まない", () => {
    let s = updateTab(three(), "a", { zoom: 1.25 });
    s = updateTab(s, "b", { zoom: 0.7 });
    assert.equal(updateTab(s, "a", { zoom: 1.25 }), s);
    const stored = toStored(s);
    assert.equal(stored.tabs[0].zoom, 125);
    assert.equal(stored.tabs[1].zoom, 70);
    assert.ok(!("zoom" in stored.tabs[2]));
    const back = fromStored(JSON.parse(JSON.stringify(stored)));
    assert.deepEqual(
      back.tabs.map((t) => t.zoom),
      [1.25, 0.7, undefined, undefined],
    );
    const odd = fromStored({
      tabs: [
        {
          id: "a",
          target: "@local",
          workspace: "w",
          url: "https://a/",
          zoom: 133,
        },
        {
          id: "b",
          target: "@local",
          workspace: "w",
          url: "https://b/",
          zoom: 100,
        },
        {
          id: "c",
          target: "@local",
          workspace: "w",
          url: "https://c/",
          zoom: "2",
        },
      ],
    });
    assert.deepEqual(
      odd.tabs.map((t) => t.zoom),
      [undefined, undefined, undefined],
    );
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
    });
    assert.deepEqual(
      got.tabs.map((t) => [t.id, t.url, t.title]),
      [["a", "https://a/", ""]],
    );
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

describe("URL バー（#232）：URL か検索語か", () => {
  it("URL は normalizeUrl と同じに開く", () => {
    assert.equal(urlOrSearch("example.com"), "https://example.com/");
    assert.equal(
      urlOrSearch(" github.com/mm1995tk?q=1 "),
      "https://github.com/mm1995tk?q=1",
    );
    assert.equal(urlOrSearch("localhost:3000"), "http://localhost:3000/");
    assert.equal(urlOrSearch("127.0.0.1:8080/x"), "http://127.0.0.1:8080/x");
    assert.equal(urlOrSearch("[::1]:5173"), "http://[::1]:5173/");
    assert.equal(urlOrSearch("localhost"), "http://localhost/");
    assert.equal(urlOrSearch("http://a.example/"), "http://a.example/");
  });

  it("空白を含む・「.」の無い一語・「.」で終わるものは Google で検索する", () => {
    assert.equal(
      urlOrSearch("tauri webview 使い方"),
      "https://www.google.com/search?q=tauri%20webview%20%E4%BD%BF%E3%81%84%E6%96%B9",
    );
    assert.equal(urlOrSearch("foo"), "https://www.google.com/search?q=foo");
    assert.equal(
      urlOrSearch("hello."),
      "https://www.google.com/search?q=hello.",
    );
    assert.equal(
      urlOrSearch("a&b=c"),
      "https://www.google.com/search?q=a%26b%3Dc",
    );
    // 空白があれば、URL に見える語を含んでいても検索
    assert.equal(
      urlOrSearch("example.com foo"),
      "https://www.google.com/search?q=example.com%20foo",
    );
    assert.equal(
      urlOrSearch("user@example.com"),
      "https://www.google.com/search?q=user%40example.com",
    );
  });

  it("最後の「.」の後ろが英字でないもの（1.5）は検索、IPv4 の 4 つ組は URL。長すぎる検索語は切り詰める", () => {
    assert.equal(urlOrSearch("1.5"), "https://www.google.com/search?q=1.5");
    assert.equal(urlOrSearch("192.168.0.1:8080"), "https://192.168.0.1:8080/");
    assert.equal(urlOrSearch("example.dev"), "https://example.dev/");
    const long = urlOrSearch("a ".repeat(3000));
    assert.ok(long?.startsWith("https://www.google.com/search?q="));
    assert.ok(long!.length < 7000);
  });

  it("開けないもの・空は null", () => {
    for (const bad of [
      "",
      "  ",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,hi",
      "https://user:pw@a.example/",
    ])
      assert.equal(urlOrSearch(bad), null, JSON.stringify(bad));
  });
});
