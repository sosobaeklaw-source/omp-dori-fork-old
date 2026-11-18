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

  test("the latest s4 run's 403 shows as forbidden, even from yesterday; another account's 403 does not", () => {
    const dir = mkdtempSync("/tmp/dwa-logs-");
    const err = "E errorreport.go:307] generating and executing: PERMISSION_DENIED (code 403): disabled\n";
    const run = (name: string, mail: string, body: string) =>
      writeFileSync(join(dir, name), `I Print mode: starting\nI applyAuthResult: email=${mail}, x\n${body}`);
    run("cli-20261116_192750.log", OTHER_MAIL, err);
    run("cli-20261115_120000.log", SEAT_MAIL, err);
    expect(usageFromLogs(dir, SEAT_MAIL).forbidden).toBe(true);
    run("cli-20261116_200000.log", SEAT_MAIL, err);
    expect(usageFromLogs(dir, SEAT_MAIL).forbidden).toBe(true);
  });
});
