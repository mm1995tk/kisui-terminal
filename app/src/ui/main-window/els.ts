/** メインウィンドウの要素のうち、キーの行き先や大きさを決めるのに読むもの。描いたときに layout.tsx・Sidebar・ContentArea が入れる。 */
export interface WindowEls {
  /** 窓全体（main.app） */
  app?: HTMLElement;
  /** サイドバー（nav） */
  nav?: HTMLElement;
  /** 右のペイン（ターミナルのグリッドとブラウザのページを出す所） */
  main?: HTMLDivElement;
}
