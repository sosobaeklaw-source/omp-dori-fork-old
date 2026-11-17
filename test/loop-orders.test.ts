import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeStateDir } from "../src/lane-model.ts";
import { ready, startLane } from "../src/lanes.ts";
import { HOUR } from "../src/loop.ts";
import { setup } from "./loop-setup.ts";

const T0 = Date.UTC(2026, 10, 17, 12, 0, 0);
const MIN = 60_000;
const idAt = (minutesAgo: number): string => String(BigInt(T0 - minutesAgo * MIN - 1420070400000) << 22n);

function orders(opts: Parameters<typeof setup>[0] = {}, told: number | null = T0 - 400 * MIN) {
  const s = setup(opts);
  s.w.clock = T0;
  if (told !== null) s.d.store.saveRun({ at: told, told, synced: [], findings: [], started: [], held: [], asked: [] });
  const state = homeStateDir(s.d.store.root);
  mkdirSync(state, { recursive: true });
  const post = (minutesAgo: number, body: string) =>
    appendFileSync(
      join(state, "inbound.log"),
      `INBOUND discord 1 ${idAt(minutesAgo)} from=owner ref=- ${JSON.stringify(body)}\n`,
    );
  const lane = async (key: string, minutesAgo: number, startedAgo: number, finishedAgo?: number) => {
    const brief = join(s.d.store.root, `${key}-brief.md`);
    writeFileSync(brief, `회장님 원문(${idAt(minutesAgo)}): 합성`);
    s.w.clock = T0 - startedAgo * MIN;
    await startLane(s.d, key, brief, { group: "w1" });
    if (finishedAgo !== undefined) {
      s.w.clock = T0 - finishedAgo * MIN;
      await ready(s.d, key, "끝", ["https://github.com/acme/app/pull/3"]);
    }
    s.w.clock = T0;
  };
  const named = async (): Promise<string[]> =>
    (await s.tick({ maxStarts: 0 })).findings.filter((f) => f.startsWith("order "));
  const everything = async (): Promise<string[]> =>
    (await s.tick({ maxStarts: 0 })).findings.filter((f) => f.startsWith("order"));
  return { ...s, state, post, lane, named, everything };
}

