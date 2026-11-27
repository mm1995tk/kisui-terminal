// マシンのダイアログ（MachineDialog.tsx）の Key footer（共通フッタ）に出す、今効く操作。
// 「選んでいるマシン」の行（Enter・n d x r t のうち、選んでいるマシンにできるもの）と、「マシンの一覧」の行（a）。
// 効かない操作（canDo が理由を返すもの）は出さない。選ぶ・移る・Esc・`?` は、どの Dialog でも同じキーなので出さない。
// Enter だけは、選ぶ Dialog の「決める」ではなく、選んだマシンでターミナルのタブを作り始める操作（このダイアログだけの意味）なので出す。
// キーと probes は `?` の一覧の表（placeKeys.ts の machines）から引く（placeItem）。machineFooter.test.ts が、出す操作を machineKey が受けることと、
// 表の操作がどれも（どの Dialog でも同じキーと、同じ操作の別のキーを除き）どこかの状態で Key footer に出ることを確かめる。
import {
  placeItem,
  type FooterItem,
  type FooterRow,
} from "../../../features/commands/placeKeys.ts";
import {
  canDo,
  type MachineAction,
  type MachineRow,
} from "../../../features/sessions/machineList.ts";
import { T } from "../../../i18n/index.ts";

/** 選んでいるマシンへの操作の、表の行の書き方と、名前（i18n のキー）。出す順。 */
const SELECTED: readonly [
  Exclude<MachineAction, "add">,
  string,
  Parameters<typeof T>[0],
][] = [
  ["newTab", "Enter", "machineDialog.keys.newTab"],
  ["rename", "n", "machineDialog.keys.rename"],
  ["remove", "d", "machineDialog.keys.remove"],
  ["disconnect", "x", "machineDialog.keys.disconnect"],
  ["reconnect", "r", "machineDialog.keys.reconnect"],
  ["terminal", "t", "machineDialog.keys.terminal"],
  ["grant", "p", "machineDialog.keys.grant"],
  ["grantEnd", "P", "machineDialog.keys.grantEnd"],
];

/**
 * Dialog の Key footer。
 * - renaming：名前を打っている間。キーは入力欄が受けるので、見出しだけ
 * - selected：選んでいるマシン（無ければ undefined。「選んでいるマシン」の行は見出しだけ）
 * - hasWorkspace：今のワークスペースがあるか（Enter のタブ作成が使う。canDo と同じ）
 */
export function machineDialogFooter(s: {
  renaming: boolean;
  selected: MachineRow | undefined;
  hasWorkspace: boolean;
}): FooterRow[] {
  // 名前を打っている間は、どの行の操作も効かない。行の見出しは出す（行の数が変わると Key footer の高さが変わる）
  const row = s.renaming ? undefined : s.selected;
  const items: FooterItem[] = row
    ? SELECTED.filter(([a]) => canDo(row, a, s.hasWorkspace) === null).map(
        ([, keys, label]) => placeItem("machines", keys, T(label)),
      )
    : [];
  return [
    { title: T("machineDialog.foot.selected"), items },
    {
      title: T("machineDialog.foot.list"),
      items: s.renaming
        ? []
        : [placeItem("machines", "a", T("machineDialog.keys.add"))],
    },
  ];
}
