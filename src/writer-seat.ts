/**
 * Picks the writing seat for one Argon/Hydrogen request.
 *
 * Seats are the lines of `<home>/writer-seats.txt`, `<aside account> <google mail prefix>` (e.g. `u0 sosobaeklaw`),
 * tried in that order. A seat is busy while its `state/carbon-<account>.lock` is held (the lock carbon-lock.sh and
 * every lane already use). It rests in two ways, and every lane reads the same files before taking it:
 *   - a limit notice the runner saw on the screen (`state/writer-rest-<account>.json`, until the time the notice shows);
 *   - three lost answers in a row (exit 14) in `state/writer-calls-<account>.tsv`, for 30 minutes, doubling each
 *     further three. Slowness or any other failure never rests a seat, and a sent request is never sent again.
 * Only when every seat is busy or resting does the request wait.
 *
 * The runner (gemini_web_runner.mjs) exits 16 when a limit notice kept it from picking `<model> 높음` before sending:
 * nothing was sent, so the same request goes to the next seat. Any other exit is the request's result as it stands.
 * It exits 15 when the Google account on the screen is not the one the seat names: nothing was sent, the seat is
 * marked disconnected (`state/writer-seat-<account>.json`, read by every lane) and the request moves on.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { holder, nameCommand, type OwnerEnv, release, tryTake } from "./lock-owner.ts";
import { Refusal } from "./refusal.ts";
import { disconnectedWhy, LOST_TURN, lostRun, markSeat, recordCall } from "./writer-seat-log.ts";
export { LOST_TURN };
import type { Writer } from "./writer-request.ts";

export type Seat = { account: string; expect: string };
export type Rest = { limitText: string; resetAt: string | null; seenAt: string; until: string };
export type SeatEnv = OwnerEnv & {
  sleep: (ms: number) => Promise<void>;
  /**
   * Runs the runner with these arguments and returns its exit code. `onSpawn` gets the runner's pid as soon as it
   * exists, so the lock can name it (cmd=) before the runner touches the browser.
   */
  run: (args: readonly string[], onSpawn: (pid: number) => void) => Promise<number>;
  log: (line: string) => void;
};
export type SendOpts = {
  home: string;
  lane: string;
  model: Writer;
  prompt: string;
  out: string;
  meta: string;
  timeout: number;
};

/** A notice with no time on it rests the seat this long; the next try reads the screen again (an unsent abort). */
export const UNDATED_REST_MS = 30 * 60_000;
export const BUSY_POLL_MS = 20_000;
/** The runner's exit code for a limit notice seen before sending (nothing sent). */
export const LIMIT_PRESEND = 16;
/** The runner's exit code when the Google account on screen is not the seat's (nothing sent). */
export const ACCOUNT_MISMATCH = 15;

export const seatsPath = (home: string): string => join(home, "writer-seats.txt");
export const restPath = (home: string, account: string): string => join(home, "state", `writer-rest-${account}.json`);
const lockName = (account: string): string => `carbon-${account}`;

export function readSeats(home: string): Seat[] {
  const path = seatsPath(home);
  if (!existsSync(path)) throw new Refusal(`${path} is missing: one "<aside account> <mail prefix>" line per seat`);
  const seats = readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l, i) => {
      const m = /^(u\d)\s+([^\s@]+)$/.exec(l);
      if (!m) throw new Refusal(`${path} line ${i + 1} is not "<u0-u9> <mail prefix>": ${l}`);
      return { account: m[1]!, expect: m[2]! };
    });
  if (seats.length === 0) throw new Refusal(`${path} names no seat`);
  return seats;
}

export function readRest(home: string, account: string): Rest | undefined {
  const path = restPath(home, account);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Rest) : undefined;
}

/** The time a seat rests until, or undefined once that time has passed (or it never rested). */
export function restingUntil(home: string, account: string, now: number): number | undefined {
  const rest = readRest(home, account);
  const until = rest ? Date.parse(rest.until) : Number.NaN;
  const callUntil = lostRun(home, account).until;
  return Math.max(until > now ? until : 0, callUntil > now ? callUntil : 0) || undefined;
}

/** Rests the seat when the runner's meta carries a limit notice from the screen; returns the rest written, if any. */
export function noteLimit(home: string, account: string, metaPath: string, now: number): Rest | undefined {
  if (!existsSync(metaPath)) return undefined;
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { limitText?: string; limitResetAt?: string | null };
  if (!meta.limitText) return undefined;
  const reset = meta.limitResetAt ? Date.parse(meta.limitResetAt) : Number.NaN;
  const until = reset > now ? reset : now + UNDATED_REST_MS;
  const rest: Rest = {
    limitText: meta.limitText,
    resetAt: meta.limitResetAt ?? null,
    seenAt: new Date(now).toISOString(),
    until: new Date(until).toISOString(),
  };
  writeFileSync(restPath(home, account), `${JSON.stringify(rest, null, 1)}\n`);
  return rest;
}

