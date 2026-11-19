import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { seatStatePath } from "../src/writer-seat-log.ts";
import { type SeatEnv, SeatGone, seatsPath, sendOnSeat } from "../src/writer-seat.ts";

function setup(seats = "u0 alpha\n") {
  const home = mkdtempSync("/tmp/dwsg-");
  mkdirSync(join(home, "state"));
  writeFileSync(seatsPath(home), seats);
  let t = Date.parse("2026-11-16T05:00:00Z");
  const calls: string[] = [];
  const sleeps: number[] = [];
  const env: SeatEnv = {
    root: home,
    pid: process.pid,
    now: () => t,
    alive: (pid) => pid === process.pid,
    sleep: async (ms) => {
      sleeps.push(ms);
      // A disconnected seat is never called again, so any wait here is the endless one this refuses instead.
      if (sleeps.length > 2) throw new Error(`waited ${sleeps.length} times with no seat left to call`);
      t += ms;
    },
    log: () => {},
    run: async (args, onSpawn) => {
      calls.push(args[args.indexOf("--account") + 1]!);
      t += 1000;
      onSpawn(process.pid);
      return 15;
    },
  };
  const opts = {
    home,
    lane: "t",
    model: "argon" as const,
    prompt: "p",
    out: join(home, "o.txt"),
    meta: join(home, "r.meta.json"),
    timeout: 5,
  };
  return { home, calls, sleeps, env, opts };
}

describe("every seat disconnected", () => {
  test("a single seat that exits 15 leaves the next send refusing at once, not waiting", async () => {
    const { home, calls, sleeps, env, opts } = setup("u0 alpha\n");
    const first = await sendOnSeat(env, opts).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(SeatGone);
    expect((first as SeatGone).code).toBe(15);
    expect(calls).toEqual(["u0"]);
    // The mark is the only way out, so the message names the file a person clears.
    expect((first as SeatGone).message).toContain(seatStatePath(home, "u0"));
    // Nothing was waited for: the next send refuses on the first pass.
    expect(sleeps).toEqual([]);
  });

  test("two seats both marked disconnected refuse with 15 and never call or sleep", async () => {
    const { home, calls, sleeps, env, opts } = setup("u0 alpha\nu2 beta\n");
    for (const a of ["u0", "u2"])
      writeFileSync(seatStatePath(home, a), JSON.stringify({ connected: false, why: "exit 15", seenAt: "x" }));
    const err = await sendOnSeat(env, opts).catch((e: unknown) => e);
    expect((err as SeatGone).code).toBe(15);
    expect([calls, sleeps]).toEqual([[], []]);
    expect((err as SeatGone).message).toContain(seatStatePath(home, "u2"));
  });

  test("a corrupt state file is reported, not thrown, and leaves no half written mark", async () => {
    const { home, env, opts } = setup();
    writeFileSync(seatStatePath(home, "u0"), "{not json");
    const err = await sendOnSeat(env, opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SeatGone);
    expect((err as SeatGone).message).toContain("unreadable state file");
    // A mark is written through a temp file and renamed, so nothing is left half done.
    const { markSeat } = await import("../src/writer-seat-log.ts");
    markSeat(home, "u0", false, "exit 15", Date.now());
    expect(JSON.parse(readFileSync(seatStatePath(home, "u0"), "utf8")).why).toBe("exit 15");
    expect(() => readFileSync(seatStatePath(home, "u0.tmp"), "utf8")).toThrow();
  });
});
