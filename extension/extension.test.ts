// 拡張機能（extension/）のテスト。npm run test:extension で回す。
// lib.js・background.js・page.js はブラウザの大域のスクリプトなので、vm の中で読む。background.js にはブラウザの API の偽物を、page.js にはページの navigator の偽物を渡す。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import vm from "node:vm";
// @ts-ignore 型の無い Node のスクリプト
import { build, zip } from "./build.mjs";

const dir = import.meta.dirname;
const read = (p: string) => readFileSync(join(dir, p), "utf8");

function loadLib(): any {
  const ctx: any = { URL };
  vm.createContext(ctx);
  vm.runInContext(read("lib.js"), ctx);
  return vm.runInContext("KisuiPasskey", ctx);
}

const K = loadLib();

test("hostOf は http(s) の host だけを小文字で返す", () => {
  assert.equal(K.hostOf("https://GitHub.com/login"), "github.com");
  assert.equal(K.hostOf("http://localhost:3000/"), "localhost");
  assert.equal(K.hostOf("about:blank"), null);
  assert.equal(K.hostOf("about:newtab"), null);
  assert.equal(K.hostOf("not a url"), null);
});

test("combine は両方の受け口の答えをまとめ、待っているサイトに答えた受け口を覚える", () => {
  const r = K.combine([
    {
      host: "a",
      reply: { type: "sites", version: 1, sites: ["github.com"], waiting: [] },
    },
    {
      host: "b",
      reply: {
        type: "sites",
        version: 1,
        sites: ["github.com", "dash.cloudflare.com"],
        waiting: [
          { site: "github.com", url: "https://github.com/login" },
          // sites に無いサイトの待ちは使わない
          { site: "evil.example", url: "https://evil.example/" },
        ],
      },
    },
    { host: "c", reply: null },
    { host: "d", reply: { type: "error", code: "not-running" } },
  ]);
  assert.deepEqual([...r.sites], ["dash.cloudflare.com", "github.com"]);
  assert.deepEqual(
    { ...r.waiting.get("github.com") },
    { host: "b", url: "https://github.com/login" },
  );
  assert.equal(r.waiting.has("evil.example"), false);
});

test("matchPatterns は https のそのサイトだけ。.google.com はサブドメインも", () => {
  assert.deepEqual(
    [...K.matchPatterns(["github.com", ".google.com"])],
    ["https://github.com/*", "https://*.google.com/*"],
  );
});

test("inSite と siteOf は kisui-terminal の passkey.rs と同じ決まり", () => {
  assert.equal(K.inSite("github.com", "github.com"), true);
  assert.equal(K.inSite("gist.github.com", "github.com"), false);
  assert.equal(K.inSite("google.com", ".google.com"), true);
  assert.equal(K.inSite("myaccount.google.com", ".google.com"), true);
  assert.equal(K.inSite("a.b.google.com", ".google.com"), true);
  assert.equal(K.inSite("evilgoogle.com", ".google.com"), false);
  assert.equal(K.inSite("google.com.evil.example", ".google.com"), false);
  const sites = [".google.com", ".mail.google.com", "accounts.google.com"];
  // host と完全に同じもの、次に細かいもの
  assert.equal(K.siteOf("accounts.google.com", sites), "accounts.google.com");
  assert.equal(K.siteOf("x.mail.google.com", sites), ".mail.google.com");
  assert.equal(K.siteOf("myaccount.google.com", sites), ".google.com");
  assert.equal(K.siteOf("example.com", sites), null);
  assert.equal(K.siteOf(null, sites), null);
});

test("waitingSiteOf は当たる項目のうち待っているものを選ぶ（2 つの版の passkey_sites が違うとき）", () => {
  // 普通の版が .google.com で待ち、nightly 版の設定に accounts.google.com がある
  const sites = [".google.com", "accounts.google.com"];
  const waiting = new Map([
    [".google.com", { host: "h", url: "https://accounts.google.com/" }],
  ]);
  assert.equal(K.siteOf("accounts.google.com", sites), "accounts.google.com");
  assert.equal(
    K.waitingSiteOf("accounts.google.com", sites, waiting),
    ".google.com",
  );
  assert.equal(K.waitingSiteOf("example.com", sites, waiting), null);
  assert.equal(K.waitingSiteOf("accounts.google.com", sites, new Map()), null);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        K.openedByKisui({
          url: "https://accounts.google.com/v3/signin",
          createdAt: 0,
          now: 1000,
          sites,
          waiting,
        }),
      ),
    ),
    { site: ".google.com", host: "h", url: "https://accounts.google.com/" },
  );
});

