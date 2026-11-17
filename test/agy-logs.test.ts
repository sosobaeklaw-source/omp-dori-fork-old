import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountFromLog, usageFromLogs } from "../src/agy-logs.ts";
import { OTHER_MAIL, SEAT_MAIL } from "./agy-fake.ts";

describe("agy logs", () => {
  test("the account comes from agy's last applyAuthResult log line", () => {
    const dir = mkdtempSync("/tmp/dwa-log-");
    const log = join(dir, "cli.log");
    writeFileSync(
      log,
      `x applyAuthResult: email=a@b.c, authMethod=consumer\ny applyAuthResult: email=${SEAT_MAIL}, authMethod=consumer\n`,
    );
    expect(accountFromLog(log)).toBe(SEAT_MAIL);
    expect(accountFromLog(join(dir, "none.log"))).toBeUndefined();
  });

  test("usage reads s4 print runs from agy's run logs, whichever lane made them, and agy -p in ps", () => {
    const dir = mkdtempSync("/tmp/dwa-logs-");
    const run = (name: string, mail: string, print = true) =>
      writeFileSync(
        join(dir, name),
        `${print ? "I printmode.go] Print mode: starting\n" : ""}I applyAuthResult: email=${mail}, authMethod=consumer\n`,
      );
    run("cli-20261116_193156.log", SEAT_MAIL);
    run("cli-20261116_195141.log", SEAT_MAIL);
    run("cli-20261116_192750.log", OTHER_MAIL);
    run("cli-20261116_195513.log", SEAT_MAIL, false);
    run("cli-20261115_120000.log", SEAT_MAIL);
    const ps = "/bin/zsh\nagy\nagy -p request.md을 읽고 --model gemini-4-argon-high\n";
    const u = usageFromLogs(dir, ps, SEAT_MAIL);
    expect(u.lastEndAt).toBeGreaterThan(0);
    expect(u.running).toBe(true);
    expect(usageFromLogs(dir, "/bin/zsh\nagy\n", SEAT_MAIL).running).toBe(false);
  });

  test("an agy print run counts as running wherever its print flag sits on the command line", () => {
    const dir = mkdtempSync("/tmp/dwa-logs-");
    const running = (ps: string) => usageFromLogs(dir, ps, SEAT_MAIL).running;
    expect(running("/Users/x/.local/bin/agy --model gemini-4-argon-high -p 본문\n")).toBe(true);
    expect(running("agy --sandbox --print=hi\n")).toBe(true);
    expect(running("agy\n/bin/zsh -c agy-tool -p x\nagy --help\n")).toBe(false);
  });

  test("the latest s4 run's 403 shows as forbidden, even from yesterday; another account's 403 does not", () => {
    const dir = mkdtempSync("/tmp/dwa-logs-");
    const err = "E errorreport.go:307] generating and executing: PERMISSION_DENIED (code 403): disabled\n";
    const run = (name: string, mail: string, body: string) =>
      writeFileSync(join(dir, name), `I Print mode: starting\nI applyAuthResult: email=${mail}, x\n${body}`);
    run("cli-20261116_192750.log", OTHER_MAIL, err);
    run("cli-20261115_120000.log", SEAT_MAIL, err);
    expect(usageFromLogs(dir, "", SEAT_MAIL).forbidden).toBe(true);
    run("cli-20261116_200000.log", SEAT_MAIL, err);
    expect(usageFromLogs(dir, "", SEAT_MAIL).forbidden).toBe(true);
  });
});
