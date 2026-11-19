// 組み合わせの例：右下の知らせ（UpdateBar.tsx。新しい版）を、アプリと同じ部品・CSS・字・翻訳で出す（#315）。
// 後ろを触れたままのカード（.card-notice）・本文・失敗の理由（.card-error）・処理中のボタン（Button の busy）の組み合わせ。
// 新しい版の持ち物は本物（features/updates/store.ts の createUpdates）で、殻への頼み（UpdatesOs）だけを偽物にする。
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";

import {
  createUpdates,
  type UpdatesOs,
} from "../../../features/updates/store.ts";
import { UpdateBar } from "./UpdateBar.tsx";

/** 殻の「入れ替えて起動し直す」。story ごとに偽物を渡す */
type Args = { install: UpdatesOs["install"] };

/** 答えない（入れ替えている最中のまま） */
const never = () => new Promise<void>(() => {});

/** 新しい版がある殻の偽物と、それを使う本物の持ち物。story を出すたびに作り直す */
function updatesWith(install: UpdatesOs["install"]) {
  return createUpdates({
    check: async () => ({ current: "0.8.2", version: "0.9.0", notes: null }),
    checkNow: async () => ({ status: "latest", current: "0.9.0" }),
    install,
  });
}

const meta = {
  title: "main-window/notifications/UpdateBar",
  // 右下に積む入れ物（Notices.tsx の .card-notices）に入れる
  decorators: [
    (Story) => (
      <div class="card-notices">
        <Story />
      </div>
    ),
  ],
  args: { install: fn(never) },
  render: (args) => <UpdateBar updates={updatesWith(args.install)} />,
} satisfies Meta<Args>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 新しい版がある。「更新して再起動」を押すと、処理中（下の Installing）になる。 */
export const Available: Story = {};

/** 入れ替えている最中。どちらのボタンも押せず、主ボタンの字が変わる。 */
export const Installing: Story = {
  render: (args) => {
    const u = updatesWith(args.install);
    void u.install();
    return <UpdateBar updates={u} />;
  },
};

/** 入れ替えに失敗した。理由を等幅で出し、もう一度押せる。 */
export const Failed: Story = {
  args: {
    install: fn(() =>
      Promise.reject(new Error("signature verification failed")),
    ),
  },
  render: (args) => {
    const u = updatesWith(args.install);
    void u.install();
    return <UpdateBar updates={u} />;
  },
};