test("appliesTo は kisui-terminal が受けるのと同じ決まり", () => {
  const site = "dash.cloudflare.com";
  assert.equal(
    K.appliesTo({ domain: "dash.cloudflare.com", hostOnly: true }, site),
    true,
  );
  assert.equal(
    K.appliesTo({ domain: ".cloudflare.com", hostOnly: false }, site),
    true,
  );
  // 上のドメインでも host だけのものは送られない
  assert.equal(
    K.appliesTo({ domain: "cloudflare.com", hostOnly: true }, site),
    false,
  );
  // 下のドメイン・ほかのサイト・TLD だけ
  assert.equal(
    K.appliesTo({ domain: "x.dash.cloudflare.com", hostOnly: true }, site),
    false,
  );
  assert.equal(
    K.appliesTo({ domain: "example.com", hostOnly: false }, site),
    false,
  );
  assert.equal(K.appliesTo({ domain: ".com", hostOnly: false }, site), false);
  // .google.com の書き方は、google.com とその下のドメインのもの
  const g = ".google.com";
  assert.equal(
    K.appliesTo({ domain: ".google.com", hostOnly: false }, g),
    true,
  );
  assert.equal(K.appliesTo({ domain: "google.com", hostOnly: true }, g), true);
  assert.equal(
    K.appliesTo({ domain: "myaccount.google.com", hostOnly: true }, g),
    true,
  );
  assert.equal(
    K.appliesTo({ domain: "evilgoogle.com", hostOnly: true }, g),
    false,
  );
  assert.equal(K.appliesTo({ domain: ".com", hostOnly: false }, g), false);
});

test("pickCookies はサイトに送られるものを、重ねずに取り決めの形にする", () => {
  const out = K.pickCookies(
    [
      {
        name: "user_session",
        value: "v",
        domain: "github.com",
        hostOnly: true,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        session: false,
        expirationDate: 1790000000.5,
        storeId: "0",
      },
      // url と domain の両方で読むと同じものが 2 回来る
      {
        name: "user_session",
        value: "v",
        domain: "github.com",
        hostOnly: true,
        path: "/",
      },
      {
        name: "_gh_sess",
        value: "s",
        domain: "gist.github.com",
        hostOnly: true,
        path: "/",
      },
      {
        name: "_octo",
        value: "o",
        domain: ".github.com",
        hostOnly: false,
        path: "/",
        session: true,
      },
    ],
    "github.com",
  );
  assert.equal(out.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(out[0])), {
    name: "user_session",
    value: "v",
    domain: "github.com",
    hostOnly: true,
    path: "/",
    secure: true,
    httpOnly: true,
    session: false,
    sameSite: "lax",
    expirationDate: 1790000000.5,
  });
  assert.equal(out[1].name, "_octo");
});

test("pickCookies は上限で切る", () => {
  const many = Array.from({ length: 1500 }, (_, i) => ({
    name: `c${i}`,
    value: "v",
    domain: "github.com",
    hostOnly: true,
    path: "/",
  }));
  assert.equal(K.pickCookies(many, "github.com").length, K.MAX_COOKIES);
});

test("settled は読み込みが済み、Cookie が止まってから", () => {
  const s = { successAt: 1000, lastCookieChange: 0, tabComplete: true };
  // パスキーの直後は待つ
  assert.equal(K.settled({ ...s, now: 1000 + K.SETTLE_MIN_MS - 1 }), false);
  assert.equal(K.settled({ ...s, now: 1000 + K.SETTLE_MIN_MS }), true);
  // 読み込み中は待つ
  assert.equal(
    K.settled({ ...s, tabComplete: false, now: 1000 + K.SETTLE_MIN_MS }),
    false,
  );
  // Cookie が変わったばかりなら待つ
  const changed = { ...s, lastCookieChange: 2500 };
  assert.equal(
    K.settled({ ...changed, now: 2500 + K.SETTLE_QUIET_MS - 1 }),
    false,
  );
  assert.equal(K.settled({ ...changed, now: 2500 + K.SETTLE_QUIET_MS }), true);
  // 長く落ち着かなくても、上限で送る
  assert.equal(
    K.settled({
      ...s,
      tabComplete: false,
      lastCookieChange: 1e12,
      now: 1000 + K.SETTLE_MAX_MS,
    }),
    true,
  );
});

test("openedByKisui はできたばかりのタブが待っているサイトを開いたときだけ", () => {
  const waiting = new Map([
    ["github.com", { host: "h", url: "https://github.com/login" }],
  ]);
  const base = { createdAt: 0, sites: ["github.com"], waiting };
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        K.openedByKisui({
          ...base,
          url: "https://github.com/session",
          now: 1000,
        }),
      ),
    ),
    { site: "github.com", host: "h", url: "https://github.com/login" },
  );
  assert.equal(
    K.openedByKisui({ ...base, url: "https://gist.github.com/", now: 1000 }),
    null,
  );
  assert.equal(
    K.openedByKisui({
      ...base,
      url: "https://github.com/",
      now: K.NEW_TAB_MS + 1,
    }),
    null,
  );
});

test("loginLike はログインの途中らしいページを見分ける（#438）", () => {
  for (const url of [
    "https://github.com/login",
    "https://github.com/login?return_to=%2Fsettings",
    "https://github.com/session",
    "https://github.com/sessions/two-factor/app",
    "https://github.com/sessions/verified-device",
    "https://accounts.google.com/v3/signin/challenge/totp",
    "https://accounts.google.com/CheckCookie",
    "https://dash.cloudflare.com/two-factor",
    "https://example.com/u/mfa-otp-challenge",
    "https://example.com/oauth/authorize",
    "not a url",
  ])
    assert.equal(K.loginLike(url), true, url);
  for (const url of [
    "https://github.com/",
    "https://github.com/settings/profile",
    "https://github.com/mm1995tk/kisui-terminal",
    "https://myaccount.google.com/",
    "https://mail.google.com/mail/u/0/",
    "https://dash.cloudflare.com/0123abcd/home",
  ])
    assert.equal(K.loginLike(url), false, url);
});

