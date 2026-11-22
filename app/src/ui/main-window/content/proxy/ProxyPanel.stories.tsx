// プロキシのパネル（#409。ProxyPanel.tsx）を、アプリと同じ部品・CSS・字・翻訳で出す。
import type { Meta, StoryObj } from "storybook-solidjs-vite";

import type { ProxyPanelState } from "../../../../features/proxy/controller.ts";
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
  scope: { target: "@local", scope: "ws:w1", port: 41234, flows },
  selected: 2,
  detail: { id: 2, detail },
  side: "request",
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
      scope: { target: "@local", scope: "ws:w1", port: 41234, flows: [] },
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
