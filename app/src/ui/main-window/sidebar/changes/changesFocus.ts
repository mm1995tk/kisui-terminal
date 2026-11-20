// shj の Space E・cmd.diffchanges で、サイドバーの CHANGES にキーを向ける先（向けるのは ui/main-window/focus.ts）。

/** キーを向ける行：shj が差分を出しているファイルの行（閉じたフォルダの中ならそのフォルダの行）、無ければ最初の行。 */
export function changesRow(root: ParentNode | undefined): HTMLElement | null {
  if (!root) return null;
  return (
    root.querySelector<HTMLElement>(
      '.changes-row[aria-selected="true"], .changes-row[data-holds]',
    ) ?? root.querySelector<HTMLElement>(".changes-row")
  );
}
