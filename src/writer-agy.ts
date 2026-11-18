/**
 * The Antigravity writing seat: one Argon body request sent through the `agy` CLI the seat's account is logged into.
 *
 * Lanes call at the same time: nothing here waits for another call or for an `agy` process running outside it. What
 * stays is the seat's own safety. There is no cap on how many run at once: the owner said so on 2026-11-18 (맥북 창
 * 16:3x, "1분에 한편 뭐그런거 필요없다 내가 구독하는거 쓰는건데 … 병렬최대로"), accepting that a burst can draw the
 * suspension an earlier account got for being driven like a tool. The 403 stop only fires after Google has acted.
 *   - only the configured mail ({@link AgyEnv.seatAccount}, local config, never in this repo), compared whole: from
 *     the CLI's own log before each call, and after it from that call's own run log. agy names a run log
 *     `cli-YYYYMMDD_HHMMSS.log`, a second apart at best, so two calls that start together would share one file and
 *     one of them would look unlogged. Each call passes `--log-file` with its own work-folder name on the end, and
 *     the log is read back from that exact path;
 *   - the request body goes into a fresh empty folder as `request.md`, and the prompt is one short line naming it;
 *   - an answer that links a file (`implementation_plan.md` and the like) is dropped and asked once more;
 *   - a 403 stops the seat for good (`state/agy-stopped.json`) until a person removes that file. The stop file, the
 *     quota hold and the account are read again right before every call. A Google quota error (429 /
 *     RESOURCE_EXHAUSTED) holds every lane until the reset Google named. There is no daily count of our own.
 * Every call adds one line, account `agy-s4`, to the call log (`gemini-calls.tsv`) the web runner writes.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type AgyRun, errorText, isForbidden, isQuota, linksFile } from "./agy-errors.ts";
import { type AgyUsage, mailsIn } from "./agy-logs.ts";
import * as own from "./agy-own.ts";

export const AGY_MODEL = "gemini-4-argon-high";
const SEAT = "agy-s4";
export const ASK = "request.md을 읽고 본문만 한국어로 답하라. 파일을 만들지 말라.";

/** Exit codes, beside the web runner's (0 ok, 3 empty answer). */
// biome-ignore format: one table
export const EXIT = { ok: 0, empty: 3, linked: 20, forbidden: 21, stopped: 22, account: 24, unlogged: 25, quota: 26, failed: 1 };

export type { AgyRun };
export type AgyEnv = {
  now: () => number;
  /** Runs `agy` with these arguments in `cwd`. */
  run: (args: readonly string[], cwd: string) => Promise<AgyRun>;
  /** The mail `agy` last logged in with (its CLI log), or undefined if none is known. */
  account: () => string | undefined;
  /** The one mail the seat calls as (config.json `agyAccount`, or `DORI_AGY_ACCOUNT`); undefined refuses every send. */
  seatAccount: string | undefined;
  usage: () => AgyUsage;
  /** The text of agy's run log for the call made in `workDir`, or undefined if agy wrote none. */
  runLog: (workDir: string) => string | undefined;
  /** Where agy keeps its run logs (`~/.gemini/antigravity-cli/log`); each call writes its own file there. */
  logDir: string;
  log: (line: string) => void;
};
/** `calls` is the call log path (`gemini-calls.tsv`), chosen by the caller, so a test never writes the real one. */
export type AgyOpts = {
  home: string;
  lane: string;
  prompt: string;
  out: string;
  meta: string;
  timeout: number;
  calls: string;
};

export const stopPath = (home: string): string => join(home, "state", "agy-stopped.json");
const record = (o: AgyOpts, kind: string, result: string, code: number, startedAt: number, endAt: number): void =>
  own.appendCall(o.calls, [own.kst(endAt), SEAT, kind, "Argon", AGY_MODEL, result, code, (endAt - startedAt) / 1000]);

/** No configured account is a setup gap, not an account change: no call, and the seat is not stopped. */
function seatAccount(env: AgyEnv): string {
  if (env.seatAccount) return env.seatAccount;
  throw new AgyStop(EXIT.account, "ESCALATE no agy account set (agyAccount in config.json or DORI_AGY_ACCOUNT)");
}

function checkAccount(env: AgyEnv, home: string, when: string): void {
  const mail = env.account();
  if (mail === seatAccount(env)) return;
  refuseAccount(home, when, mail ? [mail] : []);
}

function refuseAccount(home: string, when: string, mails: string[]): never {
  const who = mails.map((m) => `${m.split("@")[0]}@…`).join(", ") || "nobody known";
  stop(home, `agy ${when}: logged in as ${who}, not the seat's account`);
  throw new AgyStop(EXIT.account, `ESCALATE agy account is not the seat's (${when}); seat stopped`);
}

function stop(home: string, why: string): void {
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(stopPath(home), `${JSON.stringify({ at: new Date().toISOString(), why })}\n`);
}

/** A 403 a lane got calling agy directly shows only in agy's logs; it stops this seat as its own 403 would. */
function refuseIfForbidden(u: AgyUsage, home: string): void {
  if (!u.forbidden) return;
  stop(home, "the latest s4 run in agy's run logs got PERMISSION_DENIED (code 403)");
  throw new AgyStop(EXIT.forbidden, "ESCALATE agy's run logs show a 403 on the latest s4 run; seat stopped, no calls");
}

