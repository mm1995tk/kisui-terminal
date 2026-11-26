// DB の接続を選ぶ窓（ui/main-window/db/DbConnectionPicker.tsx）のキーと、窓の下の段（#486）。
// 動かす・決める・`?` は、ほかの一覧から選ぶ窓と同じ（machineList.ts の pickerKey）。足す・直す・消すは、この窓だけの字（a e d）。
// 画面の仕組み（Solid）に依らないので、node --test で確かめる。決まりは docs/key-design.md。
import type { KeyLike } from "../commands/guiKeys.ts";
import { placeItem, type FooterRow } from "../commands/placeKeys.ts";
import { pickerKey, type PickerKey } from "../sessions/machineList.ts";
import { T } from "../../i18n/index.ts";

/** 窓の中のキーが表す動き。add は手元の PC に接続を足す、edit・remove は選んでいる接続を直す・消す。 */
export type DbPickerKey =
  PickerKey | { kind: "add" } | { kind: "edit" } | { kind: "remove" };

/** 窓の中のキー。入力欄は無いので字をそのまま使う。Alt・Cmd・Ctrl・Shift を重ねた字と、変換中のキーは受けない（pickerKey の分は pickerKey の決まり）。 */
export function dbPickerKey(e: KeyLike): DbPickerKey | null {
  const k = pickerKey(e);
  if (k) return k;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;
  switch (e.key) {
    case "a":
      return { kind: "add" };
    case "e":
      return { kind: "edit" };
    case "d":
      return { kind: "remove" };
  }
  return null;
}

/**
 * 窓の下の段：選んでいる接続に効く操作（直せるなら edit、消せるなら remove）と、この PC の接続の一覧に効く操作（add）。
 * 効かない操作は出さない（行の見出しは出す）。
 */
export function dbPickerFooter(o: {
  editable: boolean;
  removable: boolean;
}): FooterRow[] {
  return [
    {
      title: T("dbPicker.foot.selected"),
      items: [
        ...(o.editable
          ? [placeItem("dbPicker", "e", T("dbPicker.keys.edit"))]
          : []),
        ...(o.removable
          ? [placeItem("dbPicker", "d", T("dbPicker.keys.remove"))]
          : []),
      ],
    },
    {
      title: T("dbPicker.foot.list"),
      items: [placeItem("dbPicker", "a", T("dbPicker.keys.add"))],
    },
  ];
}
