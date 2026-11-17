import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { leadPulse } from "../src/lead-pulse.ts";
import { MIN, setup } from "./mini-quiet-setup.ts";

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
    s.seed("fresh");
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
    s.seed("fresh");
    s.mini(20 * 60);
    s.w.reviewer = () => ({ code: 1, stdout: "" });
    await s.check();
    await s.check();
    expect(s.sent()).toHaveLength(2);
    expect(s.marker().seen).toBe("fresh");
    s.w.reviewer = () => ({ code: 0, stdout: "SENT 1" });
    await s.check();
    await s.check();
    expect(s.sent()).toHaveLength(3);
    expect(s.marker().seen).toBe("stale");
    expect(s.notes.filter((n) => n.startsWith("room not told"))).toHaveLength(2);
  });

  test("the pulse runs the check first: a stale macmini tells the room and a failing sender does not stop the pulse", async () => {
    const s = setup();
    s.seed("fresh");
    s.mini(30 * 60);
    s.w.reviewer = () => {
      throw new Error("spawn ENOENT");
    };
    s.fetchedAt(s.w.clock);
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
    s.fetchedAt(s.w.clock);
    const pulse = await leadPulse(s.d, s.env);
    expect(pulse.alive).toBe(true);
    expect(readFileSync(join(s.state, "lead-pulse.log"), "utf8")).toContain("macmini pulse not read:");
  });

  test("a fetch that failed judges nothing: an old copy on disk is not the macmini going quiet, and it is logged once", async () => {
    const s = setup();
    s.seed("fresh");
    s.mini(5 * 60 * 60);
    await s.check(null);
    await s.check(null);
    s.fetchedAt(null);
    const pulse = await leadPulse(s.d, s.env);
    expect(pulse.alive).toBe(true);
    expect(s.sent()).toEqual([]);
    expect(s.notes).toEqual(["macmini records were not fetched this run: its pulse was not judged"]);
    await s.check();
    expect(s.sent()).toEqual([["맥미니가 300분째 조용해"]]);
  });

  test("a failed fetch in the middle of an incident neither repeats the line nor forgets that it was sent", async () => {
    const s = setup();
    s.seed("fresh");
    s.mini(20 * 60);
    await s.check();
    await s.check(null);
    await s.check();
    expect(s.sent()).toHaveLength(1);
    expect(s.marker()).toEqual({ seen: "stale", fetched: true });
    await s.check(null);
    expect(s.notes.filter((n) => n.startsWith("macmini records were not fetched"))).toHaveLength(2);
  });

  test("staleness is judged at the time of the fetch, not at the time of the check", async () => {
    const s = setup();
    s.mini(20 * 60);
    await s.check(s.w.clock - 10 * 60_000);
    expect(s.sent()).toEqual([]);
    expect(s.marker().seen).toBe("fresh");
    s.w.clock += 60 * MIN;
    await s.check(s.w.clock - 59 * 60_000);
    expect(s.sent()).toEqual([["맥미니가 21분째 조용해"]]);
  });
});
