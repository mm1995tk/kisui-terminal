// 型の検査（tsc -p extension）だけが読む。zip には入らない。
// ブラウザの API の型は @types/chrome を使う。Firefox の browser は、ここで使う範囲では同じ形（promise を返す）。
declare var browser: typeof chrome;
// relay.js が二重に入らないための印
declare var __kisuiRelay: boolean | undefined;
