// プロキシのパネルの並び（PanelBar.tsx）が、狭い幅で崩れていないかを確かめる（#422）。
// ProxyPanel.stories.tsx の狭い幅の stories が、出したあとに呼ぶ（play）。崩れていれば、その story は Storybook で失敗として出る。

/** 測るときの誤差（px） */
const slack = 1;

/**
 * root の中の並び（data-bar）ごとに、崩れを探して文で返す（崩れが無ければ空）。
 * - 並びの中のものが、並びの外にはみ出していない（字の長いボタンが窓の端で切れない）。
 * - 右のもの（状態・ボタン）の字が、折れていない（1 行の高さのまま）。
 * - 左（見出し・説明）が、並びの幅か 16em の狭い方より狭くなっていない（説明が細かく折り返さない）。
 */
export function barProblems(root: HTMLElement): string[] {
  const out: string[] = [];
  for (const bar of root.querySelectorAll<HTMLElement>("[data-bar]")) {
    const name = bar.className;
    const box = bar.getBoundingClientRect();
    for (const el of bar.querySelectorAll<HTMLElement>("*")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.left < box.left - slack || r.right > box.right + slack)
        out.push(
          `${name}: "${text(el)}" sticks out (${Math.round(r.left)}..${Math.round(r.right)} of ${Math.round(box.left)}..${Math.round(box.right)})`,
        );
    }
    const [lead, actions] = [...bar.children] as HTMLElement[];
    for (const item of actions
      ? ([...actions.children] as HTMLElement[])
      : []) {
      // ボタンは高さが決まっているので、字が折れると中ではみ出す。ほかは 1 行の高さを超える
      const style = getComputedStyle(item);
      const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize);
      const broken =
        item.scrollHeight > item.clientHeight + slack ||
        (item.tagName !== "BUTTON" &&
          item.getBoundingClientRect().height > line * 1.5);
      if (broken) out.push(`${name}: "${text(item)}" breaks into lines`);
      if (item.scrollWidth > item.clientWidth + slack)
        out.push(`${name}: "${text(item)}" does not fit in itself`);
    }
    if (lead) {
      const style = getComputedStyle(bar);
      const inner =
        box.width -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight) -
        parseFloat(style.borderLeftWidth) -
        parseFloat(style.borderRightWidth);
      const want = Math.min(
        inner,
        16 * parseFloat(getComputedStyle(lead).fontSize),
      );
      const got = lead.getBoundingClientRect().width;
      if (got < want - slack)
        out.push(
          `${name}: the text on the left is ${Math.round(got)}px, narrower than ${Math.round(want)}px`,
        );
    }
  }
  return out;
}

function text(el: HTMLElement): string {
  return (el.textContent ?? "").trim().slice(0, 40);
}