describe("hourly loop: open owner orders", () => {
  test("an unanswered order and a promised-only one are named after 30 minutes, an answered or younger one is not", async () => {
    const s = orders();
    s.post(20, "합성 하나");
    s.post(45, "합성 둘");
    s.post(50, "합성 셋");
    s.post(80, "합성 넷");
    appendFileSync(
      join(s.state, "discord-sent.log"),
      `7\tlane\tall\treply=${idAt(50)}\n8\tlane\tall\tcloses=${idAt(80)}\n`,
    );
    expect(await s.named()).toEqual([`order ${idAt(50)} 약속만 50m: 합성 셋`, `order ${idAt(45)} 답없음 45m: 합성 둘`]);
  });

  test("a lane quiet for over an hour on an order is named; one quiet for 50 minutes is not", async () => {
    const s = orders();
    s.post(200, "오래 조용");
    s.post(201, "곧 아님");
    await s.lane("quiet-lane", 200, 90);
    await s.lane("fresh-lane", 201, 50);
    expect(await s.named()).toEqual([`order ${idAt(200)} 일하는중 in quiet-lane, quiet 90m: 오래 조용`]);
  });

  test("a MacBook lane that finished 45 minutes ago names its order until to-macmini.log shows it delivered", async () => {
    const s = orders();
    for (const [i, body] of ["안 넘김", "넘김", "넘기다 실패", "아직 이름"].entries()) s.post(100 + i, body);
    await s.lane("lane-a", 100, 100, 45);
    await s.lane("lane-b", 101, 100, 45);
    await s.lane("lane-c", 102, 100, 45);
    await s.lane("lane-d", 103, 100, 20);
    writeFileSync(
      join(s.state, "to-macmini.log"),
      [
        `2026-11-17T11:30:00Z order=${idAt(101)} DELIVERED ~/sobaegi-lead/inbox/ompdori/x.md`,
        `2026-11-17T11:31:00Z order=${idAt(102)} NOT_DELIVERED ~/sobaegi-lead/inbox/ompdori/y.md`,
      ].join("\n"),
    );
    expect(await s.named()).toEqual([
      `order ${idAt(102)} 결과미전달, lane-c finished 45m ago, not in to-macmini.log: 넘기다 실패`,
      `order ${idAt(100)} 결과미전달, lane-a finished 45m ago, not in to-macmini.log: 안 넘김`,
    ]);
  });

  test("a line is named once, then only every 6 hours, and again at once when its report did not reach the lead", async () => {
    const hours = async (leadDown: (h: number) => boolean): Promise<number[]> => {
      let down = false;
      const s = orders({
        exec: (inner) => async (cmd, argv, o) =>
          down && cmd === "herdr" && argv[0] === "agent" && argv[2] === "w1:p1"
            ? { code: 1, stdout: "", stderr: "lead pane hung" }
            : inner(cmd, argv, o),
      });
      s.post(0, "합성");
      const seen: number[] = [];
      for (let h = 1; h <= 14; h++) {
        s.w.clock = T0 + h * HOUR;
        down = leadDown(h);
        if ((await s.named()).length) seen.push(h);
      }
      return seen;
    };
    expect(await hours(() => false)).toEqual([1, 7, 13]);
    expect(await hours((h) => h === 1)).toEqual([1, 2, 7, 13]);
  });

  test("the loop only names: it closes and edits no order or lane, and talks to nobody but the lead", async () => {
    const s = orders();
    s.post(45, "합성 둘");
    s.post(200, "일하는 중");
    await s.lane("quiet-lane", 200, 90);
    const record = join(s.d.store.root, "lanes", "quiet-lane.json");
    const before = readFileSync(record, "utf8");
    expect((await s.named()).length).toBe(2);
    expect(readFileSync(record, "utf8")).toBe(before);
    expect(existsSync(join(s.state, "orders-closed.log"))).toBe(false);
    expect(readdirSync(s.state).sort()).toEqual(["inbound.log"]);
    expect(s.w.calls.filter((c) => c.cmd !== "herdr")).toEqual([]);
  });

  test("a to-macmini.log that cannot be read is one finding, and the run still reports", async () => {
    const s = orders();
    s.post(45, "합성 둘");
    mkdirSync(join(s.state, "to-macmini.log"));
    const run = await s.tick({ maxStarts: 0 });
    expect(run.findings.filter((f) => f.startsWith("orders: "))).toHaveLength(1);
    expect(run.findings.some((f) => f.startsWith("order "))).toBe(false);
    expect(run.told).toBe(run.at);
  });

  test("many due orders give the count, the 10 oldest and one pointer, never the whole list", async () => {
    const s = orders();
    for (let i = 0; i < 14; i++) s.post(300 - i * 10, `합성 ${i}`);
    const found = await s.everything();
    expect(found).toHaveLength(12);
    expect(found[0]).toBe("orders: 14 due, the 10 oldest below");
    expect(found.slice(1, 11).map((f) => f.split(" ")[1])).toEqual(
      Array.from({ length: 10 }, (_, i) => idAt(300 - i * 10)),
    );
    expect(found[11]).toBe("orders: the whole list is dori orders --mine");
  });

  test("a few due orders are all named, still with the count and the pointer", async () => {
    const s = orders();
    s.post(45, "하나");
    s.post(50, "둘");
    expect(await s.everything()).toEqual([
      "orders: 2 due, the 2 oldest below",
      `order ${idAt(50)} 답없음 50m: 둘`,
      `order ${idAt(45)} 답없음 45m: 하나`,
      "orders: the whole list is dori orders --mine",
    ]);
  });

  test("the first report with no earlier one counts the due orders as told: the count alone, then only what crosses later", async () => {
    const s = orders({}, null);
    for (let i = 0; i < 14; i++) s.post(300 - i * 10, `합성 ${i}`);
    const first = await s.tick({ maxStarts: 0 });
    expect(first.findings.filter((f) => f.startsWith("order"))).toEqual([
      "orders: 14 open orders are already due, none listed on this first report: dori orders --mine",
    ]);
    expect(first.told).toBe(first.at);
    s.post(10, "새 지시");
    s.w.clock += 30 * MIN;
    expect(await s.everything()).toEqual([
      "orders: 1 due, the 1 oldest below",
      `order ${idAt(10)} 답없음 40m: 새 지시`,
      "orders: the whole list is dori orders --mine",
    ]);
    s.w.clock += 30 * MIN;
    expect(await s.everything()).toEqual([]);
  });

  test("a first report that did not reach the lead is a seed again: the lead never gets the backlog dump", async () => {
    let down = true;
    const s = orders(
      {
        exec: (inner) => async (cmd, argv, o) =>
          down && cmd === "herdr" && argv[0] === "agent" && argv[2] === "w1:p1"
            ? { code: 1, stdout: "", stderr: "lead pane hung" }
            : inner(cmd, argv, o),
      },
      null,
    );
    for (let i = 0; i < 14; i++) s.post(300 - i * 10, `합성 ${i}`);
    expect(await s.everything()).toHaveLength(1);
    down = false;
    s.w.clock += HOUR;
    expect(await s.everything()).toHaveLength(1);
  });
});
