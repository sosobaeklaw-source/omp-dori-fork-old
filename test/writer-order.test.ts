import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { quotaUntilPath } from "../src/agy-own.ts";
import { lockDir } from "../src/lock-owner.ts";
import { stopPath } from "../src/writer-agy.ts";
import { ok, setup as agySetup } from "./agy-fake.ts";
import { sendBody } from "../src/writer-order.ts";
import { type SeatEnv, seatsPath } from "../src/writer-seat.ts";

function web(home: string) {
  const calls: string[] = [];
  const lines: string[] = [];
  let t = Date.parse("2026-11-16T10:00:00Z");
  const env: SeatEnv = {
    root: home,
    pid: process.pid,
    now: () => t,
    alive: (pid) => pid === process.pid,
    sleep: async (ms) => {
      t += ms;
    },
    log: (l) => lines.push(l),
    run: async (args, onSpawn) => {
      calls.push(args[args.indexOf("--account") + 1]!);
      t += 1000;
      onSpawn(process.pid);
      return 0;
    },
  };
  return { env, calls, lines };
}

describe("writing order", () => {
  test("a busy agy lock sends immediately to the web seat", async () => {
    const { env, opts, calls } = agySetup([]);
    mkdirSync(lockDir(opts.home, "agy-s4"));
    writeFileSync(join(lockDir(opts.home, "agy-s4"), "owner"), `other 2026-11-16 14:00:00 pid=${process.pid}\n`);
    env.sleep = async () => {
      throw new Error("must not wait");
    };
    writeFileSync(seatsPath(opts.home), "u0 alpha\n");
    const w = web(opts.home);
    const sent = await sendBody(env, w.env, opts);
    expect([sent.seat, calls.length, w.calls]).toEqual(["u0", 0, ["u0"]]);
  });

  test("an active agy gap sends immediately to the web seat", async () => {
    const { env, opts, calls } = agySetup([], undefined, {
      lastEndAt: Date.parse("2026-11-16T10:00:00Z"),
      running: false,
      forbidden: false,
    });
    env.sleep = async () => {
      throw new Error("must not wait");
    };
    writeFileSync(seatsPath(opts.home), "u0 alpha\n");
    const w = web(opts.home);
    const sent = await sendBody(env, w.env, opts);
    expect([sent.seat, calls.length, w.calls]).toEqual(["u0", 0, ["u0"]]);
  });

  test("a logged-out agy seat falls back without creating a stop", async () => {
    const { env, opts, calls } = agySetup([]);
    env.account = () => undefined;
    writeFileSync(seatsPath(opts.home), "u0 alpha\n");
    const w = web(opts.home);
    const sent = await sendBody(env, w.env, opts);
    expect([sent.seat, sent.code, calls.length, w.calls, existsSync(stopPath(opts.home))]).toEqual([
      "u0",
      0,
      0,
      ["u0"],
      false,
    ]);
  });

  test("a prior 403 remains visible when falling back to the web", async () => {
    const { env, opts } = agySetup([], undefined, { lastEndAt: 0, running: false, forbidden: true });
    writeFileSync(seatsPath(opts.home), "u0 alpha\n");
    const w = web(opts.home);
    const sent = await sendBody({ ...env, log: (l) => w.lines.push(l) }, w.env, opts);
    expect([sent.seat, existsSync(stopPath(opts.home)), w.lines.some((l) => l.startsWith("ESCALATE"))]).toEqual([
      "u0",
      true,
      true,
    ]);
  });

  test("agy answers first and no web seat is called", async () => {
    const { env, opts, calls } = agySetup([ok("본문")]);
    writeFileSync(seatsPath(opts.home), "u0 alpha\n");
    const w = web(opts.home);
    const sent = await sendBody(env, w.env, opts);
    expect([sent.seat, sent.code, calls.length, w.calls]).toEqual(["agy-s4", 0, 1, []]);
  });

  test("a resting agy seat is skipped and the web seat answers", async () => {
    const { env, opts } = agySetup([ok("본문")]);
    writeFileSync(seatsPath(opts.home), "u2 beta\n");
    mkdirSync(join(opts.home, "state"), { recursive: true });
    writeFileSync(quotaUntilPath(opts.home), `${JSON.stringify({ until: Date.parse("2026-11-16T12:00:00Z") })}\n`);
    const w = web(opts.home);
    const sent = await sendBody({ ...env, log: (l) => w.lines.push(l) }, w.env, opts);
    expect([sent.seat, w.calls, w.lines.some((l) => l.startsWith("SKIP agy-s4"))]).toEqual(["u2", ["u2"], true]);
  });

  test("a disconnected web seat is logged and skipped for the next one", async () => {
    const { env, opts } = agySetup([], "other@example.com");
    writeFileSync(seatsPath(opts.home), "u0 alpha\nu2 beta\n");
    writeFileSync(
      join(opts.home, "state", "writer-seat-u0.json"),
      `${JSON.stringify({ connected: false, why: "screen account differs (exit 15)", seenAt: "2026-11-16T09:00:00Z" })}\n`,
    );
    const w = web(opts.home);
    const sent = await sendBody({ ...env, log: (l) => w.lines.push(l) }, w.env, opts);
    expect(sent.seat).toBe("u2");
    expect(w.calls).toEqual(["u2"]);
    expect(w.lines.some((l) => l.startsWith("SKIP u0:"))).toBe(true);
    expect(readFileSync(join(opts.home, "state", "writer-calls-u2.tsv"), "utf8")).toContain("\tu2\tsuccess\t0");
  });

  test("a web seat with three lost answers is skipped while it rests", async () => {
    const { env, opts } = agySetup([], "other@example.com");
    writeFileSync(seatsPath(opts.home), "u0 alpha\nu2 beta\n");
    const lost = [1, 2, 3].map((i) => `2026-11-16T10:30:0${i}.000Z\tu0\tlost\t14`).join("\n");
    writeFileSync(join(opts.home, "state", "writer-calls-u0.tsv"), `${lost}\n`);
    const w = web(opts.home);
    const sent = await sendBody(env, w.env, opts);
    expect([sent.seat, w.calls]).toEqual(["u2", ["u2"]]);
    expect(w.lines.some((l) => l.startsWith("SKIP u0: resting until"))).toBe(true);
  });
});
