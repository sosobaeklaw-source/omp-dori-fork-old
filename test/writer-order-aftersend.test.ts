import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { holdForQuota } from "../src/agy-own.ts";
import { AgyStop, EXIT } from "../src/writer-agy.ts";
import { sendBody } from "../src/writer-order.ts";
import { type SeatEnv, seatsPath } from "../src/writer-seat.ts";
import { FORBIDDEN, LINKED, OTHER_MAIL, ok, setup as agySetup } from "./agy-fake.ts";

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

describe("order: a stop after the request went out is not sent again", () => {
  test("a quota hold during the retry gap does not send the body to the web", async () => {
    const { env, opts, calls } = agySetup([LINKED]);
    const sleep = env.sleep;
    env.sleep = async (ms) => {
      holdForQuota(opts.home, env.now() + ms + 60_000);
      await sleep(ms);
    };
    writeFileSync(seatsPath(opts.home), "u0 alpha\n");
    const w = web(opts.home);
    const err = await sendBody(env, w.env, opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgyStop);
    expect((err as AgyStop).code).toBe(EXIT.quota);
    expect([calls.length, w.calls]).toEqual([1, []]);
  });

  test("a 403 on the agy call is rethrown as 21 and no web seat gets the body", async () => {
    const { env, opts } = agySetup([FORBIDDEN]);
    writeFileSync(seatsPath(opts.home), "u0 alpha\n");
    const w = web(opts.home);
    const err = await sendBody({ ...env, log: (l) => w.lines.push(l) }, w.env, opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgyStop);
    expect((err as AgyStop).code).toBe(EXIT.forbidden);
    expect(w.calls).toEqual([]);
    // The lane sees the ESCALATE text itself, not a shrunk SKIP line.
    expect(w.lines.some((l) => l.startsWith("SKIP agy-s4"))).toBe(false);
  });

  test("a call missing from agy's run log is rethrown as 25 and no web seat gets the body", async () => {
    const { env, opts } = agySetup([ok("본문")]);
    env.runLog = () => undefined;
    writeFileSync(seatsPath(opts.home), "u0 alpha\n");
    const w = web(opts.home);
    const err = await sendBody(env, w.env, opts).catch((e: unknown) => e);
    expect((err as AgyStop).code).toBe(EXIT.unlogged);
    expect(w.calls).toEqual([]);
  });

  test("another account on that call's run log is rethrown as 24 and no web seat gets the body", async () => {
    const { env, opts } = agySetup([ok("본문")]);
    // The seat's own mail before the call, another one only on this call's run log: the stop is raised after it went out.
    env.runLog = () => `I applyAuthResult: email=${OTHER_MAIL}, x\n`;
    writeFileSync(seatsPath(opts.home), "u0 alpha\n");
    const w = web(opts.home);
    const err = await sendBody(env, w.env, opts).catch((e: unknown) => e);
    expect((err as AgyStop).code).toBe(EXIT.account);
    expect(w.calls).toEqual([]);
  });

  test("an account change after the call is not retried on the web", async () => {
    const { env, opts } = agySetup([ok("본문")]);
    const account = env.account;
    let sent = false;
    const run = env.run;
    env.run = async (...args) => {
      const result = await run(...args);
      sent = true;
      return result;
    };
    env.account = () => (sent ? OTHER_MAIL : account());
    writeFileSync(seatsPath(opts.home), "u0 alpha\n");
    const w = web(opts.home);
    const err = await sendBody(env, w.env, opts).catch((e: unknown) => e);
    expect((err as AgyStop).code).toBe(EXIT.account);
    expect(w.calls).toEqual([]);
  });

  test("an account that differs before the call still falls through to the web seat", async () => {
    const { env, opts } = agySetup([ok("본문")], OTHER_MAIL);
    writeFileSync(seatsPath(opts.home), "u0 alpha\n");
    const w = web(opts.home);
    const sent = await sendBody(env, w.env, opts);
    expect([sent.seat, w.calls]).toEqual(["u0", ["u0"]]);
  });

  test("a stop before the call still falls through to the web seat", async () => {
    const { env, opts } = agySetup([ok("본문")]);
    mkdirSync(join(opts.home, "state"), { recursive: true });
    writeFileSync(join(opts.home, "state", "agy-stopped.json"), JSON.stringify({ why: "403" }));
    writeFileSync(seatsPath(opts.home), "u0 alpha\n");
    const w = web(opts.home);
    const sent = await sendBody(env, w.env, opts);
    expect([sent.seat, w.calls]).toEqual(["u0", ["u0"]]);
  });
});
