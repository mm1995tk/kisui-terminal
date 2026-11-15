// kisui-terminal の拡張機能の本体。取り決めは docs/passkey-extension.md、作りは docs/browser-extension.md。
//
// 1. kisui-terminal に native messaging で許可サイトの一覧（sites）を聞き、そのサイトのページにだけ page.js と relay.js を入れる。
// 2. kisui-terminal がパスキーのために開いたタブ（できてすぐ、ログインを待っているサイトのページを開いたタブ）を覚える。
// 3. そのタブでパスキーが通ったら（page.js が知らせる）、ページの移動と Cookie の書き換えが落ち着くのを待ち、
//    そのサイトの Cookie を kisui-terminal に送り、タブを閉じる。
// 4. 拡張機能のボタンを押すと、今のタブのサイトの Cookie を、そのサイトを待っている kisui-terminal に送り、タブを閉じる。
//
// Cookie を読むのは、kisui-terminal の答えの sites にあるサイトのものだけ。

if (typeof importScripts === "function") importScripts("lib.js");

/**
 * kisui-terminal が開いたタブ（site は待っている許可サイトの項目（`github.com` か `.google.com`）、host は native messaging の受け口）
 * @typedef {{ site: string, host: string }} Hit
 */
/**
 * タブ。id は、ここで扱うタブ（ウィンドウのあるもの）では必ずある。cookieStoreId は Firefox のもの
 * @typedef {chrome.tabs.Tab & { id: number, cookieStoreId?: string }} Tab
 */
/**
 * パスキーが通ったあと、落ち着くのを待っているタブ
 * @typedef {Hit & { successAt: number, lastCookieChange: number }} Settling
 */

// Chrome の chrome と Firefox の browser は、ここで使う範囲では同じ形（どちらも promise を返す）。型は chrome のものを使う
const api = globalThis.browser ?? globalThis.chrome;
const K = KisuiPasskey;

// 入れるときにもらう権限（manifest.json の host_permissions）
const ORIGINS = ["https://*/*"];
// 許可サイトの一覧を聞き直すまでの長さ
const SITES_TTL_MS = 60 * 1000;
// 落ち着いたかを見る間隔
const SETTLE_POLL_MS = 500;
const SCRIPT_IDS = ["kisui-page", "kisui-relay"];

// ---- 覚えておくもの（service worker が止まっても残るよう storage.session に置く）

async function loadState() {
  /** @type {{ sites?: string[], sitesAt?: number }} */
  const s = await api.storage.session.get(["sites", "sitesAt"]);
  return {
    sites: s.sites ?? [],
    sitesAt: s.sitesAt ?? 0,
  };
}

/** @param {Record<string, unknown>} patch */
async function saveState(patch) {
  await api.storage.session.set(patch);
}

// ---- kisui-terminal とのやり取り

/** @param {string} host @param {object} message @returns {Promise<any>} 信用できない答え（形は使う側が確かめる） */
async function ask(host, message) {
  try {
    return await api.runtime.sendNativeMessage(host, message);
  } catch {
    // その版が入っていない・サイトを書いていない（登録のファイルが無い）
    return null;
  }
}

// 両方の受け口に sites を聞く。どれかが答えたら、覚えている一覧と、ページに入れるスクリプトを合わせる。
// 聞いた時刻は答えが無くても覚え、kisui-terminal が動いていない間に新しいタブのたびに聞き直さないようにする
async function refreshSites() {
  const answers = await Promise.all(
    K.HOSTS.map(async (host) => ({
      host,
      reply: await ask(host, { type: "sites" }),
    })),
  );
  const combined = K.combine(answers);
  const anyReply = answers.some(({ reply }) => K.parseSites(reply));
  if (anyReply) {
    await saveState({ sites: combined.sites, sitesAt: Date.now() });
    await syncScripts(combined.sites);
  } else {
    await saveState({ sitesAt: Date.now() });
  }
  return combined;
}

// ---- 許可サイトのページに入れるスクリプト

