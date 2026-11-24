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
    // 印が付けられなくても、同じ関数を 2 回包まない（wrap が見分ける）
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

  // 入れ物ごとの、こちらの accessor を置く前にあった持ち物（無ければ prototype のものを使う）。
  // 代入されたら、その値に置き換える
  /** @type {WeakMap<object, Partial<Record<Name, PropertyDescriptor>>>} */
  const before = new WeakMap();

  /** @param {object} obj @param {PropertyDescriptor | undefined} desc @param {Name} name */
  function resolve(obj, desc, name) {
    if (!desc) return Reflect.get(Object.getPrototypeOf(obj) ?? {}, name, obj);
    return desc.get ? desc.get.call(obj) : desc.value;
  }

  /** @param {Name} name */
  function accessor(name) {
    return {
      /** @this {object} */
      get() {
        const cur = resolve(this, before.get(this)?.[name], name);
        return typeof cur === "function" ? wrap(cur) : cur;
      },
      /** @this {object} @param {unknown} v */
      set(v) {
        const saved = before.get(this) ?? {};
        const desc = saved[name];
        if (desc && desc.set) desc.set.call(this, v);
        else saved[name] = { value: v, writable: true, configurable: true };
        before.set(this, saved);
      },
    };
  }
  const ACCESSORS = { get: accessor("get"), create: accessor("create") };

  // 入れ物の get / create を、こちらの accessor にする（もうそうなら何もしない）
  /** @param {unknown} c */
  function ensure(c) {
    if (!c || (typeof c !== "object" && typeof c !== "function")) return;
    const obj = /** @type {object} */ (c);
    for (const name of NAMES) {
      const desc = Object.getOwnPropertyDescriptor(obj, name);
      if (desc && desc.get === ACCESSORS[name].get) continue;
      const saved = before.get(obj) ?? {};
      if (desc) saved[name] = desc;
      else delete saved[name];
      before.set(obj, saved);
      try {
        Object.defineProperty(obj, name, {
          get: ACCESSORS[name].get,
          set: ACCESSORS[name].set,
          configurable: true,
          enumerable: desc ? desc.enumerable : false,
        });
      } catch {
        // 置き換えられない入れ物では、手で戻るボタンを使う
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
