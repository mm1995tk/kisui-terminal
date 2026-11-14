import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  mapFrames,
  nextAction,
  pickBye,
  playOnceDuration,
  restingScene,
  sceneFrame,
  travelDuration,
  usableMascot,
  type Mascot,
  type MascotScene,
} from "./mascot.ts";

const scene = (
  frames: string[],
  o: Partial<MascotScene> = {},
): MascotScene => ({
  frames,
  frameMs: 200,
  loop: true,
  speed: 90,
  ...o,
});

const mascot = (o: Partial<Mascot> = {}): Mascot => ({
  carry: scene(["w1", "w2", "w3", "w4"]),
  sigh: null,
  rest: [],
  restAfterMs: 3000,
  bye: [],
  push: null,
  ...o,
});

describe("sceneFrame", () => {
  it("1 コマずつ進み、くり返す場面は最初に戻る（コマの数は自由）", () => {
    const s = scene(["a", "b", "c"]);
    assert.equal(sceneFrame(s, 0), 0);
    assert.equal(sceneFrame(s, 199), 0);
    assert.equal(sceneFrame(s, 200), 1);
    assert.equal(sceneFrame(s, 400), 2);
    assert.equal(sceneFrame(s, 600), 0);
  });

  it("コマの時間を変えられる", () => {
    const s = scene(["a", "b"], { frameMs: 50 });
    assert.equal(sceneFrame(s, 49), 0);
    assert.equal(sceneFrame(s, 50), 1);
    assert.equal(sceneFrame(s, 100), 0);
  });

  it("くり返さない場面は最後のコマで止まる", () => {
    const s = scene(["a", "b", "c"], { loop: false });
    assert.equal(sceneFrame(s, 400), 2);
    assert.equal(sceneFrame(s, 10_000), 2);
  });

  it("負の時間は最初のコマ。1 枚なら静止画", () => {
    assert.equal(sceneFrame(scene(["a", "b"]), -5), 0);
    assert.equal(sceneFrame(scene(["a"]), 1234), 0);
  });
});

describe("travelDuration", () => {
  it("時間は距離に比例し、速さに反比例する", () => {
    assert.equal(travelDuration(0, 90), 0);
    assert.equal(travelDuration(90, 90), 1000);
    assert.equal(travelDuration(400, 90) * 2, travelDuration(800, 90));
    assert.equal(travelDuration(180, 180), 1000);
  });

  it("負の距離・使えない速さは 0", () => {
    assert.equal(travelDuration(-10, 90), 0);
    assert.equal(travelDuration(10, 0), 0);
  });
});

describe("場面が無いとき", () => {
  it("一息つく場面が無ければ、運ぶ場面の 1 コマ目で止まる", () => {
    const r = restingScene(mascot());
    assert.deepEqual(r.frames, ["w1"]);
    assert.equal(r.loop, false);
    const sigh = scene(["s1", "s2"], { loop: false });
    assert.equal(restingScene(mascot({ sigh })), sigh);
  });

  it("さようならが無ければ null（その場で消える。運ぶ場面のコマは使わない）", () => {
    assert.equal(pickBye(mascot(), 0.5), null);
  });

  it("さようならは具体から 1 つを選ぶ", () => {
    const a = scene(["wave"]);
    const b = scene(["door"]);
    const m = mascot({ bye: [a, b] });
    assert.equal(pickBye(m, 0), a);
    assert.equal(pickBye(m, 0.49), a);
    assert.equal(pickBye(m, 0.5), b);
    assert.equal(pickBye(m, 0.9999), b);
    assert.equal(pickBye(m, 1), b);
  });

  it("さようならは 1 回再生する長さ", () => {
    assert.equal(
      playOnceDuration(scene(["a", "b", "c"], { frameMs: 100 })),
      300,
    );
  });
});

describe("usableMascot（画像が 1 枚でも読めない場面は無いものとして扱う）", () => {
  const broken = new Set(["bad"]);
  const usable = (f: string) => !broken.has(f);

  it("運ぶ場面が読めなければキャラクターは出ない", () => {
    assert.equal(
      usableMascot(mascot({ carry: scene(["w1", "bad"]) }), usable),
      null,
    );
  });

  it("ほかの場面は、その場面・具体だけを外す", () => {
    const good = scene(["wave"]);
    const m = usableMascot(
      mascot({
        sigh: scene(["s", "bad"]),
        bye: [scene(["bad"]), good],
        rest: [scene(["bad"])],
        push: scene(["bad"]),
      }),
      usable,
    );
    assert.ok(m);
    assert.equal(m.sigh, null);
    assert.deepEqual(m.bye, [good]);
    assert.deepEqual(m.rest, []);
    assert.equal(m.push, null);
  });

  it("番号を URL に直す（全部の場面）", () => {
    const m = mapFrames(
      mascot({ sigh: scene(["1-4"]), bye: [scene(["1-5"])] }),
      (f) => `u:${f}`,
    );
    assert.deepEqual(m.carry.frames, ["u:w1", "u:w2", "u:w3", "u:w4"]);
    assert.deepEqual(m.sigh?.frames, ["u:1-4"]);
    assert.deepEqual(m.bye[0].frames, ["u:1-5"]);
  });
});