test("landing は、ログインを終えて着いたらしいページだけを landed にする（#438）", () => {
  const p = {
    openedUrl: "https://github.com/login",
    site: "github.com",
    passedLogin: false,
  };
  assert.equal(K.landing({ ...p, url: "https://github.com/" }), "landed");
  assert.equal(K.landing({ ...p, url: "https://github.com/login" }), "login");
  assert.equal(
    K.landing({ ...p, url: "https://github.com/sessions/two-factor/app" }),
    "login",
  );
  assert.equal(K.landing({ ...p, url: "https://gist.github.com/" }), "outside");
  assert.equal(K.landing({ ...p, url: "https://example.com/" }), "outside");
  // 開いた URL のまま（リーダーの `o s` で開いたページ）は送らない。ログインのページを通って戻ってきたら送る
  const os = { ...p, openedUrl: "https://github.com/settings" };
  assert.equal(
    K.landing({ ...os, url: "https://github.com/settings#x" }),
    "opened",
  );
  assert.equal(
    K.landing({ ...os, url: "https://github.com/settings", passedLogin: true }),
    "landed",
  );
  // .google.com で待っていれば、myaccount.google.com に着いたら送る
  assert.equal(
    K.landing({
      url: "https://myaccount.google.com/",
      openedUrl: "https://accounts.google.com/v3/signin/identifier",
      site: ".google.com",
      passedLogin: true,
    }),
    "landed",
  );
});

test("sameUrl は # の後ろを見ない", () => {
  assert.equal(
    K.sameUrl("https://github.com/login#x", "https://GITHUB.com/login"),
    true,
  );
  assert.equal(
    K.sameUrl("https://github.com/login", "https://github.com/session"),
    false,
  );
});

// ---- background.js をブラウザの API の偽物で動かす

function event() {
  const fns: Function[] = [];
  return {
    addListener: (f: Function) => fns.push(f),
    fire: (...a: any[]) => fns.map((f) => f(...a)),
  };
}

