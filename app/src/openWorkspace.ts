// サイドバーの帯を押す・番号やひとつ前のキーでワークスペースを移ったあと、そのワークスペースのペインにキーを向ける（#151）。
// 帯は <button> で、押すとキーがサイドバーの中（macOS の WebKit では body）に移る。戻ってもペインにキーが無いと、押し直さないと打てない。
// 依存は引数で受けるので、node --test で確かめられる。

export interface WorkspaceRef {
  target: string;
  id: string;
}

export interface OpenWorkspaceDeps {
  /** shj に移ると頼み、受け付けられたら GUI のフォーカスも移す（失敗や、あとの押下に上書きされたときは移らないまま返る） */
  focusWorkspace: (target: string, id: string) => Promise<void>;
  /** 今 GUI がフォーカスしているワークスペース */
  current: () => WorkspaceRef | null | undefined;
  /** 今使っているターミナルのペインにキーを向ける */
  focusTerminal: () => void;
}

/**
 * 移ったあと、頼んだワークスペースが GUI のフォーカスになっていれば、そこで最後に使っていたペインにキーを向ける。
 * 失敗したとき、返事を待つあいだに別の帯を押されたときは、向けない（キーは今のワークスペースのまま）。
 */
export async function openWorkspace(
  deps: OpenWorkspaceDeps,
  target: string,
  id: string,
): Promise<void> {
  await deps.focusWorkspace(target, id);
  const f = deps.current();
  if (f?.target === target && f.id === id) deps.focusTerminal();
}
