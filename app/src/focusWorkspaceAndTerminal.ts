// サイドバーの帯を押す・キーでワークスペースを移ったあと、そのワークスペースのペインにキーを向ける（#151）。
// 帯を押すとキーが外れる理由は、呼ぶ側（App.tsx の switchWorkspace）に書いてある。
// 依存は引数で受けるので、node --test で確かめられる。

export interface WorkspaceRef {
  target: string;
  id: string;
}

export interface FocusWorkspaceAndTerminalDeps {
  /** shj に移ると頼み、受け付けられたら GUI のフォーカスも移す（失敗や、あとの押下に上書きされたときは、例外を投げずに移らないまま返る） */
  focusWorkspace: (target: string, id: string) => Promise<void>;
  /** 今 GUI がフォーカスしているワークスペース */
  current: () => WorkspaceRef | null | undefined;
  /** 今使っているターミナルのペインにキーを向ける */
  focusTerminal: () => void;
}

/**
 * 移ったあと、頼んだワークスペースが GUI のフォーカスになっていれば、そこで最後に使っていたペインにキーを向ける。
 * 失敗したとき、返事を待つあいだに別の帯を押されたときは、向けない（キーは今のワークスペースのまま）。
 * focusWorkspace が例外を投げたときも、向けずにそのまま返す。
 */
export async function focusWorkspaceAndTerminal(
  deps: FocusWorkspaceAndTerminalDeps,
  target: string,
  id: string,
): Promise<void> {
  await deps.focusWorkspace(target, id);
  const f = deps.current();
  if (f?.target === target && f.id === id) deps.focusTerminal();
}