function fakeBrowser(opts: {
  sites: string[];
  waiting: { site: string; url: string }[];
  // ブラウザにある Cookie（省くと github.com などのもの）
  cookies?: any[];
  // kisui-terminal が動いていない（どの受け口も答えない）
  down?: boolean;
}) {
  let clock = 1_000_000;
  const session: Record<string, any> = {};
  const native: { host: string; message: any }[] = [];
  const removed: number[] = [];
  const badges: any[] = [];
  const tabs = new Map<number, any>();
  const registered: any[] = [];
  const injected: any[] = [];
  const allCookies = opts.cookies ?? [
    {
      name: "user_session",
      value: "v",
      domain: "github.com",
      hostOnly: true,
      path: "/",
      httpOnly: true,
    },
    {
      name: "_gh_sess",
      value: "s",
      domain: "gist.github.com",
      hostOnly: true,
      path: "/",
    },
    {
      name: "other",
      value: "o",
      domain: "example.com",
      hostOnly: true,
      path: "/",
    },
  ];
  const cookieQueries: any[] = [];
  const ev = {
    created: event(),
    updated: event(),
    removedTab: event(),
    cookie: event(),
    message: event(),
    action: event(),
    startup: event(),
    installed: event(),
  };
  const api = {
    storage: {
      session: {
        get: async (keys: string[]) =>
          Object.fromEntries(
            keys.filter((k) => k in session).map((k) => [k, session[k]]),
          ),
        set: async (p: any) => Object.assign(session, structuredClone(p)),
        remove: async (k: string) => {
          delete session[k];
        },
      },
    },
    runtime: {
      sendNativeMessage: async (host: string, message: any) => {
        native.push({ host, message });
        if (opts.down || host !== "dev.mm1995tk.kisui_terminal")
          throw new Error("not found");
        if (message.type === "sites")
          return {
            type: "sites",
            version: 2,
            sites: opts.sites,
            waiting: opts.waiting,
          };
        if (message.type === "cookies")
          return { type: "done", accepted: message.cookies.length, dropped: 0 };
        return { type: "error", code: "bad-request" };
      },
      onMessage: ev.message,
      onStartup: ev.startup,
      onInstalled: ev.installed,
    },
    scripting: {
      getRegisteredContentScripts: async () => registered,
      unregisterContentScripts: async () => {
        registered.length = 0;
      },
      registerContentScripts: async (s: any[]) => registered.push(...s),
      executeScript: async (d: any) => injected.push(d),
    },
    tabs: {
      onCreated: ev.created,
      onUpdated: ev.updated,
      onRemoved: ev.removedTab,
      get: async (id: number) => {
        if (!tabs.has(id)) throw new Error("no tab");
        return tabs.get(id);
      },
      query: async () => [...tabs.values()],
      remove: async (id: number) => {
        removed.push(id);
        tabs.delete(id);
      },
    },
    cookies: {
      onChanged: ev.cookie,
      getAllCookieStores: async () => [{ id: "0", tabIds: [...tabs.keys()] }],
      getAll: async (d: any) => {
        cookieQueries.push(d);
        if (d.url)
          return allCookies.filter((c) => K.appliesTo(c, K.hostOf(d.url)));
        return allCookies.filter(
          (c) => c.domain === d.domain || c.domain.endsWith(`.${d.domain}`),
        );
      },
    },
    permissions: { request: async () => true, contains: async () => true },
    action: {
      onClicked: ev.action,
      setBadgeText: async (b: any) => badges.push(b),
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
    i18n: { getMessage: (k: string) => k },
  };
  class FakeDate extends Date {
    static now() {
      return clock;
    }
  }
  const ctx: any = {
    browser: api,
    URL,
    Date: FakeDate,
    console,
    structuredClone,
    // 待つたびに時計を進める
    setTimeout: (f: Function, ms: number) => {
      clock += ms;
      queueMicrotask(() => f());
    },
  };
  vm.createContext(ctx);
  vm.runInContext(read("lib.js"), ctx);
  vm.runInContext(read("background.js"), ctx);
  return {
    ev,
    tabs,
    native,
    removed,
    badges,
    registered,
    injected,
    cookieQueries,
    session,
    advance: (ms: number) => (clock += ms),
  };
}

const flush = () => new Promise((r) => setImmediate(r));
async function settle() {
  for (let i = 0; i < 200; i++) await flush();
}

const GH = {
  sites: ["github.com"],
  waiting: [{ site: "github.com", url: "https://github.com/login" }],
};

test("入れたとき、許可サイトにだけページのスクリプトを入れる", async () => {
  const b = fakeBrowser(GH);
  b.ev.installed.fire();
  await settle();
  assert.deepEqual(
    b.registered.map((s) => [s.id, s.world ?? "ISOLATED", [...s.matches]]),
    [
      ["kisui-page", "MAIN", ["https://github.com/*"]],
      ["kisui-relay", "ISOLATED", ["https://github.com/*"]],
    ],
  );
});

test("kisui-terminal が開いたタブでパスキーが通ると、Cookie を送ってタブを閉じる", async () => {
  const b = fakeBrowser(GH);
  const tab = { id: 7, url: "https://github.com/login", status: "complete" };
  b.tabs.set(7, tab);
  b.ev.created.fire({ id: 7, url: "https://github.com/login" });
  await settle();
  b.ev.message.fire(
    { type: "passkey-success" },
    { tab, url: "https://github.com/login" },
  );
  await settle();
  const sent = b.native.filter((n) => n.message.type === "cookies");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].host, "dev.mm1995tk.kisui_terminal");
  assert.equal(sent[0].message.site, "github.com");
  // ログインを終えたページの URL も送る（kisui-terminal はそれを開き直す。#276）
  assert.equal(sent[0].message.url, "https://github.com/login");
  // 送るのはサイトのものだけ
  assert.deepEqual(
    [...sent[0].message.cookies.map((c: any) => c.name)],
    ["user_session"],
  );
  // 読むのは github.com の URL とドメインだけ
  for (const q of b.cookieQueries) {
    assert.ok(
      q.url === "https://github.com/" || q.domain === "github.com",
      JSON.stringify(q),
    );
  }
  assert.deepEqual(b.removed, [7]);
});

test("タブを覚えるのと、別のタブが閉じるのが重なっても、覚えたタブは消えない", async () => {
  const b = fakeBrowser(GH);
  const tab = { id: 30, url: "https://github.com/login", status: "complete" };
  b.tabs.set(30, tab);
  b.ev.created.fire({ id: 30, url: tab.url });
  b.ev.removedTab.fire(31);
  await settle();
  assert.deepEqual(
    { ...b.session["tracked:30"] },
    {
      site: "github.com",
      host: "dev.mm1995tk.kisui_terminal",
      url: "https://github.com/login",
      // ログインのページを開いたので、ログインの途中らしいページを通ったと覚える
      passedLogin: true,
    },
  );
});

test("ブラウザを起動したとき、待っている URL を開いているタブを覚える", async () => {
  const b = fakeBrowser(GH);
  b.tabs.set(40, { id: 40, url: "https://github.com/login" });
  b.tabs.set(41, { id: 41, url: "https://github.com/" });
  b.ev.startup.fire();
  await settle();
  assert.ok(b.session["tracked:40"]);
  assert.equal(b.session["tracked:41"], undefined);
});

test("覚えたタブが別の host にリダイレクトしていたら、スクリプトを入れない", async () => {
  const b = fakeBrowser(GH);
  b.tabs.set(60, {
    id: 60,
    url: "https://sso.example.com/",
    status: "complete",
  });
  b.ev.created.fire({ id: 60, url: "https://github.com/login" });
  await settle();
  assert.ok(b.session["tracked:60"]);
  assert.equal(b.injected.length, 0);
});

