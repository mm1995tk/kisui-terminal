// プロキシのパネルの見た目の案（ProxyPanelLooks.stories.tsx）で使う見本のデータ。どの案にも同じデータを渡す。
// *.stories.tsx から名前付きで書き出すと Storybook が story として読むので、普通のファイルに置く（docs/design/storybook.md）。
import type { ProxyPanelState } from "../../../../../features/proxy/controller.ts";
import { draftFrom } from "../../../../../features/proxy/model.ts";
import type {
  ProxyFlow,
  ProxyFlowDetail,
} from "../../../../../infrastructure/rpc/protocol.ts";

const flow = (id: number, over: Partial<ProxyFlow> = {}): ProxyFlow => ({
  id,
  time: Date.UTC(2026, 10, 22, 7, 18, 54) + id * 1300,
  method: "GET",
  scheme: "https",
  host: "api.example.com",
  path: `/v1/items/${id}?expand=owner`,
  status: 200,
  state: "done",
  reqSize: 0,
  respSize: 1536,
  durationMs: 42,
  mime: "application/json",
  ...over,
});

const flows: ProxyFlow[] = [
  flow(1, { host: "example.com", path: "/", mime: "text/html" }),
  flow(2, {
    method: "POST",
    path: "/v1/items",
    status: 201,
    reqSize: 240,
    durationMs: 1234,
  }),
  flow(3, { path: "/v1/items/3/owner", status: 404, respSize: 90 }),
  flow(4, {
    host: "cdn.example.net",
    path: "/assets/app.4f2c.js",
    respSize: 248_320,
    durationMs: 310,
    mime: "text/javascript",
  }),
  flow(5, {
    host: "old.example.org",
    path: "/login",
    status: 502,
    state: "failed",
    error: "x509: certificate has expired",
  }),
  flow(6, {
    host: "nowhere.invalid",
    path: "/",
    status: 0,
    state: "failed",
    error: "dial tcp: no such host",
  }),
  flow(7, { path: "/v1/stream?since=0", status: 0, state: "pending" }),
  flow(8, {
    method: "POST",
    path: "/v1/items",
    status: 201,
    reqSize: 12,
    resentFrom: 2,
  }),
  flow(9, {
    method: "PUT",
    path: "/v1/items/2",
    status: 200,
    reqSize: 64,
    edited: true,
  }),
];

const heldFlow = flow(10, {
  method: "POST",
  path: "/v1/orders",
  status: 0,
  state: "held",
  reqSize: 240,
  respSize: 0,
  durationMs: 0,
  mime: undefined,
});

const detail: ProxyFlowDetail = {
  ...flows[1]!,
  protocol: "HTTP/2.0",
  reqHeaders: [
    ["Accept", "application/json"],
    ["Authorization", "Bearer eyJhbGciOiJIUzI1NiJ9.e30.ZRrHA1JJJW8opsbCGfG"],
    ["Content-Type", "application/json"],
    ["User-Agent", "curl/8.23.0"],
  ],
  respHeaders: [
    ["Content-Type", "application/json; charset=utf-8"],
    ["Date", "Sun, 22 Nov 2026 07:18:54 GMT"],
    ["Cache-Control", "no-store"],
  ],
  reqBody: { size: 240, text: '{"name":"kisui","tags":["terminal","proxy"]}' },
  respBody: {
    size: 1536,
    text: '{\n  "id": 2,\n  "name": "kisui",\n  "tags": ["terminal", "proxy"]\n}',
  },
};

const base = (over: Partial<ProxyPanelState> = {}): ProxyPanelState => ({
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
  selected: undefined,
  detail: undefined,
  side: "request",
  edit: undefined,
  ...over,
});

/** 見せる 4 つの状態。 */
export type LookState = "list" | "detail" | "held" | "edit";

/** 状態ごとのパネルの中身。 */
export const lookPanels: Record<LookState, ProxyPanelState> = {
  // 一覧：まだ何も選んでいない
  list: base(),
  // 通信の中身：POST を選び、応答を見ている
  detail: base({ selected: 2, detail: { id: 2, detail }, side: "response" }),
  // 止めている要求を選んでいる（流す・書き換える・捨てるのボタンが出る）
  held: base({
    scope: {
      target: "@local",
      scope: "ws:w1",
      port: 41234,
      flows: [...flows, heldFlow, { ...heldFlow, id: 11, method: "GET" }],
      holding: true,
    },
    selected: 10,
    detail: {
      id: 10,
      detail: {
        ...detail,
        ...heldFlow,
        respHeaders: [],
        respBody: { size: 0 },
      },
    },
  }),
  // 書き換える欄：選んだ通信の要求を書き換えて送り直す
  edit: base({
    selected: 2,
    detail: { id: 2, detail },
    edit: { draft: draftFrom(detail), held: false, sending: false },
  }),
};
