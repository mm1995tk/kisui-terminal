// 拡張機能を Chrome と Firefox の形にする（依存は Node だけ）。
//
//   node extension/build.mjs [出力のフォルダ]   （既定は extension/dist）
//
// 出力:
//   chrome/  … Chrome に「パッケージ化されていない拡張機能を読み込む」で入れるフォルダ
//   firefox/ … Firefox の about:debugging で一時的に入れるフォルダ
//   kisui-terminal-chrome-<版>.zip  … Chrome ウェブストアに上げるもの
//   kisui-terminal-firefox-<版>.zip … addons.mozilla.org に上げるもの
//
// コードは両方で同じ。違うのは manifest.json だけ（Chrome は background.service_worker、
// Firefox は background.scripts と browser_specific_settings）。
// zip の中身の順と時刻を決めておき、同じソースからは同じ zip ができるようにする。
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const src = dirname(fileURLToPath(import.meta.url));

// Chrome ウェブストアの公開鍵（ダッシュボードの「パッケージ」の「公開鍵を表示」の、BEGIN と END の間を 1 行にしたもの）。
// 入れると、パッケージ化されていない chrome/ もストアと同じ id になる（docs/browser-extension.md）。
// ストアに上げる zip には入れない。この鍵から計算した id は、app/src-tauri/src/passkey.rs の CHROME_EXTENSION_IDS にある
// ストアのアイテム ID と同じ（extension.test.ts が確かめる）
export const CHROME_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvYXdRKgzalGtemC7QK0Hu0e8noiFIQAD34mLs338bBI85Q7oV0WKUkMzHhZ3Kxd9046my3p+w3icl2wVlGdF+TPBVJmwsQXhlaWsWvz/NIVeaX6OtEB+vt0BF+MohMWBGu3UE+m8sYkYmk4xJZy+1xnMQOefs9I9CH+ZTQ3sUdi3GLEUFl1eEszedP+FQTEEJHFcga0nIIaBD6Z84y6bVJu4PQxSbIrjve2t8w7PCTIc4909oHnPAlXEK4hM6S8BnJj0/ywA8oEBGM53Ecn2/05QXpSJB4e/IMvtvpyQ1t3oH9HtV6ZEyjJ5U/NXGrUBtIe1+otYIhA9cMegutyyeQIDAQAB";

// 拡張機能に入れるファイル（manifest.json は別に作る）
const FILES = [
  "background.js",
  "lib.js",
  "page.js",
  "relay.js",
  "_locales",
  "icons",
];

// 元の manifest.json（base）から、ブラウザ（"chrome" か "firefox"）の manifest を作る（base は変えない）。
// Chrome：background を service_worker だけにし、Firefox だけの browser_specific_settings を消す。chromeKey があれば key に入れる。
// Firefox：background を scripts だけにする（browser_specific_settings は残す）。ほかのブラウザの名前なら例外にする
export function manifestFor(browser, base, { chromeKey = "" } = {}) {
  const m = structuredClone(base);
  if (browser === "chrome") {
    m.background = { service_worker: base.background.service_worker };
    delete m.browser_specific_settings;
    if (chromeKey) m.key = chromeKey;
  } else if (browser === "firefox") {
    m.background = { scripts: base.background.scripts };
  } else {
    throw new Error(`unknown browser: ${browser}`);
  }
  return m;
}

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

// [{ name, data }] から zip を作る（deflate。時刻は 1980-01-01 00:00 に揃える）
export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const comp = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 展開に要る版
    local.writeUInt16LE(0x0800, 6); // 名前は UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// out に拡張機能を作り、作った 2 つの zip のパスを返す。out は先に消してから作り直す（渡したフォルダの中身は残らない）。
// 作るもの：chrome/・firefox/（手で入れるフォルダ。chrome/ には CHROME_PUBLIC_KEY があれば key を入れる）と、
// ストアに上げる kisui-terminal-chrome-<版>.zip・kisui-terminal-firefox-<版>.zip（key は入れない）
export function build(out) {
  const base = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));
  rmSync(out, { recursive: true, force: true });
  const files = FILES.flatMap((f) => {
    const p = join(src, f);
    return statSync(p).isDirectory() ? listFiles(p) : [p];
  })
    .map((p) => ({
      name: relative(src, p).split("\\").join("/"),
      data: readFileSync(p),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const made = [];
  for (const browser of ["chrome", "firefox"]) {
    const write = (m) => Buffer.from(JSON.stringify(m, null, 2) + "\n");
    // フォルダ（手で入れて試す）。Chrome は公開鍵があれば入れ、ストアと同じ id にする
    const dir = join(out, browser);
    const unpacked = manifestFor(browser, base, {
      chromeKey: CHROME_PUBLIC_KEY,
    });
    for (const f of [
      { name: "manifest.json", data: write(unpacked) },
      ...files,
    ]) {
      mkdirSync(dirname(join(dir, f.name)), { recursive: true });
      writeFileSync(join(dir, f.name), f.data);
    }
    // ストアに上げる zip
    const entries = [
      { name: "manifest.json", data: write(manifestFor(browser, base)) },
      ...files,
    ];
    const z = join(out, `kisui-terminal-${browser}-${base.version}.zip`);
    writeFileSync(z, zip(entries));
    made.push(z);
  }
  return made;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = process.argv[2] ?? join(src, "dist");
  for (const z of build(out)) console.log(z);
}
