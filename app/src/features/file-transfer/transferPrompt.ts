import { createSignal } from "solid-js";

/** 許可を求める転送の中身（画面に見せるもの）。 */
export type TransferInfo =
  | {
      /** プログラムが手元にファイルを書く（kitty の `kitten transfer` で手元へ受け取る） */
      direction: "write";
      /** 書き込み先のディレクトリ（これ以外には書かない） */
      destination: string;
    }
  | {
      /** プログラムが手元のファイルを読む（手元から送り出す） */
      direction: "read";
      /**
       * 許すと相手に渡る項目の全部（ディレクトリは、中のファイルとディレクトリも 1 つずつ入っている）。
       * 窓は省かずに全部並べる。ここに無いものは読まれない
       */
      items: ReadItem[];
      /** 普通のファイルの数と大きさの合計 */
      files: number;
      totalSize: number;
    };

/** 許可の窓に並べる、読んで送る項目 1 つ（transfer.ts の readInfo が作る）。 */
export interface ReadItem {
  /** 手元の絶対パス */
  path: string;
  kind: "regular" | "directory" | "symlink";
  /** 普通のファイルの大きさ（バイト） */
  size: number | undefined;
}

/** 許可を待っている転送。 */
export interface TransferPrompt {
  info: TransferInfo;
  resolve: (allowed: boolean) => void;
}

const [queue, setQueue] = createSignal<TransferPrompt[]>([]);

/** いま画面に出す頼み（先頭 1 つ。残りは順に出す）。 */
export const currentTransferPrompt = () => queue()[0];

/**
 * 転送の許可をユーザーに求める。そのたびに聞き、覚えない（手元のファイルを読み書きするため）。
 * 返す cancel は、プログラムが取り消したときなど、答えが要らなくなったときに断りとして取り下げる。
 */
export function askTransfer(info: TransferInfo): {
  allowed: Promise<boolean>;
  cancel: () => void;
} {
  let entry!: TransferPrompt;
  const allowed = new Promise<boolean>((resolve) => {
    entry = {
      info,
      resolve: (ok) => {
        setQueue((q) => q.filter((e) => e !== entry));
        resolve(ok);
      },
    };
  });
  setQueue((q) => [...q, entry]);
  return { allowed, cancel: () => entry.resolve(false) };
}
