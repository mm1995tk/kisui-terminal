// ShellApi の本物。Tauri のコマンドとイベントを呼ぶ。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { ShellApi } from "./api.ts";
import type { ConfigMachine } from "./machines.ts";

export const tauriShell: ShellApi = {
  listSshHosts: () => invoke<string[]>("list_ssh_hosts"),
  configMachines: () => invoke<ConfigMachine[]>("config_machines"),
  connect: (id, target) => invoke("connect", { id, target }),
  send: (id, text) => invoke("send", { id, text }),
  disconnect: (id) => invoke("disconnect", { id }),
  installPlan: () => invoke("install_plan"),
  installRemote: (id, target) => invoke("install_remote", { id, target }),
  installCancel: (id) => invoke("install_cancel", { id }),
  askpassReply: (requestId, value) =>
    invoke("askpass_reply", { requestId, value }),
  onLine: (h) =>
    listen<{ id: string; line: string }>("shj-line", (e) => h(e.payload)),
  onClosed: (h) => listen("shj-closed", (e) => h(e.payload as never)),
  onAskpass: (h) => listen("askpass", (e) => h(e.payload as never)),
  onAskpassDone: (h) => listen<number>("askpass-done", (e) => h(e.payload)),
  onCloseRequest: (h) => listen("close-request", () => h()),
  windowClose: () => invoke("window_close"),
};
