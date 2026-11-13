// ワークスペースの名前を変えるのを kisui serve に断られたとき、名前を変える窓に出す理由。
// serve の理由は英語なので、知っているものは日本語にする。知らない理由はそのまま出す。
import { ErrorCode, RpcError } from "../rpc/message.ts";

export function renameErrorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (e instanceof RpcError && e.code === ErrorCode.InvalidParams) {
    if (m.includes("too long")) return "名前が長すぎます（100 文字まで）";
    if (m.includes("control character"))
      return "名前に改行などの制御文字は使えません";
  }
  return m;
}
