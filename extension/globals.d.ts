// 型の検査（tsc -p extension）だけが読む。zip には入らない。
// ブラウザの API の型は @types/chrome を使う。Firefox の browser は、promise を返す形が Chrome の chrome と同じ範囲だけ使う。
declare var browser: typeof chrome | undefined;
declare function importScripts(...urls: string[]): void;
// relay.js が二重に入らないための印
declare var __kisuiRelay: boolean | undefined;
