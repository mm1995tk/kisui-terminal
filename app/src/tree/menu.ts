// ツリーの右クリックのメニュー（項目の出し分け）と、パスの組み立て。
// DOM を使わないので node --test で確かめられる。

import type { TreeRow } from "./model.ts";

/** メニューの項目。 */
export type TreeMenuAction =
  | "copy-name"
  | "copy-relative"
  | "copy-absolute"
  | "new-file"
  | "new-dir"
  | "rename"
  | "delete"
  | "cd";

/** 項目の文言。 */
export const treeMenuLabels: Record<TreeMenuAction, string> = {
  "copy-name": "名前をコピー",
  "copy-relative": "相対パスをコピー",
  "copy-absolute": "絶対パスをコピー",
  "new-file": "新しいファイル",
  "new-dir": "新しいフォルダ",
  rename: "名前の変更",
  delete: "削除",
  cd: "ここへ移動",
};

/** 行に出す項目（上から順）。ファイルはパスのコピーと名前の変更・削除、フォルダは新規作成と cd も。 */
export function menuItems(row: Pick<TreeRow, "dir">): TreeMenuAction[] {
  const common: TreeMenuAction[] = [
    "copy-name",
    "copy-relative",
    "copy-absolute",
  ];
  return row.dir
    ? [...common, "new-file", "new-dir", "rename", "delete", "cd"]
    : [...common, "rename", "delete"];
}

/**
 * メニューを閉じたあと、開く前にフォーカスがあった行へフォーカスを戻すか。戻すのは、その行がまだ画面にあり、
 * ツリーの行で、フォーカスがどこにも無い（body）ときだけ。項目の動きで窓が出た（フォーカスが窓へ移った）ときと、
 * メニューの外を押してほかの所にフォーカスが移ったときは戻さない。
 */
export function shouldRestoreFocus(
  opener: { isConnected: boolean; matches: (s: string) => boolean } | null,
  active: unknown,
  body: unknown,
): boolean {
  return (
    !!opener &&
    opener.isConnected &&
    opener.matches(".tree-row") &&
    (active === body || active === null)
  );
}

/** ルートのフォルダ（絶対パス）と、ルートからの相対パスをつなぐ。 */
export function absolutePath(root: string, rel: string): string {
  if (rel === "") return root;
  return `${root.endsWith("/") ? root : `${root}/`}${rel}`;
}

/** 相対パスの親（ルート直下なら ""）。 */
export function parentPath(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

/** 新しいものの名前を入れる欄の初期値：フォルダの中を指す "dir/"（ルートなら ""）。 */
export function newEntryDefault(dir: string): string {
  return dir === "" ? "" : `${dir}/`;
}

/**
 * 新しいファイル・フォルダの入力を、ルートからの相対パスにする。名前が無いとき（空、ファイルで "/" 終わり）は null。
 * 先頭の "./" と前後の空白は落とす。フォルダは末尾の "/" も落とす（TUI の A と同じく "src/new/" でも作る）。
 */
export function newEntryPath(
  input: string,
  kind: "file" | "dir",
): string | null {
  let v = input.trim().replace(/^(\.\/)+/, "");
  if (kind === "dir") v = v.replace(/\/+$/, "");
  if (v === "" || v.endsWith("/")) return null;
  return v;
}

/** 名前の変更の入力を、新しい相対パスにする。空・変わっていないときは null。 */
export function renamedPath(old: string, input: string): string | null {
  const v = input.trim().replace(/^(\.\/)+/, "");
  if (v === "" || v === old || v.endsWith("/")) return null;
  return v;
}
