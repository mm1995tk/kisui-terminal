// ワークスペースの名前を変えるのを kisui serve に断られたとき、名前を変える窓に出す理由。
import { ErrorCode, RpcError } from "../rpc/message.ts";

/**
 * workspace.rename を断られた理由を、名前を変える窓に出す文にする。
 * serve は invalid_params の data に `{reason: "too_long", max}` か `{reason: "control_character"}` を載せるので、
 * 知っている理由はそれで日本語にする（上限も serve が教える）。知らない理由（古い serve など）は、メッセージをそのまま返す。
 */
export function renameErrorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (e instanceof RpcError && e.code === ErrorCode.InvalidParams) {
    const d = e.data as { reason?: string; max?: number } | undefined;
    if (d?.reason === "too_long")
      return d.max
        ? `名前が長すぎます（${d.max} 文字まで）`
        : "名前が長すぎます";
    if (d?.reason === "control_character")
      return "名前に改行などの制御文字は使えません";
  }
  return m;
}