test("覚えた後に待ちが終わったサイトの Cookie は、パスキーが通っても読まない", async () => {
  const opts = { ...GH };
  const b = fakeBrowser(opts);
  const tab = { id: 50, url: "https://github.com/login", status: "complete" };
  b.tabs.set(50, tab);
  b.ev.created.fire({ id: 50, url: tab.url });
  await settle();
  assert.ok(b.session["tracked:50"]);
  opts.waiting = [];
  b.ev.message.fire({ type: "passkey-success" }, { tab, url: tab.url });
  await settle();
  assert.equal(b.cookieQueries.length, 0);
  assert.deepEqual(b.removed, []);
  assert.equal(b.badges.at(-1).text, "!");
});

test("kisui-terminal が開いていないタブの知らせは使わない", async () => {
  const b = fakeBrowser(GH);
  const tab = { id: 8, url: "https://github.com/login", status: "complete" };
  b.tabs.set(8, tab);
  // 前からあるタブ（onCreated が来ていない）
  b.ev.message.fire({ type: "passkey-success" }, { tab, url: tab.url });
  await settle();
  assert.equal(b.native.filter((n) => n.message.type === "cookies").length, 0);
  assert.deepEqual(b.removed, []);
});

test("kisui-terminal が答えないときも、聞いてから 1 分は新しいタブで聞き直さない", async () => {
  const b = fakeBrowser({ ...GH, down: true });
  for (const id of [20, 21]) {
    b.ev.created.fire({ id, url: "https://example.com/" });
    await settle();
  }
  // 1 つ目のタブで 2 つの受け口に 1 回ずつ聞き、2 つ目では聞かない
  assert.equal(b.native.length, 2);
  b.advance(60 * 1000);
  b.ev.created.fire({ id: 22, url: "https://example.com/" });
  await settle();
  assert.equal(b.native.length, 4);
});

test("待っていないサイトのタブは覚えない", async () => {
  const b = fakeBrowser({ sites: ["github.com"], waiting: [] });
  const tab = { id: 9, url: "https://github.com/", status: "complete" };
  b.tabs.set(9, tab);
  b.ev.created.fire({ id: 9, url: tab.url });
  await settle();
  b.ev.message.fire({ type: "passkey-success" }, { tab, url: tab.url });
  await settle();
  assert.equal(b.native.filter((n) => n.message.type === "cookies").length, 0);
});

test("手で戻るボタンは、待っているサイトの Cookie を送ってタブを閉じる", async () => {
  const b = fakeBrowser(GH);
  const tab = {
    id: 10,
    url: "https://github.com/settings",
    status: "complete",
  };
  b.tabs.set(10, tab);
  b.ev.action.fire(tab);
  await settle();
  assert.equal(b.native.filter((n) => n.message.type === "cookies").length, 1);
  assert.deepEqual(b.removed, [10]);
});

test("手で戻るボタンは、許可していないサイトの Cookie を読まない", async () => {
  const b = fakeBrowser(GH);
  const tab = { id: 11, url: "https://example.com/", status: "complete" };
  b.tabs.set(11, tab);
  b.ev.action.fire(tab);
  await settle();
  assert.equal(b.cookieQueries.length, 0);
  assert.equal(b.native.filter((n) => n.message.type === "cookies").length, 0);
  assert.deepEqual(b.removed, []);
  assert.equal(b.badges.at(-1).text, "!");
});

// ---- URL が変わったら送る（#438。Firefox でログイン済みのとき・パスワードでログインしたとき）

function go(b: any, tab: any, url: string) {
  tab.url = url;
  b.ev.updated.fire(tab.id, { url });
}
const sentCookies = (b: any) =>
  b.native.filter((n: any) => n.message.type === "cookies");

test("Firefox でログイン済みで、ログインのページがすぐ移ったら、ボタンを押さずに送る", async () => {
  const b = fakeBrowser(GH);
  // kisui-terminal は github.com/login を開いたが、ログイン済みなので github.com/ にリダイレクトした
  const tab = { id: 80, url: "https://github.com/", status: "complete" };
  b.tabs.set(80, tab);
  b.ev.created.fire({ id: 80 });
  b.ev.updated.fire(80, { url: tab.url });
  await settle();
  const sent = sentCookies(b);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.site, "github.com");
  assert.equal(sent[0].message.url, "https://github.com/");
  assert.deepEqual(
    [...sent[0].message.cookies.map((c: any) => c.name)],
    ["user_session"],
  );
  assert.deepEqual(b.removed, [80]);
});

test("パスワードでログインすると、2 段階認証の途中では送らず、済んでから送る", async () => {
  const b = fakeBrowser(GH);
  const tab = { id: 81, url: "https://github.com/login", status: "complete" };
  b.tabs.set(81, tab);
  b.ev.created.fire({ id: 81, url: tab.url });
  await settle();
  go(b, tab, "https://github.com/session");
  await settle();
  go(b, tab, "https://github.com/sessions/two-factor/app");
  await settle();
  assert.equal(sentCookies(b).length, 0);
  assert.deepEqual(b.removed, []);
  go(b, tab, "https://github.com/");
  await settle();
  assert.equal(sentCookies(b).length, 1);
  assert.equal(sentCookies(b)[0].message.url, "https://github.com/");
  assert.deepEqual(b.removed, [81]);
});

