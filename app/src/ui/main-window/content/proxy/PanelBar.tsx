// プロキシのパネル（#409）の、左に見出しや説明、右に状態とボタンを寄せた並び（#422）。
// パネルの頭・止めている要求の帯・書き換える欄の頭は、どれもこの部品で並べる。
// 狭い幅・字の長い言語（日本語）でどう折り返し、どこを縮め、どこを折らないかは、ProxyPanel.module.css の .bar の段だけで決める。
// 並びを足すときは、ここを使う（並びごとに折り返しを手で書かない）。崩れないことは、ProxyPanel.stories.tsx の狭い幅の stories が確かめる。
import type { JSX } from "solid-js";

import styles from "./ProxyPanel.module.css";

/** 左に見出しや説明（lead）、右に状態とボタン（actions）を寄せた並び。 */
export function PanelBar(props: {
  /** 並びの場所ごとの枠（間・線・地）。並べ方は書かない */
  class: string;
  /** 左：見出し・説明。縮み、入りきらなければ字を折り返すか省く（省くなら、title で全体を読めるようにする） */
  lead: JSX.Element;
  /** 右：状態とボタン。1 つずつは縮めず字も折らず、入りきらなければ 1 つずつ次の行に移る */
  actions: JSX.Element;
}): JSX.Element {
  return (
    <div class={`${styles.bar} ${props.class}`} data-bar>
      <div class={styles.barLead}>{props.lead}</div>
      <div class={styles.barActions}>{props.actions}</div>
    </div>
  );
}
