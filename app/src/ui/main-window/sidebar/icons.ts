// サイドバーの絵に使う Nerd Fonts の字（Symbols Nerd Font Mono。app/src/symbols-nerd-font.css が持つ）。
// 字の名前は Nerd Fonts の cheat sheet のもの。描くときは .nf（sidebar.css）を付けた要素に入れる。

export const ICON = {
  /** nf-fa-terminal：ターミナルのタブ */
  terminal: "",
  /** nf-fa-globe：ブラウザのタブ */
  globe: "",
  /** nf-fa-link：ブラウザのタブの URL */
  link: "",
  /** nf-fa-folder：フォルダのパス */
  folder: "",
  /** nf-oct-git_branch：ブランチと short sha */
  git: "",
  /** nf-fa-desktop：マシン */
  machine: "",
  /** nf-fa-plus：タブを足す */
  plus: "",
  /** nf-fa-pencil：名前を変える */
  pencil: "",
  /** nf-fa-times：閉じる */
  close: "",
} as const;
