import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { leadPulse } from "../src/lead-pulse.ts";
import { MIN, setup } from "./mini-quiet-setup.ts";

describe("the macmini's pulse: its two time forms, values that make no sense, and the first look", () => {
  test("the macmini's own file counts in seconds: renewed sends nothing, 20 minutes old tells the room 20 minutes", async () => {
    const s = setup();
    s.seed("fresh");
    s.miniSeconds(60);
    await s.check();
    expect(s.sent()).toEqual([]);
    expect(s.marker().seen).toBe("fresh");
    s.miniSeconds(20 * 60);
    await s.check();
    expect(s.sent()).toEqual([["맥미니가 20분째 조용해"]]);
  });

  test("the file seen at 22:38 on 2026-11-17 (seconds, fetched 61 seconds later) is one minute old and sends nothing", async () => {
    const tonight = {
      at: 1794922648,
      atIso: "2026-11-17T22:37:28+09:00",
      alive: true,
      kind: "herdr",
      address: "wQ:p1",
      openOrders: 125,
      oldestMin: 1060,
      reviveFailed: false,
      failedStarts: 0,
      revivedAt: null,
    };
    for (const marker of ["fresh", null]) {
      const s = setup();
      if (marker) s.seed(marker);
      writeFileSync(join(s.state, "macmini", "lead-alive.json"), JSON.stringify(tonight, null, 2));
      await s.check(1794922709660);
      expect(s.sent()).toEqual([]);
      expect(s.marker().seen).toBe("fresh");
    }
  });

  test("a quiet time over 7 days sends nothing and is noted once; 7 days exactly still counts as quiet", async () => {
    const s = setup();
    s.seed("fresh");
    s.mini((7 * 24 * 60 + 1) * 60);
    await s.check();
    await s.check();
    expect(s.sent()).toEqual([]);
    expect(s.marker().seen).toBe("absurd");
    expect(s.notes).toEqual([
      `macmini lead-alive.json: 시각 값 ${s.w.clock - (7 * 24 * 60 + 1) * 60_000}이 7일보다 오래됨(10081분): 알리지 않음`,
    ]);
    const edge = setup();
    edge.seed("fresh");
    edge.mini(7 * 24 * 60 * 60);
    await edge.check();
    expect(edge.sent()).toEqual([["맥미니가 10080분째 조용해"]]);
  });

  test("a time in the future sends nothing and is noted once; a few minutes ahead is only a clock that differs", async () => {
    const s = setup();
    s.seed("fresh");
    s.mini(-60 * 60);
    await s.check();
    await s.check();
    expect(s.sent()).toEqual([]);
    expect(s.marker().seen).toBe("future");
    expect(s.notes).toEqual([`macmini lead-alive.json: 시각 값 ${s.w.clock + 60 * 60_000}이 미래: 알리지 않음`]);
    const skew = setup();
    skew.mini(-4 * 60);
    await skew.check();
    expect(skew.sent()).toEqual([]);
    expect(skew.marker().seen).toBe("fresh");
  });

  test("a time that is not a positive number is unreadable and sends nothing", async () => {
    for (const body of ['{"at":"1794922648"}', '{"at":0}', '{"at":-5}', '{"at":null}', "{}", "[]"]) {
      const s = setup();
      s.seed("fresh");
      writeFileSync(join(s.state, "macmini", "lead-alive.json"), body);
      await s.check();
      expect(s.sent(), body).toEqual([]);
      expect(s.notes, body).toEqual(["macmini lead-alive.json: 읽지 못함"]);
    }
  });

  test("the first look at a macmini that is already quiet only records it: no line, and the next incident is told", async () => {
    const s = setup();
    s.mini(2 * 60 * 60);
    await s.check();
    await s.check();
    expect(s.sent()).toEqual([]);
    expect(s.marker().seen).toBe("stale");
    expect(s.notes).toEqual(["macmini lead-alive.json: 처음 읽을 때 이미 120분 조용함: 기록만 하고 알리지 않음"]);
    s.mini(0);
    await s.check();
    s.w.clock += 40 * MIN;
    await s.check();
    expect(s.sent()).toEqual([["맥미니가 40분째 조용해"]]);
  });

  test("a first fetch that failed leaves no marker to compare with: the first fetch that works only records", async () => {
    const s = setup();
    s.mini(2 * 60 * 60);
    await s.check(null);
    await s.check();
    expect(s.sent()).toEqual([]);
    expect(s.marker()).toEqual({ seen: "stale", fetched: true });
  });

  test("the first pulse after install tells the room nothing, however old the macmini's file is", async () => {
    for (const secondsOld of [30 * 60, 8 * 24 * 3600]) {
      const s = setup();
      s.mini(secondsOld);
      s.fetchedAt(s.w.clock);
      const pulse = await leadPulse(s.d, s.env);
      expect(pulse.alive).toBe(true);
      expect(s.sent()).toEqual([]);
      expect(readFileSync(join(s.state, "lead-pulse.log"), "utf8")).not.toContain("told the room");
    }
  });
});