test("着いたらしいページから、落ち着く前に 2 段階認証のページへ移ったら送らない", async () => {
  const b = fakeBrowser(GH);
  const tab = { id: 82, url: "https://github.com/login", status: "complete" };
  b.tabs.set(82, tab);
  b.ev.created.fire({ id: 82, url: tab.url });
  await settle();
  go(b, tab, "https://github.com/dashboard");
  go(b, tab, "https://github.com/sessions/two-factor/app");
  await settle();
  assert.equal(sentCookies(b).length, 0);
  assert.deepEqual(b.removed, []);
});

test("待っていないサイトに移ったら送らない", async () => {
  const b = fakeBrowser(GH);
  const tab = { id: 83, url: "https://github.com/login", status: "complete" };
  b.tabs.set(83, tab);
  b.ev.created.fire({ id: 83, url: tab.url });
  await settle();
  go(b, tab, "https://example.com/");
  await settle();
  go(b, tab, "https://gist.github.com/");
  await settle();
  assert.equal(b.cookieQueries.length, 0);
  assert.equal(sentCookies(b).length, 0);
  assert.deepEqual(b.removed, []);
});

test("開いた URL のままなら送らず、ログインのページを通って戻ってきたら送る（リーダーの o s）", async () => {
  const b = fakeBrowser({
    sites: ["github.com"],
    waiting: [{ site: "github.com", url: "https://github.com/settings" }],
  });
  const tab = {
    id: 84,
    url: "https://github.com/settings",
    status: "complete",
  };
  b.tabs.set(84, tab);
  b.ev.created.fire({ id: 84, url: tab.url });
  await settle();
  assert.equal(sentCookies(b).length, 0);
  go(b, tab, "https://github.com/login?return_to=%2Fsettings");
  await settle();
  go(b, tab, "https://github.com/settings");
  await settle();
  assert.equal(sentCookies(b).length, 1);
  assert.deepEqual(b.removed, [84]);
});

test("覚えたのが 0.2.4 までのタブ（開いた URL が無い）は、URL では送らない", async () => {
  const b = fakeBrowser(GH);
  const tab = { id: 85, url: "https://github.com/login", status: "complete" };
  b.tabs.set(85, tab);
  b.session["tracked:85"] = {
    site: "github.com",
    host: "dev.mm1995tk.kisui_terminal",
  };
  go(b, tab, "https://github.com/");
  await settle();
  assert.equal(sentCookies(b).length, 0);
});

// .google.com の書き方（#279）。ログインの後に別のサブドメインへ移っても送れる
const GOOGLE = {
  sites: [".google.com"],
  waiting: [
    { site: ".google.com", url: "https://accounts.google.com/v3/signin" },
  ],
  cookies: [
    {
      name: "SID",
      value: "s",
      domain: ".google.com",
      hostOnly: false,
      path: "/",
    },
    {
      name: "ACCOUNT",
      value: "a",
      domain: "myaccount.google.com",
      hostOnly: true,
      path: "/",
    },
    {
      name: "MAIL",
      value: "m",
      domain: "mail.google.com",
      hostOnly: true,
      path: "/",
    },
  ],
};

test(".google.com で待っていれば、myaccount.google.com に移っても今のタブの Cookie を送る", async () => {
  const b = fakeBrowser(GOOGLE);
  const tab = {
    id: 70,
    url: "https://accounts.google.com/v3/signin",
    status: "complete",
  };
  b.tabs.set(70, tab);
  b.ev.created.fire({ id: 70, url: tab.url });
  await settle();
  assert.deepEqual(
    { ...b.session["tracked:70"] },
    {
      site: ".google.com",
      host: "dev.mm1995tk.kisui_terminal",
      url: "https://accounts.google.com/v3/signin",
      passedLogin: true,
    },
  );
  b.ev.message.fire({ type: "passkey-success" }, { tab, url: tab.url });
  // ログインが済むと myaccount.google.com に移る
  tab.url = "https://myaccount.google.com/";
  await settle();
  const sent = b.native.filter((n) => n.message.type === "cookies");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.site, ".google.com");
  // 開き直すのは、移った先の myaccount.google.com（#276）
  assert.equal(sent[0].message.url, "https://myaccount.google.com/");
  // 送るのは今のタブのページに送られるもの
  assert.deepEqual(
    [...sent[0].message.cookies.map((c: any) => c.name)].sort(),
    ["ACCOUNT", "SID"],
  );
  assert.deepEqual(b.removed, [70]);
  // スクリプトは google.com とすべてのサブドメインに入れる
  assert.deepEqual([...b.registered[0].matches], ["https://*.google.com/*"]);
});

test(".google.com で待っていれば、手で戻るボタンは myaccount.google.com のタブからも送る", async () => {
  const b = fakeBrowser(GOOGLE);
  const tab = {
    id: 71,
    url: "https://myaccount.google.com/",
    status: "complete",
  };
  b.tabs.set(71, tab);
  b.ev.action.fire(tab);
  await settle();
  const sent = b.native.filter((n) => n.message.type === "cookies");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.site, ".google.com");
  assert.equal(sent[0].message.url, "https://myaccount.google.com/");
  assert.deepEqual(b.removed, [71]);
  // 当たらないサイトでは読まない
  const other = { id: 72, url: "https://evilgoogle.com/", status: "complete" };
  b.tabs.set(72, other);
  const before = b.cookieQueries.length;
  b.ev.action.fire(other);
  await settle();
  assert.equal(b.cookieQueries.length, before);
  assert.equal(b.badges.at(-1).text, "!");
});

