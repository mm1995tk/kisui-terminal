// キャラクターを選ぶ窓（リーダーの `c s`）。`mascot/` の中のキャラクターを名前の順に並べ、j / k（矢印）で選び、
// Enter かダブルクリックで決め、Esc かボタンでやめる。使えないキャラクター（`mascot.toml` が読めない）は、
// 理由を付けて並べ、選べない。窓のキーはマシンを選ぶ窓と同じ（features/sessions/machineList.ts の pickerKey）。決まりは docs/key-design.md。
import { T } from "../../../i18n/index.ts";
import {
  createEffect,
  createResource,
  createSignal,
  For,
  Show,
  type JSX,
} from "solid-js";

import { Button } from "../../components/Button.tsx";
import { KeyFooter } from "../../components/KeyFooter.tsx";
import {
  ModalCard,
  CardBody,
  CardTitle,
  CardText,
} from "../../components/Card.tsx";
import { basicHints } from "../../../features/commands/placeKeys.ts";
import { openKeyList } from "../commands/KeyListDialog.tsx";
import { moveRow, pickerKey } from "../../../features/sessions/machineList.ts";
import type { MascotListing } from "../../../features/mascot/mascot.ts";

const rowId = (i: number) => `mascot-dialog-row-${i}`;

/** 開いたときに選んでおく行（今のキャラクター。無ければ最初の使えるもの、それも無ければ最初） */
export function initialIndex(l: MascotListing): number {
  const cur = l.entries.findIndex((e) => e.name === l.current);
  if (cur >= 0) return cur;
  return Math.max(
    0,
    l.entries.findIndex((e) => e.error === null),
  );
}

/** キャラクターを選ぶ窓。選べたら onChoose（窓を閉じて書くのは呼んだ側）、Esc・ボタンで onCancel を呼ぶ */
export function MascotDialog(props: {
  /** `mascot/` の中のキャラクターの一覧を読む */
  list: () => Promise<MascotListing>;
  onChoose: (name: string) => void;
  onCancel: () => void;
}): JSX.Element {
  // 一覧を読めなかったときは、読めなかった理由を窓に出す
  const [loaded] = createResource<{ l?: MascotListing; failure?: string }>(
    async () => {
      try {
        return { l: await props.list() };
      } catch (e) {
        return { failure: String(e) };
      }
    },
  );
  const listing = () => loaded()?.l;
  const [index, setIndex] = createSignal(0);
  const [note, setNote] = createSignal<string | undefined>();
  let list: HTMLUListElement | undefined;

  // 一覧が届いたら、今のキャラクターを選んでおく
  createEffect(() => {
    const l = listing();
    if (l) setIndex(initialIndex(l));
  });
  createEffect(() => {
    const i = index();
    queueMicrotask(() =>
      list?.children[i]?.scrollIntoView?.({ block: "nearest" }),
    );
  });

  const entries = () => listing()?.entries ?? [];

  function choose(i: number) {
    const e = entries()[i];
    if (!e) return;
    if (e.error)
      setNote(T("mascot.unusable", { name: e.name, error: e.error }));
    else props.onChoose(e.name);
  }

  function onKeyDown(e: KeyboardEvent) {
    const k = pickerKey(e);
    if (!k) return;
    e.preventDefault();
    setNote(undefined);
    if (k.kind === "move") setIndex(moveRow(index(), k.to, entries().length));
    else if (k.kind === "help") openKeyList("picker");
    else choose(index());
  }

  return (
    <ModalCard
      label={T("mascot.label")}
      width={560}
      onCancel={props.onCancel}
      footer={
        <KeyFooter
          note={
            <Show when={note()}>
              {(n) => <CardText role="alert">{n()}</CardText>}
            </Show>
          }
          items={basicHints({ decide: T("basic.decide"), end: "cancel" })}
          actions={
            <Button onClick={props.onCancel}>{T("button.cancelAlt")}</Button>
          }
        />
      }
      header={<CardTitle>{T("mascot.title")}</CardTitle>}
    >
      <div class="machine-dialog">
        <Show
          when={entries().length > 0}
          fallback={
            <CardBody>
              <CardText role="status">
                {loaded.loading
                  ? T("mascot.loading")
                  : (loaded()?.failure ??
                    T("mascot.none", { root: listing()?.root ?? "" }))}
              </CardText>
            </CardBody>
          }
        >
          <ul
            class="card-rows"
            tabIndex={0}
            role="listbox"
            aria-label={T("mascot.listLabel")}
            aria-activedescendant={rowId(index())}
            onKeyDown={onKeyDown}
            ref={(el) => {
              list = el;
              queueMicrotask(() => el.focus());
            }}
          >
            <For each={entries()}>
              {(e, i) => (
                <li
                  id={rowId(i())}
                  class="card-row machine-row"
                  role="option"
                  aria-selected={index() === i() ? "true" : "false"}
                  aria-disabled={e.error ? "true" : undefined}
                  title={e.error ?? undefined}
                  onClick={() => {
                    setNote(undefined);
                    setIndex(i());
                  }}
                  onDblClick={() => choose(i())}
                >
                  <span class="card-row-name">
                    {e.name}
                    <Show when={e.name === listing()?.current}>
                      <span class="machine-row-mark">
                        {T("mascot.current")}
                      </span>
                    </Show>
                  </span>
                  <Show when={e.error}>
                    <span class="card-row-state">
                      {T("mascot.rowUnusable")}
                    </span>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </ModalCard>
  );
}
