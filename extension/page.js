// 許可サイトのページの中（MAIN world）で動く。ページの navigator.credentials.get / create がパスキー（publicKey）で
// 成功したら、relay.js（拡張機能の側の content script）に知らせる。値（資格情報）は渡さない。
// background.js が、kisui-terminal の設定の passkey_sites のサイトにだけ入れる。
//
// パスキーの管理の拡張機能（1Password など）も、同じ get / create を自分の関数に置き換え、パスキーを自分で出すときは
// もとの関数を呼ばない。ページが呼ぶ関数（いちばん外側）が kisui-terminal のものでないと、通ったことを知れない（#433）。
// 拡張機能が入る順は決まっていないので、どちらが先に入っても、ページが呼ぶ関数がこちらの包みになるようにする。
//
// - navigator.credentials を読むたびに（navigator に置いた getter）、返す入れ物（CredentialsContainer）の get / create を
//   こちらの accessor にし直す。ほかの拡張機能が後から Object.defineProperty で置き換えても、ページが次に読むときに包み直す。
// - get / create の accessor は、読まれるたびに、そのときの関数（ほかの拡張機能が代入したもの・入れ物やその prototype に
//   置いたもの）を包んで返す。代入（navigator.credentials.get = f）は setter が受け取る。
// - 包みの中から別の包みが同期に呼ばれたとき（ほかの拡張機能が、こちらが先に包んだ関数を呼び戻す）は、外側だけが知らせる。
//
// ページから見える値（navigator.credentials が返す入れ物・get / create の結果）は変えない。
(() => {
  const EVENT = "kisui-terminal-passkey-success";
  const MARK = Symbol.for("kisui-terminal-passkey");
  const NAMES = /** @type {const} */ (["get", "create"]);
  /** @typedef {"get" | "create"} Name */

  const g = /** @type {any} */ (globalThis);
  const nav = g.navigator;
  // 2 回入ることがある（登録したものと、タブを覚えたときに入れたもの（background.js の track））
  if (!nav || g[MARK]) return;
  try {
    Object.defineProperty(g, MARK, { value: true });
  } catch {
    // 印が付けられないと 2 回目も包み、知らせが 2 回出る。background.js は 2 回目で待ちの時刻を更新するだけなので害は無い
  }

  // ---- 包み

  /** @type {WeakMap<Function, Function>} もとの関数 → 包み（同じ関数には同じ包みを返す） */
  const wrapperOf = new WeakMap();
  /** @type {WeakSet<Function>} こちらの包み */
  const wrappers = new WeakSet();
  // 包みの中で同期に呼ばれている深さ（内側の包みは知らせない）
  let depth = 0;

  /** @param {Function} fn @returns {Function} */
  function wrap(fn) {
    if (wrappers.has(fn)) return fn;
    const known = wrapperOf.get(fn);
    if (known) return known;
    /** @this {unknown} @param {{ publicKey?: unknown } | undefined} options */
    const wrapped = function (options) {
      if (depth > 0) return fn.apply(this, arguments);
      depth++;
      let p;
      try {
        p = fn.apply(this, arguments);
      } finally {
        depth--;
      }
      if (options && options.publicKey) {
        Promise.resolve(p).then(
          (cred) => {
            if (cred) document.dispatchEvent(new CustomEvent(EVENT));
          },
          () => {},
        );
      }
      return p;
    };
    wrapperOf.set(fn, wrapped);
    wrappers.add(wrapped);
    return wrapped;
  }

  // ---- 入れ物の get / create

  // accessor は入れ物ごとに作り、入れ物をクロージャで持つ。置く前にあった持ち物を引くのも、prototype をたどるのも
  // その入れ物から（受け手 this が入れ物でないとき（Object.create(入れ物)・Proxy）も、入れ物に置いた関数を返すため）。
  // 関数や getter を呼ぶときの受け手だけ this のまま。
  // 置く前にあった持ち物は、置き直すたびに積む（古いものが先）。ほかの拡張機能の accessor が、前にあったこちらの
  // getter を呼び戻すと、こちらの getter に入り直す。そのときは 1 つ前の持ち物を使い、同じ所を回らないようにする
  /** @type {WeakSet<Function>} こちらの accessor の getter */
  const getters = new WeakSet();
  /** @type {WeakMap<object, { saved: Record<Name, PropertyDescriptor[]>, accessors: Record<Name, { get: () => unknown, set: (v: unknown) => void }> }>} */
  const containers = new WeakMap();

  /** @param {object} obj */
  function stateOf(obj) {
    const known = containers.get(obj);
    if (known) return known;
    /** @type {Record<Name, PropertyDescriptor[]>} 置く前にあった持ち物（空なら prototype のものを使う）。代入されたら、いちばん上をその値にする */
    const saved = { get: [], create: [] };
    /** @param {Name} name */
    const accessor = (name) => {
      const chain = saved[name];
      // getter に入り直している深さ（0 ならいちばん上の持ち物を使う）
      let level = 0;
      /** @this {object} */
      const get = function () {
        const desc = chain[chain.length - 1 - level];
        level++;
        let cur;
        try {
          cur = desc
            ? desc.get
              ? desc.get.call(this)
              : desc.value
            : Reflect.get(Object.getPrototypeOf(obj) ?? {}, name, this);
        } finally {
          level--;
        }
        return typeof cur === "function" ? wrap(cur) : cur;
      };
      /** @this {object} @param {unknown} v */
      const set = function (v) {
        const i = chain.length - 1 - level;
        const desc = chain[i];
        if (desc && desc.set) {
          level++;
          try {
            desc.set.call(this, v);
          } finally {
            level--;
          }
        } else if (this !== obj) {
          // 入れ物を prototype に持つもの・Proxy への代入は、ふつうのデータの持ち物と同じく、受け手に置く
          Object.defineProperty(this, name, {
            value: v,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        } else {
          chain[Math.max(i, 0)] = {
            value: v,
            writable: true,
            configurable: true,
          };
        }
      };
      getters.add(get);
      return { get, set };
    };
    const state = {
      saved,
      accessors: { get: accessor("get"), create: accessor("create") },
    };
    containers.set(obj, state);
    return state;
  }

  // 入れ物の get / create を、こちらの accessor にする（もうそうなら何もしない）
  /** @param {unknown} c */
  function ensure(c) {
    if (!c || (typeof c !== "object" && typeof c !== "function")) return;
    const obj = /** @type {object} */ (c);
    for (const name of NAMES) {
      const desc = Object.getOwnPropertyDescriptor(obj, name);
      if (desc && desc.get && getters.has(desc.get)) continue;
      const { saved, accessors } = stateOf(obj);
      const chain = saved[name];
      const prev = chain.slice();
      // 持ち物が消されていたら（delete）、前に積んだものは使わず prototype のものを使う
      if (desc) chain.push(desc);
      else chain.length = 0;
      try {
        Object.defineProperty(obj, name, {
          ...accessors[name],
          configurable: true,
          enumerable: desc ? desc.enumerable : false,
        });
      } catch {
        // 置き換えられない入れ物（configurable でない持ち物）では、手で戻るボタンを使う
        chain.splice(0, chain.length, ...prev);
      }
    }
  }

  // ---- navigator.credentials

  // navigator に前からあった持ち物（ふつうは無く、Navigator.prototype の getter を使う）
  const navDesc = Object.getOwnPropertyDescriptor(nav, "credentials");
  const current = () =>
    navDesc
      ? navDesc.get
        ? navDesc.get.call(nav)
        : navDesc.value
      : Reflect.get(Object.getPrototypeOf(nav) ?? {}, "credentials", nav);
  ensure(current());
  try {
    Object.defineProperty(nav, "credentials", {
      get() {
        const c = current();
        ensure(c);
        return c;
      },
      configurable: true,
      enumerable: navDesc ? navDesc.enumerable : true,
    });
  } catch {
    // 置き換えられないときは、今の入れ物を包んだところまで
  }
})();