// ---- manifest と組み立て

const base = JSON.parse(read("manifest.json"));

// ---- page.js（ページの中で動く）。ページと、パスキーの管理の拡張機能（1Password など）が navigator.credentials を置き換えるのを真似る

// Firefox の Navigator と CredentialsContainer の形（navigator.credentials は Navigator.prototype の getter、get / create は prototype の関数）
function pageWorld() {
  const ctx: any = { events: 0 };
  vm.createContext(ctx);
  vm.runInContext(
    `
    class CredentialsContainer {}
    CredentialsContainer.prototype.get = function (o) {
      return o && o.fail ? Promise.reject(new Error("NotAllowed")) : Promise.resolve({ id: "native" });
    };
    CredentialsContainer.prototype.create = function () { return Promise.resolve({ id: "native" }); };
    const container = new CredentialsContainer();
    class Navigator {}
    Object.defineProperty(Navigator.prototype, "credentials", { get() { return container; }, configurable: true, enumerable: true });
    var navigator = new Navigator();
    class CustomEvent { constructor(type) { this.type = type; } }
    var document = { dispatchEvent(e) { if (e.type === "kisui-terminal-passkey-success") events++; } };
    `,
    ctx,
  );
  return {
    run: (code: string) => vm.runInContext(code, ctx),
    loadPage: () => vm.runInContext(read("page.js"), ctx),
    events: () => ctx.events as number,
  };
}

// パスキーの管理の拡張機能：自分でパスキーを出し、もとの関数を呼ばない
const manager = `(o) => Promise.resolve({ id: "manager" })`;

test("page.js はパスキーが通ったときだけ知らせ、ページから見える値は変えない", async () => {
  const w = pageWorld();
  w.loadPage();
  await w.run(`navigator.credentials.get({ publicKey: {} })`);
  await w.run(`navigator.credentials.create({ publicKey: {} })`);
  await flush();
  assert.equal(w.events(), 2);
  // パスキーでない・断られた
  await w.run(`navigator.credentials.get({ password: true })`);
  await w
    .run(`navigator.credentials.get({ publicKey: {}, fail: true })`)
    .catch(() => {});
  await flush();
  assert.equal(w.events(), 2);
  assert.equal(
    (await w.run(`navigator.credentials.get({ publicKey: {} })`)).id,
    "native",
  );
  assert.equal(
    w.run(`navigator.credentials.get === navigator.credentials.get`),
    true,
  );
  assert.equal(w.run(`navigator.credentials === navigator.credentials`), true);
});

for (const [name, install] of [
  ["代入", `navigator.credentials.get = ${manager};`],
  [
    "入れ物への Object.defineProperty",
    `Object.defineProperty(navigator.credentials, "get", { value: ${manager}, configurable: true, writable: true });`,
  ],
  [
    "CredentialsContainer.prototype の置き換え",
    `Object.getPrototypeOf(navigator.credentials).get = ${manager};`,
  ],
  [
    "Navigator.prototype.credentials の置き換え",
    `{ const own = { get: ${manager}, create: ${manager} };
       Object.defineProperty(Object.getPrototypeOf(navigator), "credentials", { get() { return own; }, configurable: true }); }`,
  ],
]) {
  test(`page.js は、パスキーの管理の拡張機能が先に入っても後から入っても知らせる（${name}）`, async () => {
    for (const order of ["before", "after"]) {
      const w = pageWorld();
      if (order === "before") w.run(install);
      w.loadPage();
      if (order === "after") w.run(install);
      const cred = await w.run(`navigator.credentials.get({ publicKey: {} })`);
      await flush();
      assert.equal(cred.id, "manager", `${name} ${order}`);
      assert.equal(w.events(), 1, `${name} ${order}`);
    }
  });
}

test("page.js は、受け手が入れ物そのものでない呼び方（Object.create・Proxy）も今までどおり動かす", async () => {
  const w = pageWorld();
  w.loadPage();
  const inherited = await w.run(
    `Object.create(navigator.credentials).get({ publicKey: {} })`,
  );
  assert.equal(inherited.id, "native");
  // ほかの拡張機能が代入した後も、Proxy から読むと代入された関数が呼ばれる
  w.run(`navigator.credentials.get = ${manager};`);
  const proxied = await w.run(
    `new Proxy(navigator.credentials, {}).get({ publicKey: {} })`,
  );
  assert.equal(proxied.id, "manager");
  await flush();
  assert.equal(w.events(), 2);
});

test("page.js は、ほかの拡張機能の accessor がこちらの getter を呼び戻しても止まる", async () => {
  const w = pageWorld();
  w.loadPage();
  w.run(`{ const c = navigator.credentials;
           const d = Object.getOwnPropertyDescriptor(c, "get");
           Object.defineProperty(c, "get", {
             get() { const prev = d.get.call(this); return function (o) { return prev.call(this, o); }; },
             configurable: true,
           }); }`);
  const cred = await w.run(`navigator.credentials.get({ publicKey: {} })`);
  await flush();
  assert.equal(cred.id, "native");
  assert.equal(w.events(), 1);
});

