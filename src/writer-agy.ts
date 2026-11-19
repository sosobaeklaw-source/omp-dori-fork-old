/** Antigravity writing seat: serialized calls, account and quota checks, and a permanent stop on 403. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgyRun, errorText, isForbidden, isQuota, linksFile } from "./agy-errors.ts";
import { type AgyUsage, mailsIn } from "./agy-logs.ts";
import * as own from "./agy-own.ts";
import { holder, nameCommand, type OwnerEnv, release, tryTake } from "./lock-owner.ts";

export const AGY_MODEL = "gemini-4-argon-high";
export const GAP_MS = 60_000;
const BUSY_POLL_MS = 20_000;
const LOCK = "agy-s4";
const SEAT = "agy-s4";
export const ASK = "request.md을 읽고 본문만 한국어로 답하라. 파일을 만들지 말라.";

/** Exit codes, beside the web runner's (0 ok, 3 empty answer). */
// biome-ignore format: one table
export const EXIT = { ok: 0, empty: 3, linked: 20, forbidden: 21, stopped: 22, account: 24, unlogged: 25, quota: 26, busy: 27, failed: 1 };

export type { AgyRun };
export type AgyEnv = OwnerEnv & {
  sleep: (ms: number) => Promise<void>;
  /** Runs `agy` with these arguments in `cwd`; `onSpawn` gets its pid as soon as it exists. */
  run: (args: readonly string[], cwd: string, onSpawn: (pid: number) => void) => Promise<AgyRun>;
  /** The mail `agy` last logged in with (its CLI log), or undefined if none is known. */
  account: () => string | undefined;
  /** The one mail the seat calls as (config.json `agyAccount`, or `DORI_AGY_ACCOUNT`); undefined refuses every send. */
  seatAccount: string | undefined;
  usage: () => AgyUsage;
  /** The text of agy's run log for the call made in `workDir`, or undefined if agy wrote none. */
  runLog: (workDir: string) => string | undefined;
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

/** agy's logs for every lane, never before the last call this seat itself made. */
function usageOf(env: AgyEnv, home: string): AgyUsage {
  const u = env.usage();
  return { ...u, lastEndAt: Math.max(u.lastEndAt, own.readOwn(home).lastAt) };
}

const record = (o: AgyOpts, kind: string, result: string, code: number, startedAt: number, endAt: number): void =>
  own.appendCall(o.calls, [own.kst(endAt), SEAT, kind, "Argon", AGY_MODEL, result, code, (endAt - startedAt) / 1000]);

/** No configured account is a setup gap, not an account change: no call, and the seat is not stopped. */
function seatAccount(env: AgyEnv): string {
  if (env.seatAccount) return env.seatAccount;
  throw new AgyStop(EXIT.account, "ESCALATE no agy account set (agyAccount in config.json or DORI_AGY_ACCOUNT)");
}

function checkAccount(env: AgyEnv, home: string, when: string, afterSend = false): void {
  const mail = env.account();
  if (mail === seatAccount(env)) return;
  refuseAccount(home, when, mail ? [mail] : [], afterSend);
}

function refuseAccount(home: string, when: string, mails: string[], afterSend = false): never {
  const who = mails.map((m) => `${m.split("@")[0]}@…`).join(", ") || "nobody known";
  stop(home, `agy ${when}: logged in as ${who}, not the seat's account`);
  throw new AgyStop(EXIT.account, `ESCALATE agy account is not the seat's (${when}); seat stopped`, afterSend);
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
  /**
   * True when the stop was raised after this request already went out (a 403 on the call, a call missing from agy's run
   * log, an account that is not the seat's on that call's log). The request must not go to a web seat as well; only a
   * stop raised before anything was sent lets the next seat have it.
   */
  readonly afterSend: boolean;
  constructor(
    readonly code: number,
    message: string,
    afterSend = false,
  ) {
    super(message);
    this.afterSend = afterSend;
  }
}

/** One call (lock held, gap waited out): run `agy`, record it; returns the answer or why there is none. */
async function callOnce(env: AgyEnv, o: AgyOpts, kind: string, onPid: (pid: number) => void) {
  const before = usageOf(env, o.home);
  refuseIfForbidden(before, o.home);
  const dir = mkdtempSync("/tmp/agy-w-");
  writeFileSync(join(dir, "request.md"), readFileSync(o.prompt));
  const startedAt = env.now();
  own.writeOwn(o.home, { lastAt: startedAt });
  let r: AgyRun;
  try {
    // biome-ignore format: one flag and its value per pair
    r = await env.run([
      "-p", ASK, "--model", AGY_MODEL, "--sandbox", "--mode", "plan", "--output-format", "json",
      "--print-timeout", `${o.timeout}s`,
    ], dir, onPid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    own.writeOwn(o.home, { lastAt: env.now() });
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
  // Bound to this call by its own work folder, not to whatever ran last: no log, or any mail on it other than the
  // seat's, stops the seat before the answer is used, since the gap and account rest on these logs.
  const log = env.runLog(dir);
  if (log === undefined) {
    stop(o.home, `agy's run logs did not record the call at ${new Date(startedAt).toISOString()}`);
    return { unlogged: true as const };
  }
  const mails = mailsIn(log);
  if (mails.length === 0 || mails.some((m) => m !== seatAccount(env)))
    refuseAccount(o.home, "on this call's run log", mails, true);
  return { answer, linked, status: json.status, error, usage: json.usage, runCode: r.code };
}

/** Sends on the agy seat (lock, gap, one retry of a linked answer); stops throw {@link AgyStop}; answer to `out`. */
export async function sendOnAgy(env: AgyEnv, o: AgyOpts): Promise<number> {
  rmSync(o.out, { force: true });
  rmSync(o.meta, { force: true });
  refuseIfStopped(o.home);
  seatAccount(env);
  refuseIfForbidden(usageOf(env, o.home), o.home);
  refuseIfQuota(env, o.home);
  checkAccount(env, o.home, "before the call");
  let got = tryTake(env, LOCK, o.lane, env.log);
  while ("busy" in got) {
    env.log(`WAIT agy-s4 busy (${holder(env.root, LOCK)?.owner ?? got.busy})`);
    await env.sleep(BUSY_POLL_MS);
    got = tryTake(env, LOCK, o.lane, env.log);
  }
  let owner = got.owner;
  const onPid = (pid: number): void => {
    owner = nameCommand(env.root, LOCK, got.owner, pid);
  };
  const meta: Record<string, unknown> = { seat: SEAT, model: AGY_MODEL, lane: o.lane, calls: [] as unknown[] };
  try {
    for (const kind of ["new", "retry"]) {
      // An `agy -p` another lane started without this lock still counts as busy, and the gap runs from its end; one
      // stuck past --timeout gives up (the lock is freed in finally) rather than holding every lane behind it.
      const giveUpAt = env.now() + o.timeout * 1000;
      for (let u = usageOf(env, o.home); u.running || u.lastEndAt + GAP_MS > env.now(); u = usageOf(env, o.home)) {
        if (u.running && env.now() >= giveUpAt)
          throw new AgyStop(EXIT.busy, `ESCALATE an agy -p outside this lock ran past ${o.timeout}s; no call`);
        const wait = u.running ? BUSY_POLL_MS : u.lastEndAt + GAP_MS - env.now();
        env.log(u.running ? "WAIT agy -p running outside this lock" : `GAP agy-s4 ${Math.ceil(wait / 1000)}s`);
        await env.sleep(wait);
      }
      // Another lane may have hit the 403, or agy may have been signed in elsewhere, while this one waited.
      refuseIfStopped(o.home);
      refuseIfQuota(env, o.home);
      checkAccount(env, o.home, "before the call");
      const c = await callOnce(env, o, kind, onPid);
      (meta["calls"] as unknown[]).push({ kind, at: new Date(env.now()).toISOString(), ...c, answer: undefined });
      if ("forbidden" in c)
        throw new AgyStop(EXIT.forbidden, `ESCALATE agy-s4 got 403 (${c.error}); seat stopped, no more calls`, true);
      if ("quota" in c)
        throw new AgyStop(
          EXIT.quota,
          `agy-s4 hit Google's quota (429) on this call; see ${own.quotaPath(o.home)}`,
          true,
        );
      if ("unlogged" in c)
        throw new AgyStop(EXIT.unlogged, "ESCALATE agy's run logs did not record this call; seat stopped", true);
      checkAccount(env, o.home, "after the call", true);
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
  } finally {
    release(env.root, LOCK, owner);
  }
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