/** @param {string[]} sites */
async function syncScripts(sites) {
  const matches = K.matchPatterns(sites);
  /** @type {chrome.scripting.RegisteredContentScript[]} */
  let current = [];
  try {
    current = await api.scripting.getRegisteredContentScripts({
      ids: SCRIPT_IDS,
    });
  } catch {
    current = [];
  }
  const same =
    current.length === SCRIPT_IDS.length &&
    current.every(
      (c) =>
        JSON.stringify([...(c.matches ?? [])].sort()) ===
        JSON.stringify([...matches].sort()),
    );
  if (same) return;
  if (current.length > 0) {
    await api.scripting
      .unregisterContentScripts({ ids: current.map((c) => c.id) })
      .catch(() => {});
  }
  if (matches.length === 0) return;
  try {
    await api.scripting.registerContentScripts([
      {
        id: "kisui-page",
        js: ["page.js"],
        matches,
        runAt: "document_start",
        world: "MAIN",
      },
      { id: "kisui-relay", js: ["relay.js"], matches, runAt: "document_start" },
    ]);
  } catch (e) {
    // 権限が無い（Firefox で入れるときに断った）など。手で戻るボタンは使える
    console.warn("kisui-terminal: could not register content scripts", e);
  }
}

// ---- kisui-terminal が開いたタブを見分ける

// できたばかりで、まだ http(s) のページを開いていないタブ（tabId → できた時刻）。
// タブができてから最初のページまでは短く、その間は service worker が止まらないので、メモリに置く
/** @type {Map<number, number>} */
const newTabs = new Map();

/** @param {Tab} tab */
async function onTabCreated(tab) {
  newTabs.set(tab.id, Date.now());
  const url = tab.pendingUrl || tab.url;
  if (url && K.hostOf(url)) await checkNewTab(tab.id, url);
}

/** @param {number} tabId @param {{ url?: string }} changeInfo */
async function onTabUpdated(tabId, changeInfo) {
  if (changeInfo.url) await checkNewTab(tabId, changeInfo.url);
}

// できたばかりのタブの最初の http(s) のページを見る（見るのは 1 回だけ）
/** @param {number} tabId @param {string} url */
async function checkNewTab(tabId, url) {
  const host = K.hostOf(url);
  if (!host) return;
  const createdAt = newTabs.get(tabId);
  if (createdAt === undefined) return;
  newTabs.delete(tabId);
  const st = await loadState();
  // 許可サイトでなければ聞かない（一覧が古ければ聞き直す）
  if (!K.siteOf(host, st.sites) && Date.now() - st.sitesAt < SITES_TTL_MS)
    return;
  const { sites, waiting } = await refreshSites();
  const hit = K.openedByKisui({
    url,
    createdAt,
    now: Date.now(),
    sites,
    waiting,
  });
  if (hit) await track(tabId, hit);
}

// ブラウザが動いていなかったとき、kisui-terminal はブラウザを URL 付きで起動する。
// そのタブは拡張機能が動き出す前にできているので、待っている URL と同じページを開いているタブを探す
async function checkExistingTabs() {
  const { sites, waiting } = await refreshSites();
  if (waiting.size === 0) return;
  const tabs = await api.tabs.query({});
  for (const tab of tabs) {
    // 起動した直後の Chrome では、url が空で pendingUrl にだけ入っていることがある
    const url = tab.pendingUrl || tab.url || "";
    const site = K.waitingSiteOf(K.hostOf(url), sites, waiting);
    const w = site && waiting.get(site);
    if (site && w && K.sameUrl(url, w.url))
      await track(/** @type {Tab} */ (tab).id, { site, host: w.host });
  }
}

// kisui-terminal が開いたタブ（{ site, host }）は、タブごとの鍵に置く（全体を読んで書き戻すと、
// 覚えるのと別のタブを忘れるのが重なったときに片方が消えるため）
/** @param {number} tabId */
const trackedKey = (tabId) => `tracked:${tabId}`;

/** @param {number} tabId @returns {Promise<Hit | undefined>} */
async function tracked(tabId) {
  const key = trackedKey(tabId);
  /** @type {Record<string, Hit | undefined>} */
  const got = await api.storage.session.get([key]);
  return got[key];
}

