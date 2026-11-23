// プロキシのパネル（#409。ProxyPanel.tsx）を、アプリと同じ部品・CSS・字・翻訳で出す。
import type { Meta, StoryObj } from "storybook-solidjs-vite";

import type { ProxyPanelState } from "../../../../features/proxy/controller.ts";
import { draftFrom } from "../../../../features/proxy/model.ts";
import { T } from "../../../../i18n/index.ts";
import type {
  ProxyFlow,
  ProxyFlowDetail,
} from "../../../../infrastructure/rpc/protocol.ts";
import { ProxyPanel } from "./ProxyPanel.tsx";

const flow = (id: number, over: Partial<ProxyFlow> = {}): ProxyFlow => ({
  id,
  time: Date.UTC(2026, 10, 22, 7, 18, 54),
  method: "GET",
  scheme: "https",
  host: "example.com",
  path: `/api/items/${id}?expand=owner`,
  status: 200,
  state: "done",
  reqSize: 0,
  respSize: 1536,
  durationMs: 42,
  mime: "application/json",
  ...over,
});

const flows: ProxyFlow[] = [
  flow(1),
  flow(2, { method: "POST", status: 201, reqSize: 240, durationMs: 1234 }),
  flow(3, { status: 404, respSize: 90 }),
  flow(4, {
    status: 502,
    state: "failed",
    error: "x509: certificate has expired",
  }),
  flow(5, { status: 0, state: "failed", error: "dial tcp: no such host" }),
  flow(6, { status: 0, state: "pending" }),
  flow(7, { method: "POST", status: 200, reqSize: 12, resentFrom: 2 }),
];

const detail: ProxyFlowDetail = {
  ...flows[1]!,
  protocol: "HTTP/2.0",
  reqHeaders: [
    ["Accept", "application/json"],
    ["Content-Type", "application/json"],
    ["User-Agent", "curl/8.23.0"],
  ],
  respHeaders: [
    ["Content-Type", "application/json; charset=utf-8"],
    ["Date", "Sun, 22 Nov 2026 07:18:54 GMT"],
  ],
  reqBody: { size: 240, text: '{"name":"kisui","tags":["terminal","proxy"]}' },
  respBody: { size: 1536, text: '{\n  "id": 2,\n  "name": "kisui"\n}' },
};

const panel = (over: Partial<ProxyPanelState> = {}): ProxyPanelState => ({
  subject: {
    kind: "term",
    target: "@local",
    scope: "ws:w1",
    tab: "t",
    ws: "w1",
  },
  scope: {
    target: "@local",
    scope: "ws:w1",
    port: 41234,
    flows,
    holding: false,
  },
  selected: 2,
  detail: { id: 2, detail },
  side: "request",
  edit: undefined,
  ...over,
});

const meta = {
  title: "main-window/content/ProxyPanel",
  component: ProxyPanel,
  args: {
    panel: panel(),
    machine: "local",
    onSelect: () => {},
    onStep: () => {},
    onSide: () => {},
    onBack: () => {},
    onClose: () => {},
    onHelp: () => {},
    mac: true,
    onEdit: () => {},
    onDraft: () => {},
    onSend: () => {},
    onCancelEdit: () => {},
    onHold: () => {},
    onRelease: () => {},
    focusRef: () => {},
  },
  decorators: [
    (Story) => (
      // パネルは、右のペイン（.main）の右側の --proxy-panel-w を使う
      <div
        style={{
          position: "relative",
          height: "560px",
          "--proxy-panel-w": "60%",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ProxyPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** ターミナルのタブ。通信を選んで、要求を出している。 */
export const Request: Story = {};

/** 応答の側。 */
export const Response: Story = { args: { panel: panel({ side: "response" }) } };

/** まだ何も通っていないターミナルのタブ。 */
export const EmptyTerminal: Story = {
  args: {
    panel: panel({
      scope: {
        target: "@local",
        scope: "ws:w1",
        port: 41234,
        flows: [],
        holding: false,
      },
      selected: undefined,
      detail: undefined,
    }),
  },
};

/** ブラウザのタブ。何も選んでいない。字でない本文。 */
export const Browser: Story = {
  args: {
    panel: panel({
      subject: {
        kind: "browser",
        target: "@local",
        scope: "browser:t1",
        tab: "b",
        browserTab: "t1",
      },
      selected: 1,
      detail: {
        id: 1,
        detail: {
          ...detail,
          ...flows[0]!,
          respBody: { size: 20480, binary: true },
        },
      },
      side: "response",
    }),
  },
};

/** 選んだ通信の要求を書き換えている（#410。パネルの e）。 */
export const Editing: Story = {
  args: {
    panel: panel({
      edit: { draft: draftFrom(detail), held: false, sending: false },
    }),
  },
};

/** 書き換えた要求を送れなかった（ヘッダーの形が違う）。 */
export const EditingWithError: Story = {
  args: {
    panel: panel({
      edit: {
        draft: { ...draftFrom(detail), headers: "Accept application/json" },
        held: false,
        sending: false,
        error: T("proxy.edit.badHeader", { line: 1 }),
      },
    }),
  },
};

const heldFlow = flow(8, {
  method: "POST",
  status: 0,
  state: "held",
  reqSize: 240,
  respSize: 0,
  durationMs: 0,
  mime: undefined,
});

/** 要求を止めるのを入れていて（#411。パネルの i）、止めている要求を選んでいる。流す・書き換える・捨てるを決める。 */
export const Holding: Story = {
  args: {
    panel: panel({
      scope: {
        target: "@local",
        scope: "ws:w1",
        port: 41234,
        flows: [...flows, heldFlow, { ...heldFlow, id: 9, method: "GET" }],
        holding: true,
      },
      selected: 8,
      detail: {
        id: 8,
        detail: {
          ...detail,
          ...heldFlow,
          respHeaders: [],
          respBody: { size: 0 },
        },
      },
    }),
  },
};

/** 止めている要求を書き換えている（#411）。送ると、書き換えたものが元の要求の代わりに流れる。 */
export const EditingHeld: Story = {
  args: {
    panel: panel({
      scope: {
        target: "@local",
        scope: "ws:w1",
        port: 41234,
        flows: [...flows, heldFlow],
        holding: true,
      },
      selected: 8,
      edit: {
        draft: draftFrom({ ...detail, ...heldFlow }),
        held: true,
        sending: false,
      },
    }),
  },
};

/** 狭い幅（右のペインが 800px、パネルが 360px）。大きさと時間の列をやめ、ホストとパスに幅を回す。 */
export const Narrow: Story = {
  args: { panel: panel({ selected: undefined, detail: undefined }) },
  decorators: [
    (Story) => (
      <div
        style={{
          position: "relative",
          width: "800px",
          height: "560px",
          "--proxy-panel-w": "360px",
        }}
      >
        <Story />
      </div>
    ),
  ],
};

/** 狭い幅で、止めている要求を選んでいる（#422）。ボタンの字は 1 行、頭の待ち受け口は読め、説明は細かく折り返さない。 */
export const HoldingNarrow: Story = {
  args: Holding.args,
  decorators: Narrow.decorators,
};
