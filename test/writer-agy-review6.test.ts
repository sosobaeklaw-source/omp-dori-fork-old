import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { quotaResetMs } from "../src/agy-own.ts";
import { lockDir } from "../src/lock-owner.ts";
import { EXIT, sendOnAgy, stopPath } from "../src/writer-agy.ts";
import { ok, setup } from "./agy-fake.ts";

const shellTsv = process.env["GEMINI_CALLS_TSV"];
afterEach(() => {
  if (shellTsv === undefined) delete process.env["GEMINI_CALLS_TSV"];
  else process.env["GEMINI_CALLS_TSV"] = shellTsv;
});

describe("agy seat, sixth review", () => {
  test("the seat's account is the configured one, not a mail in the code", async () => {
    const { env, opts, calls } = setup([ok("본문")], "c@example.com");
    env.seatAccount = "c@example.com";
    expect(await sendOnAgy(env, opts)).toBe(EXIT.ok);
    expect(calls).toHaveLength(1);
  });

  test("no configured account refuses before any call, without stopping the seat", async () => {
    const { env, opts, calls, home } = setup([ok("본문")]);
    env.seatAccount = undefined;
    await expect(sendOnAgy(env, opts)).rejects.toMatchObject({ code: EXIT.account });
    expect(calls).toHaveLength(0);
    expect(existsSync(stopPath(home))).toBe(false);
  });

  test("a stopped seat still clears --out and --meta, so an old answer is never read as this one", async () => {
    const { env, opts, home } = setup([ok("본문")]);
    writeFileSync(stopPath(home), '{"why":"test"}\n');
    writeFileSync(opts.out, "지난번 답\n");
    writeFileSync(opts.meta, "{}\n");
    await expect(sendOnAgy(env, opts)).rejects.toMatchObject({ code: EXIT.stopped });
    expect(existsSync(opts.out)).toBe(false);
    expect(existsSync(opts.meta)).toBe(false);
  });

  test("an agy -p stuck outside the lock: the send gives up after --timeout, frees the lock, makes no call", async () => {
    const { env, opts, calls, others, home } = setup([ok("본문")]);
    others.running = true;
    await expect(sendOnAgy(env, opts)).rejects.toMatchObject({ code: EXIT.busy });
    expect(calls).toHaveLength(0);
    expect(existsSync(lockDir(home, "agy-s4"))).toBe(false);
  });

  test("a GEMINI_CALLS_TSV in the shell is not where the seat writes under a test home", async () => {
    const real = join(mkdtempSync("/tmp/dwa-real-"), "calls.tsv");
    process.env["GEMINI_CALLS_TSV"] = real;
    const { env, opts, tsv } = setup([ok("본문")]);
    expect(await sendOnAgy(env, opts)).toBe(EXIT.ok);
    expect(existsSync(real)).toBe(false);
    expect(tsv()).toHaveLength(1);
  });

  test('Google\'s retryDelay "45s" holds the seat 45 s, not the 5-hour fallback', () => {
    expect(quotaResetMs('{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"45s"}')).toBe(45_000);
    expect(quotaResetMs("retryDelay: 12.5s")).toBe(12_500);
  });
});