// タブを覚え、そのタブの今のページにも page.js と relay.js を入れる。一覧に足したばかりのサイトを初めて開いたときは、
// 登録（syncScripts）がページの読み込みの後になり、そのページには入っていないため（2 回入っても、どちらも 1 回しか動かない）
/** @param {number} tabId @param {Hit} hit */
async function track(tabId, hit) {
  await saveState({ [trackedKey(tabId)]: hit });
  // 入れるのは、今のページがそのサイトのときだけ（聞いている間に別のサイトへリダイレクトしていれば入れない）
  const tab = await api.tabs.get(tabId).catch(() => null);
  if (!tab || !urlInSite(tab.url, hit.site)) return;
  const target = { tabId };
  await api.scripting
    .executeScript({ target, files: ["page.js"], world: "MAIN" })
    .catch(() => {});
  await api.scripting
    .executeScript({ target, files: ["relay.js"] })
    .catch(() => {});
}

/** @param {number} tabId */
async function untrack(tabId) {
  await api.storage.session.remove(trackedKey(tabId));
}

// ページの URL が許可サイトの項目 `site` に当たるか
/** @param {string | undefined} url @param {string} site */
function urlInSite(url, site) {
  const host = K.hostOf(url ?? "");
  return host !== null && K.inSite(host, site);
}

// ---- パスキーが通ったあと、落ち着くのを待つ

// 落ち着くのを待っているタブ（tabId → { site, host, successAt, lastCookieChange }）
/** @type {Map<number, Settling>} */
const settling = new Map();

/** @param {{ cookie: chrome.cookies.Cookie }} change */
function onCookieChanged({ cookie }) {
  for (const s of settling.values()) {
    if (K.appliesTo(cookie, s.site)) s.lastCookieChange = Date.now();
  }
}

/** @param {any} message @param {chrome.runtime.MessageSender} sender */
async function onMessage(message, sender) {
  if (!message || message.type !== "passkey-success" || !sender.tab) return;
  const tabId = /** @type {Tab} */ (sender.tab).id;
  const t = await tracked(tabId);
  if (!t || !urlInSite(sender.url ?? sender.tab.url, t.site)) return;
  if (settling.has(tabId)) {
    /** @type {Settling} */ (settling.get(tabId)).successAt = Date.now();
    return;
  }
  settling.set(tabId, { ...t, successAt: Date.now(), lastCookieChange: 0 });
  waitAndSend(tabId);
}

/** @param {number} tabId */
async function waitAndSend(tabId) {
  for (;;) {
    await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
    const s = settling.get(tabId);
    if (!s) return;
    let tab;
    try {
      tab = await api.tabs.get(tabId);
    } catch {
      // タブが閉じられた
      settling.delete(tabId);
      return;
    }
    const done = K.settled({
      now: Date.now(),
      successAt: s.successAt,
      lastCookieChange: s.lastCookieChange,
      tabComplete: tab.status === "complete",
    });
    if (!done) continue;
    settling.delete(tabId);
    // ページの移動で別のサイトに出ていたら送らない（手で戻るボタンは使える）。`.google.com` で待っていれば、
    // accounts.google.com から myaccount.google.com に移っていても同じサイト
    if (!urlInSite(tab.url, s.site)) return;
    // 読む前に、今も許可サイトで、今も待っているかを聞き直す（覚えた後に一覧から消えた・待ちが終わったサイトの
    // Cookie は読まない）。送る先も今の答えの受け口にする
    const { sites, waiting } = await refreshSites();
    if (!sites.includes(s.site)) return showError(tabId, "not-allowed");
    const w = waiting.get(s.site);
    if (!w) return showError(tabId, "not-waiting");
    await sendCookies(/** @type {Tab} */ (tab), s.site, w.host);
    return;
  }
}

// ---- Cookie を読んで送る

/** @param {Tab} tab @returns {Promise<string | undefined>} */
async function storeIdOf(tab) {
  if (tab.cookieStoreId) return tab.cookieStoreId;
  const stores = await api.cookies.getAllCookieStores();
  const s = stores.find((x) => (x.tabIds ?? []).includes(tab.id));
  return s ? s.id : undefined;
}

/** @param {any} details @returns {Promise<chrome.cookies.Cookie[]>} */
async function getAll(details) {
  try {
    return await api.cookies.getAll(details);
  } catch (e) {
    // Firefox で first-party isolation を入れていると firstPartyDomain が要る
    if (typeof browser !== "undefined") {
      return await api.cookies.getAll({ ...details, firstPartyDomain: null });
    }
    throw e;
  }
}

