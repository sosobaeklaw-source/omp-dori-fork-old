/** The fake agy environment the agy seat tests share: time, lock, account and usage are all in memory. */
import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lockDir } from "../src/lock-owner.ts";
import type { AgyEnv, AgyRun } from "../src/writer-agy.ts";

/** Stand-ins for the seat's account and another one; real mails stay in local config, never in tests. */
export const SEAT_MAIL = "seat@example.com";
export const OTHER_MAIL = "other@example.com";
export const NOW = Date.parse("2026-11-16T10:00:00Z");
export const ok = (response: string): AgyRun => ({
  code: 0,
  stdout: JSON.stringify({ status: "SUCCESS", response }),
  stderr: "",
});
export const LINKED = ok(
  "[implementation_plan.md](file:///Users/x/.gemini/antigravity-cli/brain/1/implementation_plan.md)에 정리했습니다.",
);
export const FORBIDDEN: AgyRun = {
  code: 1,
  stdout: JSON.stringify({
    status: "ERROR",
    response: "",
    error: "This service has been disabled in this account for violation of Terms of Service.",
  }),
  stderr: 'AGY_ERROR: {"status":"PERMISSION_DENIED","error_code":403}',
};

/** `others` stands for s4 runs other lanes made outside this seat, which agy's own logs show. */
export function setup(
  answers: AgyRun[],
  account = SEAT_MAIL,
  others = { lastEndAt: 0, running: false, forbidden: false },
) {
  const home = mkdtempSync("/tmp/dwa-");
  mkdirSync(join(home, "state"));
  const prompt = join(home, "req.txt");
  writeFileSync(prompt, "본문 요청");
  const calls: { at: number; args: readonly string[]; request: string }[] = [];
  let t = NOW;
  const env: AgyEnv = {
    root: home,
    pid: process.pid,
    now: () => t,
    alive: (pid) => pid === process.pid,
    sleep: async (ms) => {
      t += ms;
    },
    log: () => {},
    account: () => account,
    seatAccount: SEAT_MAIL,
    usage: () => ({ ...others }),
    runLog: () => `I Print mode: starting\nI applyAuthResult: email=${account}, x\n`,
    run: async (args, cwd, onSpawn) => {
      onSpawn(process.pid);
      expect(readFileSync(join(lockDir(home, "agy-s4"), "owner"), "utf8")).toContain(`cmd=${process.pid}`);
      calls.push({ at: t, args, request: readFileSync(join(cwd, "request.md"), "utf8") });
      t += 30_000;
      others.lastEndAt = t;
      return answers.shift() ?? ok("");
    },
  };
  const callLog = join(home, "state", "gemini-calls.tsv");
  const opts = {
    home,
    lane: "t",
    prompt,
    out: join(home, "o.txt"),
    meta: join(home, "o.meta.json"),
    timeout: 60,
    calls: callLog,
  };
  const tsv = () => readFileSync(callLog, "utf8").trim().split("\n").slice(1);
  return { home, env, opts, calls, tsv, others, advance: (ms: number) => (t += ms) };
}
