import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runLogFor, usageFromLogs } from "../src/agy-logs.ts";
import { EXIT, sendOnAgy, stopPath } from "../src/writer-agy.ts";
import { OTHER_MAIL, ok, SEAT_MAIL, setup } from "./agy-fake.ts";

const S4 = SEAT_MAIL;
const ERR = "E errorreport.go:307] generating and executing: PERMISSION_DENIED (code 403): disabled\n";
function logs() {
  const dir = mkdtempSync("/tmp/dwa-logs-");
  const run = (name: string, mails: string[], body = "", ws = "/tmp/x") =>
    writeFileSync(
      join(dir, name),
      `I server.go] Creating CLI server backend: product=antigravity workspaceDirs=[${ws}] appDataDir=/a\n` +
        `I Print mode: starting\n${mails.map((m) => `I applyAuthResult: email=${m}, x\n`).join("")}${body}`,
    );
  return { dir, run };
}

describe("agy log reading binds each run to its account, day and call", () => {
  test("an s4 403 stays forbidden past midnight until a later s4 run succeeds", () => {
    const { dir, run } = logs();
    run("cli-20261116_235000.log", [S4], ERR);
    run("cli-20261117_000500.log", [OTHER_MAIL]);
    expect(usageFromLogs(dir, S4).forbidden).toBe(true);
    run("cli-20261117_001500.log", [S4]);
    expect(usageFromLogs(dir, S4).forbidden).toBe(false);
  });

  test("this call's own run log is found by its work folder, not by being the newest", () => {
    const { dir, run } = logs();
    run("cli-20261116_190000.log", [S4], "mine", "/private/tmp/agy-w-AbC123");
    run("cli-20261116_190100.log", [S4], "other", "/tmp/agy-w-ZzZ999");
    expect(runLogFor(dir, "/tmp/agy-w-AbC123")).toContain("mine");
    expect(runLogFor(dir, "/tmp/agy-w-none")).toBeUndefined();
  });
  test("the name the seat writes is the name the 403 scan reads, and a later clean seat run clears it", async () => {
    const { dir, run } = logs();
    const { env, opts, calls } = setup([ok("")]);
    env.logDir = dir;
    env.usage = () => usageFromLogs(dir, S4);
    env.run = async (args) => {
      const logFile = args[args.indexOf("--log-file") + 1] ?? "";
      run(logFile.slice(dir.length + 1), [S4], ERR);
      calls.push({ at: env.now(), args, request: "" });
      return { code: 1, stdout: JSON.stringify({ status: "ERROR", response: "", error: "code 403" }), stderr: "" };
    };
    await expect(sendOnAgy(env, opts)).rejects.toMatchObject({ code: EXIT.forbidden });
    const written = calls[0]?.args[calls[0].args.indexOf("--log-file") + 1] ?? "";
    expect(written.slice(dir.length + 1)).toMatch(/^cli-\d{8}_\d{6}-agy-w-.+\.log$/);
    expect(usageFromLogs(dir, S4).forbidden).toBe(true);
    const stamp = written.slice(dir.length + 5, dir.length + 20);
    const [day, time] = [stamp.slice(0, 8), stamp.slice(9)];
    const bumped = String(Number(time) + 1).padStart(6, "0");
    run(`cli-${day}_${bumped}-agy-w-ZzZ999.log`, [S4]);
    expect(usageFromLogs(dir, S4).forbidden).toBe(false);
  });

  test("a clean seat run clears a 403 an outside call left in a plain log", () => {
    const { dir, run } = logs();
    run("cli-20261118_163623.log", [S4], ERR);
    expect(usageFromLogs(dir, S4).forbidden).toBe(true);
    run("cli-20261118_163724-agy-w-AbC123.log", [S4]);
    expect(usageFromLogs(dir, S4).forbidden).toBe(false);
  });

  test("two runs that share one timestamped log name each keep their own text", () => {
    const { dir, run } = logs();
    run("cli-20261118_163623-agy-w-AbC123.log", [S4], "first", "/tmp/agy-w-AbC123");
    run("cli-20261118_163623-agy-w-ZzZ999.log", [S4], "second", "/tmp/agy-w-ZzZ999");
    expect(runLogFor(dir, "/tmp/agy-w-AbC123")).toContain("first");
    expect(runLogFor(dir, "/tmp/agy-w-ZzZ999")).toContain("second");
    expect(runLogFor(dir, "/tmp/agy-w-AbC123")).not.toContain("second");
  });
  test("two calls that start in the same second each get their own log and both pass", async () => {
    const { dir, run } = logs();
    const { home, env, opts, calls } = setup([ok("하나"), ok("둘")]);
    env.logDir = dir;
    env.run = async (args, cwd) => {
      const logFile = args[args.indexOf("--log-file") + 1] ?? "";
      run(logFile.slice(dir.length + 1), [S4], "own", cwd);
      calls.push({ at: env.now(), args, request: "" });
      return ok("본문");
    };
    env.runLog = (p) => runLogFor(dir, p);
    const b = { ...opts, lane: "b", out: join(home, "b.txt"), meta: join(home, "b.meta.json") };
    const [ra, rb] = await Promise.all([sendOnAgy(env, opts), sendOnAgy(env, b)]);
    expect([ra, rb]).toEqual([EXIT.ok, EXIT.ok]);
    expect(existsSync(stopPath(home))).toBe(false);
    const names = calls.map((c) => c.args[c.args.indexOf("--log-file") + 1]);
    expect(new Set(names).size).toBe(2);
  });
});

describe("the seat calls only as its configured mail, checked on this call's own log", () => {
  test("the seat mail's name on another domain stops the seat before any call", async () => {
    const { env, opts, calls, home } = setup([ok("본문")], "seat@example.org");
    await expect(sendOnAgy(env, opts)).rejects.toMatchObject({ code: EXIT.account });
    expect(calls).toHaveLength(0);
    expect(existsSync(stopPath(home))).toBe(true);
  });

  for (const [why, text] of [
    ["another account", `I applyAuthResult: email=${OTHER_MAIL}, x\n`],
    ["no account line", "I Print mode: starting\n"],
    ["s4 mixed with another account", `I applyAuthResult: email=${S4}, x\nI applyAuthResult: email=a@b.c, x\n`],
  ] as const) {
    test(`this call's own run log with ${why} stops the seat and keeps no answer`, async () => {
      const { env, opts, home } = setup([ok("본문")]);
      env.runLog = () => text;
      await expect(sendOnAgy(env, opts)).rejects.toMatchObject({ code: EXIT.account });
      expect(existsSync(opts.out)).toBe(false);
      expect(existsSync(stopPath(home))).toBe(true);
    });
  }

  test("no run log for this call stops the seat even when another lane's run is in agy's logs", async () => {
    const { env, opts, home } = setup([ok("본문")]);
    env.runLog = () => undefined;
    await expect(sendOnAgy(env, opts)).rejects.toMatchObject({ code: EXIT.unlogged });
    expect(existsSync(opts.out)).toBe(false);
    expect(existsSync(stopPath(home))).toBe(true);
  });
});