// `host`（今のタブの host）のページに送られる Cookie だけを返す。url で引くと、path が `/` に当たらない Cookie（`/login` だけのものなど）が落ちるので、
// domain でも引いて合わせる（domain で引くと下のドメインのものも来るが、pickCookies が捨てる）
/** @param {Tab} tab @param {string} host */
async function readCookies(tab, host) {
  const storeId = await storeIdOf(tab);
  const base = storeId ? { storeId } : {};
  const [byUrl, byDomain] = await Promise.all([
    getAll({ ...base, url: `https://${host}/` }),
    getAll({ ...base, domain: host }),
  ]);
  return K.pickCookies([...byUrl, ...byDomain], host);
}

// 今のタブのページに送られる Cookie を、許可サイトの項目 `site` の Cookie として、受け口 `host` に送る
/** @param {Tab} tab @param {string} site @param {string} host */
async function sendCookies(tab, site, host) {
  // 呼ぶ側も確かめているが、念のため（項目に当たらないページの Cookie は読まない）
  const page = K.hostOf(tab.url ?? "");
  if (!page || !K.inSite(page, site)) return showError(tab.id, "not-allowed");
  let reply;
  try {
    const cookies = await readCookies(tab, page);
    reply = await ask(host, { type: "cookies", site, cookies });
  } catch (e) {
    console.warn("kisui-terminal: could not read cookies", e);
    reply = null;
  }
  if (reply && reply.type === "done") {
    await untrack(tab.id);
    await api.tabs.remove(tab.id).catch(() => {});
    return;
  }
  await showError(
    tab.id,
    reply && reply.type === "error" ? reply.code : "not-running",
  );
}

// ---- 手で戻るボタン

/** @param {Tab} tab */
async function onActionClicked(tab) {
  // Firefox では、入れるときに権限を断れる。ボタンを押したとき（ユーザーの操作の中）に頼み直す
  let granted = false;
  try {
    granted = await api.permissions.request({ origins: ORIGINS });
  } catch {
    // 頼めないとき（入れるときにもらった権限で足りるなど）は、持っているかを見る
    granted = await api.permissions
      .contains({ origins: ORIGINS })
      .catch(() => false);
  }
  if (!granted) return showError(tab.id, "no-permission");
  const { sites, waiting } = await refreshSites();
  // 当たる許可サイトの項目（`.google.com` で待っていれば、myaccount.google.com のタブからも送れる）
  const host = K.hostOf(tab.url ?? "");
  if (!K.siteOf(host, sites)) return showError(tab.id, "not-allowed");
  const site = K.waitingSiteOf(host, sites, waiting);
  const w = site && waiting.get(site);
  if (!site || !w) return showError(tab.id, "not-waiting");
  await sendCookies(tab, site, w.host);
}

/** @param {number} tabId @param {string} code */
async function showError(tabId, code) {
  const key =
    {
      "bad-request": "errorBadRequest",
      "not-allowed": "errorNotAllowed",
      "not-waiting": "errorNotWaiting",
      "no-cookies": "errorNoCookies",
      failed: "errorFailed",
      "not-running": "errorNotRunning",
      "no-permission": "errorNoPermission",
    }[code] ?? "errorFailed";
  const message = api.i18n.getMessage(key) || code;
  await api.action
    .setBadgeBackgroundColor({ tabId, color: "#c0392b" })
    .catch(() => {});
  await api.action.setBadgeText({ tabId, text: "!" }).catch(() => {});
  await api.action
    .setTitle({
      tabId,
      title: `${api.i18n.getMessage("actionTitle")}\n${message}`,
    })
    .catch(() => {});
}

// ---- つなぐ（service worker が起き直すたびに、同期で登録する）

api.tabs.onCreated.addListener(
  (tab) => void onTabCreated(/** @type {Tab} */ (tab)),
);
api.tabs.onUpdated.addListener(
  (tabId, changeInfo) => void onTabUpdated(tabId, changeInfo),
);
api.tabs.onRemoved.addListener((tabId) => {
  settling.delete(tabId);
  newTabs.delete(tabId);
  void untrack(tabId);
});
api.cookies.onChanged.addListener(onCookieChanged);
api.runtime.onMessage.addListener((message, sender) => {
  void onMessage(message, sender);
});
api.action.onClicked.addListener(
  (tab) => void onActionClicked(/** @type {Tab} */ (tab)),
);
api.runtime.onStartup.addListener(() => void checkExistingTabs());
api.runtime.onInstalled.addListener(() => void refreshSites());
