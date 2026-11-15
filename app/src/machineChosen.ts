// タブを足すマシンを選ぶ窓（#272）で、マシンを選んだときの処理。
// 依存は引数で受けるので、node --test で確かめられる。

/**
 * 窓を閉じて、選ばれたマシンでターミナルのタブを足す関数を返す。
 * gid は <Show keyed> が渡す値そのもの。accessor ではないので、窓を閉じたあとでも読める。
 */
export function machineChosen(
  gid: string,
  close: () => void,
  newTab: (gid: string, target: string) => void,
): (target: string) => void {
  return (target) => {
    close();
    newTab(gid, target);
  };
}