export class AgyStop extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** One call: run `agy`, record it; returns the answer or why there is none. */
async function callOnce(env: AgyEnv, o: AgyOpts, kind: string) {
  refuseIfForbidden(env.usage(), o.home);
  const dir = mkdtempSync("/tmp/agy-w-");
  writeFileSync(join(dir, "request.md"), readFileSync(o.prompt));
  const startedAt = env.now();
  const stamp = new Date(startedAt).toISOString().replace(/\D/g, "").slice(0, 14);
  const logFile = join(env.logDir, `cli-${stamp}-${basename(dir)}.log`);
  let r: AgyRun;
  try {
    // biome-ignore format: one flag and its value per pair
    r = await env.run([
      "-p", ASK, "--model", AGY_MODEL, "--sandbox", "--mode", "plan", "--output-format", "json",
      "--print-timeout", `${o.timeout}s`, "--log-file", logFile,
    ], dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const endAt = env.now();
  let json: { status?: string; response?: string; error?: string; usage?: unknown } = {};
  try {
    json = JSON.parse(r.stdout);
  } catch {}
  const answer = (json.response ?? "").trim();
  const error = json.error ?? "";
  if (isForbidden(r, error)) {
    record(o, kind, "403 정지", EXIT.forbidden, startedAt, endAt);
    stop(o.home, `403 at ${new Date(endAt).toISOString()}: ${error || r.stderr.slice(0, 300)}`);
    return { forbidden: true as const, error };
  }
  if (isQuota(r, error)) {
    record(o, kind, "구글 한도", EXIT.quota, startedAt, endAt);
    own.logQuota(o.home, o.lane, endAt, errorText(r, error));
    own.holdForQuota(o.home, endAt + own.quotaResetMs(errorText(r, error)));
    return { quota: true as const, error };
  }
  const linked = answer !== "" && linksFile(answer);
  const result = linked
    ? `답 ${answer.length}자(파일 링크, 버림)`
    : answer
      ? `답 ${answer.length}자`
      : `빈 답(${json.status ?? `exit ${r.code}`}${error ? `: ${error}` : ""})`;
  const code = linked ? EXIT.linked : answer ? EXIT.ok : EXIT.empty;
  record(o, kind, result, code, startedAt, endAt);
  // Bound to this call by the log file it was given: no log, or any mail on it other than the seat's, stops the seat
  // before the answer is used, since the account check rests on these logs.
  const log = env.runLog(logFile);
  if (log === undefined) {
    stop(o.home, `agy's run logs did not record the call at ${new Date(startedAt).toISOString()}`);
    return { unlogged: true as const };
  }
  const mails = mailsIn(log);
  if (mails.length === 0 || mails.some((m) => m !== seatAccount(env)))
    refuseAccount(o.home, "on this call's run log", mails);
  return { answer, linked, status: json.status, error, usage: json.usage, runCode: r.code };
}

/** Sends on the agy seat (one retry of a linked answer); stops throw {@link AgyStop}; answer to `out`. */
export async function sendOnAgy(env: AgyEnv, o: AgyOpts): Promise<number> {
  rmSync(o.out, { force: true });
  rmSync(o.meta, { force: true });
  refuseIfStopped(o.home);
  seatAccount(env);
  refuseIfForbidden(env.usage(), o.home);
  refuseIfQuota(env, o.home);
  checkAccount(env, o.home, "before the call");
  const meta: Record<string, unknown> = { seat: SEAT, model: AGY_MODEL, lane: o.lane, calls: [] as unknown[] };
  for (const kind of ["new", "retry"]) {
    // Another lane may have hit the 403, or agy may have been signed in elsewhere, since this send was checked.
    refuseIfStopped(o.home);
    refuseIfQuota(env, o.home);
    checkAccount(env, o.home, "before the call");
    const c = await callOnce(env, o, kind);
    (meta["calls"] as unknown[]).push({ kind, at: new Date(env.now()).toISOString(), ...c, answer: undefined });
    if ("forbidden" in c)
      throw new AgyStop(EXIT.forbidden, `ESCALATE agy-s4 got 403 (${c.error}); seat stopped, no more calls`);
    if ("quota" in c) throw new AgyStop(EXIT.quota, `agy-s4 hit Google's quota (429); see ${own.quotaPath(o.home)}`);
    if ("unlogged" in c)
      throw new AgyStop(EXIT.unlogged, "ESCALATE agy's run logs did not record this call; seat stopped");
    checkAccount(env, o.home, "after the call");
    if (c.linked) {
      env.log(`DROP agy-s4 answer links a file${kind === "new" ? "; asking once more" : ""}`);
      continue;
    }
    if (!c.answer) return finish(meta, o, EXIT.empty);
    writeFileSync(o.out, `${c.answer}\n`);
    meta["answerChars"] = c.answer.length;
    return finish(meta, o, EXIT.ok);
  }
  return finish(meta, o, EXIT.linked);
}

/** Google's quota holds every lane until the reset it named; no call goes out before it. */
function refuseIfQuota(env: AgyEnv, home: string): void {
  const until = own.readQuotaUntil(home);
  if (until <= env.now()) return;
  throw new AgyStop(
    EXIT.quota,
    `agy-s4 under Google's quota until ${own.kst(until)} KST (${own.quotaUntilPath(home)})`,
  );
}

function refuseIfStopped(home: string): void {
  if (!existsSync(stopPath(home))) return;
  const why = readFileSync(stopPath(home), "utf8").trim();
  throw new AgyStop(EXIT.stopped, `ESCALATE agy-s4 is stopped (${why}); a person removes ${stopPath(home)}`);
}

function finish(meta: Record<string, unknown>, o: AgyOpts, code: number): number {
  meta["exit"] = code;
  meta["finishedAt"] = new Date().toISOString();
  writeFileSync(o.meta, `${JSON.stringify(meta, null, 1)}\n`);
  return code;
}
