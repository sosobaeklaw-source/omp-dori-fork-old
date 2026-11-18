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
