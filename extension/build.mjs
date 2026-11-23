// 拡張機能を Firefox に入れる形にする（依存は Node だけ）。
//
//   node extension/build.mjs [出力のフォルダ]   （既定は extension/dist）
//
// 出力:
//   firefox/ … Firefox の about:debugging で一時的に入れるフォルダ
//   kisui-terminal-firefox-<版>.zip … addons.mozilla.org に上げるもの
//
// 中身は extension/ のファイルそのもの（manifest.json も。まとめも縮めもしない）。
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

// 拡張機能に入れるファイル
const FILES = [
  "manifest.json",
  "background.js",
  "lib.js",
  "page.js",
  "relay.js",
  "_locales",
  "icons",
];

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

// out に拡張機能を作り、作った zip のパスを返す。out は先に消してから作り直す（渡したフォルダの中身は残らない）。
// 作るもの：firefox/（手で入れるフォルダ）と、addons.mozilla.org に上げる kisui-terminal-firefox-<版>.zip
export function build(out) {
  const { version } = JSON.parse(
    readFileSync(join(src, "manifest.json"), "utf8"),
  );
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
  // フォルダ（手で入れて試す）
  const dir = join(out, "firefox");
  for (const f of files) {
    mkdirSync(dirname(join(dir, f.name)), { recursive: true });
    writeFileSync(join(dir, f.name), f.data);
  }
  // addons.mozilla.org に上げる zip
  const z = join(out, `kisui-terminal-firefox-${version}.zip`);
  writeFileSync(z, zip(files));
  return z;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = process.argv[2] ?? join(src, "dist");
  console.log(build(out));
}