describe("nextAction", () => {
  const base = {
    isOpen: true,
    wasOpen: false,
    hasMascot: true,
    reduced: false,
    shown: true,
  };

  it("開いたら運ぶ", () => {
    assert.equal(nextAction(base), "carry");
  });

  it("キャラクターが無いときは出さない", () => {
    assert.equal(nextAction({ ...base, hasMascot: false }), "clear");
  });

  it("視差効果を減らすときは、動かさずに出し、閉じたらその場で消える", () => {
    assert.equal(nextAction({ ...base, reduced: true }), "still");
    assert.equal(
      nextAction({ ...base, reduced: true, isOpen: false, wasOpen: true }),
      "clear",
    );
  });

  it("閉じたとき、出ていればさようなら。出ていなければすぐ消える", () => {
    const closed = { ...base, isOpen: false, wasOpen: true };
    assert.equal(nextAction(closed), "bye");
    assert.equal(nextAction({ ...closed, shown: false }), "clear");
  });

  it("最初から閉じているときは何もしない", () => {
    assert.equal(
      nextAction({ ...base, isOpen: false, wasOpen: undefined }),
      "clear",
    );
  });
});

/** Web Animations の代わり。`animate` で始めた動きと、止められたかを覚える */
function fakeEl(left: number) {
  const el = {
    style: { transform: "" },
    started: [] as { keyframes: { transform: string }[]; cancelled: boolean }[],
    getBoundingClientRect: () => ({ left }),
    animate(keyframes: { transform: string }[]) {
      const rec = { keyframes, cancelled: false };
      el.started.push(rec);
      return {
        cancel: () => {
          rec.cancelled = true;
        },
      };
    },
  };
  return el;
}
const asEl = (e: unknown) => e as HTMLElement;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const offsetOf = (t: string) => Number(/-?[\d.]+/.exec(t)?.[0]);

describe("運ぶ途中に閉じたとき", () => {
  it("さようならは今見えている位置で（移動せずに）始める", async () => {
    const { startCarry, startBye } = await import("./mascotMotion.ts");
    const char = fakeEl(300);
    const stopCarry = startCarry(
      asEl(fakeEl(0)),
      () => asEl(char),
      1000,
      scene(["w"]),
      () => {},
      () => {},
    );
    await wait(5);
    stopCarry();
    const stopBye = startBye(
      () => asEl(char),
      scene(["wave"]),
      () => {},
      () => {},
      () => false,
    );
    await wait(5);
    stopBye();
    // 運び始めたばかり: ほぼ -1000（運び終えた位置の 1000px 左）に留まる
    const at = offsetOf(char.style.transform);
    assert.ok(at < -900 && at > -1000, `at=${at}`);
    // さようならで動かない（新しいアニメーションを始めない）
    assert.equal(char.started.length, 1);
  });

  it("運び終えてから閉じたときは、運び終えた位置のまま", async () => {
    const { carryOffset } = await import("./mascotMotion.ts");
    const d = travelDuration(1000, 90);
    assert.equal(carryOffset(1000, d, 90), 0);
    assert.equal(carryOffset(1000, d * 5, 90), 0);
    assert.equal(carryOffset(1000, 0, 90), -1000);
    assert.equal(carryOffset(1000, d / 2, 90), -500);
  });
});

describe("さようなら", () => {
  it("1 回再生し終えたら消える（くり返す場面でも）", async () => {
    const { startBye } = await import("./mascotMotion.ts");
    const frames: string[] = [];
    let done = 0;
    startBye(
      () => asEl(fakeEl(0)),
      scene(["a", "b"], { frameMs: 20, loop: true }),
      (f) => frames.push(f),
      () => done++,
      () => false,
    );
    await wait(150);
    assert.equal(done, 1);
    assert.equal(frames[0], "a");
    assert.ok(frames.includes("b"));
  });

  it("ダイアログが開いたら、再生を待たずにすぐ消える", async () => {
    const { startBye } = await import("./mascotMotion.ts");
    let done = 0;
    startBye(
      () => asEl(fakeEl(0)),
      scene(["a"], { frameMs: 10_000 }),
      () => {},
      () => done++,
      () => true,
    );
    await wait(5);
    assert.equal(done, 1);
    await wait(50);
    assert.equal(done, 1);
  });

  it("止められた後（開き直した）は、消す知らせを出さない", async () => {
    const { startBye } = await import("./mascotMotion.ts");
    let done = 0;
    const stop = startBye(
      () => undefined,
      scene(["a"], { frameMs: 10 }),
      () => {},
      () => done++,
      () => false,
    );
    stop();
    await wait(40);
    assert.equal(done, 0);
  });
});

describe("止める関数は Web Animations も止める", () => {
  it("運ぶ途中で止めると、案内とキャラクターの動きを cancel する", async () => {
    const { startCarry } = await import("./mascotMotion.ts");
    const menu = fakeEl(0);
    const char = fakeEl(0);
    const stop = startCarry(
      asEl(menu),
      () => asEl(char),
      1000,
      scene(["w1", "w2"]),
      () => {},
      () => {},
    );
    await wait(5);
    assert.equal(menu.started.length, 1);
    assert.equal(char.started.length, 1);
    stop();
    assert.equal(menu.started[0].cancelled, true);
    assert.equal(char.started[0].cancelled, true);
  });

  it("運ぶ時間は、運ぶ場面の速さで決まる", async () => {
    const { startCarry } = await import("./mascotMotion.ts");
    let done = 0;
    startCarry(
      asEl(fakeEl(0)),
      () => asEl(fakeEl(0)),
      10,
      scene(["w"], { speed: 1000 }),
      () => {},
      () => done++,
    );
    await wait(60);
    assert.equal(done, 1);
  });
});
