import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeStateDir } from "../src/lane-model.ts";
import { leadPulse } from "../src/lead-pulse.ts";
import { miniQuiet } from "../src/mini-quiet.ts";
import { href, World } from "./fake.ts";

const T0 = Date.UTC(2026, 10, 17, 12, 0, 0);
const MIN = 60_000;
const ROOM = "/fake/ompdori-send.sh";

function setup() {
  const w = new World();
  w.clock = T0;
  w.addPane("w1:p1", "idle");
  const d = w.deps();
  d.store.setRole("lead", href("w1:p1"));
  const state = homeStateDir(d.store.root);
  mkdirSync(join(state, "macmini"), { recursive: true });
  const env = { DORI_ROOM_SEND: ROOM };
  const notes: string[] = [];
  const mini = (secondsOld: number) =>
    writeFileSync(
      join(state, "macmini", "lead-alive.json"),
      JSON.stringify({ at: w.clock - secondsOld * 1000, alive: true }),
    );
  const check = () => miniQuiet(d, env, state, (line) => notes.push(line));
  const sent = () => w.calls.filter((c) => c.cmd === ROOM).map((c) => c.argv);
  const marker = () => JSON.parse(readFileSync(join(state, "macmini-pulse.json"), "utf8")) as { seen: string };
  return { w, d, state, env, notes, mini, check, sent, marker };
}

describe("the macmini's pulse, seen from the MacBook", () => {
  test("a pulse renewed within 15 minutes sends nothing", async () => {
    const s = setup();
    s.mini(15 * 60);
    await s.check();
    expect(s.sent()).toEqual([]);
    expect(s.marker().seen).toBe("fresh");
  });

  test("a pulse older than 15 minutes tells the room once per incident, and again only after it was fresh", async () => {
    const s = setup();
    s.mini(15 * 60 + 1);
    await s.check();
    await s.check();
    expect(s.sent()).toEqual([["맥미니가 15분째 조용해"]]);
    s.w.clock += 30 * MIN;
    await s.check();
    expect(s.sent()).toHaveLength(1);
    s.mini(0);
    await s.check();
    expect(s.marker().seen).toBe("fresh");
    s.w.clock += 40 * MIN;
    await s.check();
    expect(s.sent()).toEqual([["맥미니가 15분째 조용해"], ["맥미니가 40분째 조용해"]]);
  });

  test("a missing file sends nothing and is noted once as not received yet", async () => {
    const s = setup();
    await s.check();
    await s.check();
    expect(s.sent()).toEqual([]);
    expect(s.notes).toEqual(["macmini lead-alive.json: 아직 못 받음"]);
  });

  test("a file with no readable time sends nothing", async () => {
    const s = setup();
    writeFileSync(join(s.state, "macmini", "lead-alive.json"), "{half a file");
    await s.check();
    expect(s.sent()).toEqual([]);
    expect(s.notes).toEqual(["macmini lead-alive.json: 읽지 못함"]);
  });

  test("a line that could not be sent is not counted: the next check tries again", async () => {
    const s = setup();
    s.mini(20 * 60);
    s.w.reviewer = () => ({ code: 1, stdout: "" });
    await s.check();
    await s.check();
    expect(s.sent()).toHaveLength(2);
    expect(() => s.marker()).toThrow();
    s.w.reviewer = () => ({ code: 0, stdout: "SENT 1" });
    await s.check();
    await s.check();
    expect(s.sent()).toHaveLength(3);
    expect(s.marker().seen).toBe("stale");
    expect(s.notes.filter((n) => n.startsWith("room not told"))).toHaveLength(2);
  });

  test("the pulse runs the check first: a stale macmini tells the room and a failing sender does not stop the pulse", async () => {
    const s = setup();
    s.mini(30 * 60);
    s.w.reviewer = () => {
      throw new Error("spawn ENOENT");
    };
    const pulse = await leadPulse(s.d, s.env);
    expect(pulse.alive).toBe(true);
    expect(JSON.parse(readFileSync(join(s.state, "lead-alive.json"), "utf8")).alive).toBe(true);
    expect(s.sent()).toEqual([["맥미니가 30분째 조용해"]]);
    expect(readFileSync(join(s.state, "lead-pulse.log"), "utf8")).toContain(
      "room not told, will try again (spawn ENOENT)",
    );
  });

  test("a macmini check that cannot write its marker is logged and the pulse still runs", async () => {
    const s = setup();
    s.mini(30 * 60);
    mkdirSync(join(s.state, "macmini-pulse.json"));
    const pulse = await leadPulse(s.d, s.env);
    expect(pulse.alive).toBe(true);
    expect(readFileSync(join(s.state, "lead-pulse.log"), "utf8")).toContain("macmini pulse not read:");
  });
});