test("page.js は、ほかの拡張機能がこちらの包みを呼び戻しても 1 回だけ知らせる", async () => {
  const w = pageWorld();
  w.loadPage();
  w.run(`{ const prev = navigator.credentials.get;
           navigator.credentials.get = function (o) { return prev.call(this, o); }; }`);
  // 2 回入っても同じ
  w.loadPage();
  const cred = await w.run(`navigator.credentials.get({ publicKey: {} })`);
  await flush();
  assert.equal(cred.id, "native");
  assert.equal(w.events(), 1);
});

test("Firefox の id は kisui-terminal の受け口が許すものと同じ", () => {
  const rs = readFileSync(join(dir, "../app/src-tauri/src/passkey.rs"), "utf8");
  const id = rs.match(/FIREFOX_EXTENSION_ID: &str = "([^"]+)"/)![1];
  assert.equal(base.browser_specific_settings.gecko.id, id);
});

test("host の権限は https だけで、頼み直す権限（background.js の ORIGINS）と同じ", () => {
  // http は持たない。Secure の付かない Cookie も https の権限で読める（background.js の ORIGINS の説明）
  assert.deepEqual(base.host_permissions, ["https://*/*"]);
  const origins = read("background.js").match(/const ORIGINS = (\[[^\]]*\]);/);
  assert.ok(origins);
  assert.deepEqual(JSON.parse(origins[1]), base.host_permissions);
});

test("受け口の名前は kisui-terminal のものと同じ", () => {
  assert.deepEqual(
    [...K.HOSTS],
    ["dev.mm1995tk.kisui_terminal", "dev.mm1995tk.kisui_terminal_nightly"],
  );
});

test("manifest は Firefox の形（background は scripts で、lib.js を先に読む）", () => {
  assert.deepEqual(base.background, {
    scripts: ["lib.js", "background.js"],
  });
  assert.equal(base.key, undefined);
});

test("訳は en と ja で同じ鍵を持ち、使う鍵がすべてある", () => {
  const en = JSON.parse(read("_locales/en/messages.json"));
  const ja = JSON.parse(read("_locales/ja/messages.json"));
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ja).sort());
  const used = new Set<string>();
  for (const m of JSON.stringify(base).matchAll(/__MSG_(\w+)__/g))
    used.add(m[1]);
  for (const m of read("background.js").matchAll(
    /(?:getMessage\(|: )"(\w+)"/g,
  )) {
    if (/^(error|action)/.test(m[1])) used.add(m[1]);
  }
  for (const k of used) assert.ok(k in en, k);
  // 名前と短い説明の長さの上限（長すぎるとストアが断る）
  for (const t of [en, ja]) {
    assert.ok([...t.extensionName.message].length <= 75);
    assert.ok(
      [...t.extensionDescription.message].length <= 132,
      t.extensionDescription.message,
    );
  }
});

function unzip(buf: Buffer) {
  const files = new Map<string, Buffer>();
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const size = buf.readUInt32LE(p + 18);
    const nlen = buf.readUInt16LE(p + 26);
    const xlen = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nlen).toString("utf8");
    const start = p + 30 + nlen + xlen;
    files.set(name, inflateRawSync(buf.subarray(start, start + size)));
    p = start + size;
  }
  return files;
}

test("zip は読み戻せる", () => {
  const z = zip([
    { name: "a.txt", data: Buffer.from("hello") },
    { name: "d/b.json", data: Buffer.from("{}") },
  ]);
  const f = unzip(z);
  assert.equal(f.get("a.txt")!.toString(), "hello");
  assert.equal(f.get("d/b.json")!.toString(), "{}");
});

test("build は firefox/ と zip を作り、manifest の指すファイルがそろう", () => {
  const out = mkdtempSync(join(tmpdir(), "kisui-ext-"));
  try {
    const made = build(out);
    const name = `kisui-terminal-firefox-${base.version}.zip`;
    assert.equal(made, join(out, name));
    assert.deepEqual(readdirSync(out).sort(), ["firefox", name]);
    const files = unzip(readFileSync(made));
    const m = JSON.parse(files.get("manifest.json")!.toString());
    assert.deepEqual(m, base);
    const refs = [
      ...Object.values(m.icons as Record<string, string>),
      ...Object.values(m.action.default_icon as Record<string, string>),
      ...m.background.scripts,
      "page.js",
      "relay.js",
      "_locales/en/messages.json",
      "_locales/ja/messages.json",
    ];
    for (const r of refs) {
      assert.ok(files.has(r), r);
      assert.ok(readdirSync(join(out, "firefox", dirname(r))).length > 0, r);
    }
    // zip の中身は extension/ のファイルそのもの
    for (const [f, data] of files)
      assert.deepEqual(data, readFileSync(join(dir, f)), f);
    // 同じソースからは同じ zip
    const again = mkdtempSync(join(tmpdir(), "kisui-ext-"));
    try {
      assert.deepEqual(readFileSync(made), readFileSync(build(again)));
    } finally {
      rmSync(again, { recursive: true, force: true });
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
