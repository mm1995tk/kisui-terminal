// 小さな記録（マシンの色・並び・大きさなど）の読み書きの窓口。機能はこの形だけを知り、
// 本物（webview の localStorage。infrastructure/storage/localStorage.ts）は index.tsx が渡す。テストでは Map などで差し替える。

/** 読み書きの窓口。localStorage と同じ形の最小限。 */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