/** Adds the seat to the runner's meta, so every result names the account it went to and the label it ran under. */
function stampMeta(metaPath: string, seat: Seat, pickedAt: number, waitedMs: number, tried: string[]): void {
  if (!existsSync(metaPath)) return;
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
  meta["seat"] = {
    account: seat.account,
    expect: seat.expect,
    pickedAt: new Date(pickedAt).toISOString(),
    waitedMs,
    tried,
  };
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 1)}\n`);
}

export async function sendOnSeat(env: SeatEnv, o: SendOpts): Promise<{ code: number; seat: Seat }> {
  const seats = readSeats(o.home);
  const start = env.now();
  const tried: string[] = [];
  let waitNoted = "";
  for (;;) {
    const now = env.now();
    const open = seats.filter(
      (s) => restingUntil(o.home, s.account, now) === undefined && disconnectedWhy(o.home, s.account) === undefined,
    );
    for (const seat of open) {
      const got = tryTake(env, lockName(seat.account), o.lane, env.log);
      if ("busy" in got) continue;
      // Read again under the lock: another lane may have rested or disconnected this seat while we waited for it.
      const restNow = restingUntil(o.home, seat.account, env.now());
      const whyNow = disconnectedWhy(o.home, seat.account);
      if (restNow !== undefined || whyNow !== undefined) {
        release(env.root, lockName(seat.account), got.owner);
        continue;
      }
      let code: number | undefined;
      const pickedAt = env.now();
      env.log(
        `SEAT ${seat.account} (${seat.expect}) for ${o.model}${tried.length ? `, after ${tried.join(", ")}` : ""}`,
      );
      // A meta left by an earlier run (this request on another seat, or a reused --meta path) is not this run's: a
      // runner that dies before writing one must leave none, so its limit can never rest this seat.
      rmSync(o.meta, { force: true });
      // The owner line names the runner too: if this process alone is killed, the lock stays held (staleWhy reads
      // cmd=) while the runner still drives that account's browser.
      let owner = got.owner;
      try {
        // biome-ignore format: one flag and its value per pair
        code = await env.run([
          "--model", o.model, "--account", seat.account, "--expect-account", seat.expect,
          "--prompt", o.prompt, "--out", o.out, "--meta", o.meta, "--timeout", String(o.timeout),
        ], (pid) => {
          owner = nameCommand(env.root, lockName(seat.account), got.owner, pid);
        });
      } finally {
        try {
          if (code !== undefined) {
            recordCall(o.home, seat.account, env.now(), code);
            if (code === ACCOUNT_MISMATCH) {
              markSeat(o.home, seat.account, false, "screen account differs from the seat (exit 15)", env.now());
            } else if (code === 0) {
              markSeat(o.home, seat.account, true, "answered", env.now());
            }
          }
          noteLimit(o.home, seat.account, o.meta, env.now());
        } finally {
          release(env.root, lockName(seat.account), owner);
        }
      }
      if (code === undefined) throw new Refusal("runner exited without a status");
      tried.push(seat.account);
      stampMeta(o.meta, seat, pickedAt, pickedAt - start, tried);
      const rest = readRest(o.home, seat.account);
      if (rest && Date.parse(rest.seenAt) >= pickedAt)
        env.log(`REST ${seat.account} until ${rest.until}: ${rest.limitText}`);
      const lost = lostRun(o.home, seat.account);
      if (code === LOST_TURN && lost.streak >= 3 && lost.streak % 3 === 0) {
        env.log(
          `REST ${seat.account} until ${new Date(lost.until).toISOString()}: ${lost.streak} lost answers in a row`,
        );
      }
      if (code === ACCOUNT_MISMATCH) {
        env.log(`SKIP ${seat.account}: ${disconnectedWhy(o.home, seat.account)}`);
      }
      // Nothing was sent, so the same request may go to the next seat. Anything else already went out.
      if ((code === LIMIT_PRESEND && rest && Date.parse(rest.seenAt) >= pickedAt) || code === ACCOUNT_MISMATCH) break;
      return { code, seat };
    }
    const next = Math.min(...seats.map((s) => restingUntil(o.home, s.account, env.now()) ?? env.now() + BUSY_POLL_MS));
    const why = seats
      .map((s) => {
        const d = disconnectedWhy(o.home, s.account);
        if (d) return `${s.account} disconnected (${d})`;
        const r = restingUntil(o.home, s.account, env.now());
        return r
          ? `${s.account} resting until ${new Date(r).toISOString()}`
          : `${s.account} busy (${holder(env.root, lockName(s.account))?.owner ?? "?"})`;
      })
      .join("; ");
    if (why !== waitNoted) env.log(`WAIT ${why}`);
    waitNoted = why;
    await env.sleep(Math.max(1_000, Math.min(next - env.now(), BUSY_POLL_MS)));
  }
}
