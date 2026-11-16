import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lockDir } from "../src/lock-owner.ts";
import { readRest, type SeatEnv, seatsPath, sendOnSeat } from "../src/writer-seat.ts";

const NOW = Date.parse("2026-11-16T05:00:00Z");

function setup() {
  const home = mkdtempSync("/tmp/dws-");
  mkdirSync(join(home, "state"));
  writeFileSync(seatsPath(home), "# seats\nu0 alpha\nu2 beta\n");
  const meta = join(home, "r.meta.json");
  const calls: string[] = [];
  let t = NOW;
  const env = (runMeta: (account: string) => [number, object]): SeatEnv => ({
    root: home,
    pid: process.pid,
    now: () => t,
    alive: (pid) => pid === process.pid,
    sleep: async (ms) => {
      t += ms;
    },
    log: () => {},
    run: async (args) => {
      const account = args[args.indexOf("--account") + 1]!;
      calls.push(account);
      expect(existsSync(join(lockDir(home, `carbon-${account}`), "owner"))).toBe(true);
      const [code, m] = runMeta(account);
      writeFileSync(meta, JSON.stringify({ status: code ? "fail" : "ok", modelLabel: "Argon 높음", ...m }));
      return code;
    },
  });
  const opts = { home, lane: "t", model: "argon" as const, prompt: "p", out: "o.txt", meta, timeout: 5 };
  return { home, meta, calls, env, opts };
}

describe("writer seat", () => {
  test("a seat whose lock another live lane holds is skipped for the free one, and the meta names it", async () => {
    const { home, meta, calls, env, opts } = setup();
    mkdirSync(lockDir(home, "carbon-u0"));
    writeFileSync(join(lockDir(home, "carbon-u0"), "owner"), `other 2026-11-16 14:00:00 pid=${process.pid}\n`);
    const { code, seat } = await sendOnSeat(
      env(() => [0, {}]),
      opts,
    );
    expect([code, seat.account, calls]).toEqual([0, "u2", ["u2"]]);
    expect(JSON.parse(readFileSync(meta, "utf8")).seat).toMatchObject({ account: "u2", expect: "beta" });
    expect(existsSync(lockDir(home, "carbon-u2"))).toBe(false);
  });

  test("an on-screen limit before sending rests that seat until the shown reset and moves the request on", async () => {
    const { home, calls, env, opts } = setup();
    const limit = {
      limitText: "한도가 11월 16일 오후 12:23에 초기화됩니다",
      limitResetAt: "2026-11-16T15:23:00+09:00",
    };
    const { seat } = await sendOnSeat(
      env((a) => (a === "u0" ? [16, limit] : [0, {}])),
      opts,
    );
    expect([seat.account, calls]).toEqual(["u2", ["u0", "u2"]]);
    expect(readRest(home, "u0")).toMatchObject({ limitText: limit.limitText, until: "2026-11-16T06:23:00.000Z" });
    // The next request skips the resting seat without opening it.
    calls.length = 0;
    await sendOnSeat(
      env(() => [0, {}]),
      opts,
    );
    expect(calls).toEqual(["u2"]);
  });

  test("a slow or failed run without a limit notice never rests the seat or resends", async () => {
    const { home, calls, env, opts } = setup();
    const { code } = await sendOnSeat(
      env(() => [3, {}]),
      opts,
    );
    expect([code, calls, readRest(home, "u0")]).toEqual([3, ["u0"], undefined]);
  });
});
