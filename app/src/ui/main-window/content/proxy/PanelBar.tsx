// プロキシのパネル（#409）の、左に見出しや説明、右に状態とボタンを寄せた並び（#422）。
// パネルの頭・止めている要求の帯・書き換える欄の頭は、どれもこの部品で並べる。
// 狭い幅・字の長い言語（日本語）でどう折り返し、どこを縮め、どこを折らないかは、ProxyPanel.module.css の .bar の段だけで決める。
// 並びを足すときは、ここを使う（並びごとに折り返しを手で書かない）。並べ方を場所ごとの規則に書き足すと panelBar.test.ts が落ちる。
// 崩れないことは CI では確かめない。並びを足したら、Storybook で ProxyPanel の `…Narrowest` の stories（英語と日本語）を開き、
// Interactions に失敗（barCheck.ts）が出ないことを、人の手で確かめる。
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
