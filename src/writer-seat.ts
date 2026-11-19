/**
 * Picks seats listed in writer-seats.txt under the shared carbon account lock. Three consecutive lost answers rest
 * a seat for 30 minutes, doubling each further three; screen limit notices rest it until their displayed reset time.
 * Exit 16 means the model limit was seen before sending, so the request may move to another seat. Exit 15 also means
 * nothing was sent: a mismatched or unreadable account disconnects the seat until a person clears its state file.
 * A sent request is never sent again. Every lane shares the locks, rest files, disconnect marks and call logs.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { holder, nameCommand, type OwnerEnv, release, tryTake } from "./lock-owner.ts";
import { Refusal } from "./refusal.ts";
import {
  disconnectedWhy,
  LOST_TURN,
  lostRun,
  markSeat,
  recordCall,
  runnerAccount,
  seatStatePath,
} from "./writer-seat-log.ts";
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

/**
 * Every seat is disconnected, so nothing was sent and waiting would never end. The lane reports it as exit 15, the same
 * code a single disconnected seat gives, and the message names the state files a person clears once signed in again.
 */
export class SeatGone extends Error {
  readonly code = ACCOUNT_MISMATCH;
}
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

/**
 * Sends one request on the first seat that is free, and returns its exit code with the seat that ran it.
 *
 * A seat that exits 15 (the screen's account is not the seat's) is marked disconnected and the request moves on unsent,
 * so the next seat may get it; every other exit already went out and is returned as it stands, never sent again. Only
 * when every seat is busy or resting does the call wait, and when every seat is disconnected it refuses with an
 * ESCALATE naming the state files a person must clear.
 */
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
    // No seat can take this request. Waiting would never end (a disconnected seat is never called again), so the lane is
    // told what a person must clear.
    if (open.length === 0) refuseIfAllDisconnected(env, o.home, seats, now);
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
              const account = runnerAccount(o.meta);
              markSeat(
                o.home,
                seat.account,
                false,
                account ? "screen account differs (exit 15)" : "signed out / account unreadable (exit 15)",
                env.now(),
              );
            } else if (code === 0) {
              markSeat(o.home, seat.account, true, "answered", env.now());
            }
          }
          if (code !== ACCOUNT_MISMATCH) noteLimit(o.home, seat.account, o.meta, env.now());
        } finally {
          release(env.root, lockName(seat.account), owner);
        }
      }
      if (code === undefined) throw new Refusal("runner exited without a status");
      tried.push(seat.account);
      if (code !== ACCOUNT_MISMATCH) stampMeta(o.meta, seat, pickedAt, pickedAt - start, tried);
      const rest = readRest(o.home, seat.account);
      if (rest && Date.parse(rest.seenAt) >= pickedAt)
        env.log(`REST ${seat.account} until ${rest.until}: ${rest.limitText}`);
      const lost = lostRun(o.home, seat.account);
      if (code === LOST_TURN && lost.streak >= 3 && lost.until > env.now()) {
        env.log(
          `REST ${seat.account} until ${new Date(lost.until).toISOString()}: ${lost.streak} lost answers in a row`,
        );
      }
      if (code === ACCOUNT_MISMATCH) {
        env.log(`SKIP ${seat.account}: ${disconnectedWhy(o.home, seat.account)}`);
      }
      // Nothing was sent, so the same request may go to the next seat. Anything else already went out.
      if ((code === LIMIT_PRESEND && rest && Date.parse(rest.seenAt) >= pickedAt) || code === ACCOUNT_MISMATCH)
        continue;
      return { code, seat };
    }
    // This seat just exited 15 and was marked, so every seat may now be disconnected: refuse before the wait.
    refuseIfAllDisconnected(env, o.home, seats, env.now());
    const next = Math.min(...seats.map((s) => restingUntil(o.home, s.account, env.now()) ?? env.now() + BUSY_POLL_MS));
    const why = seatWhy(env, o.home, seats, env.now());
    if (why !== waitNoted) env.log(`WAIT ${why}`);
    waitNoted = why;
    await env.sleep(Math.max(1_000, Math.min(next - env.now(), BUSY_POLL_MS)));
  }
}

/**
 * Throws when every seat is disconnected, which is the one state waiting can never leave. Resting seats do leave it, so
 * a seat that is only resting keeps the wait; a seat disconnected and another resting keeps waiting for the resting one.
 */
function refuseIfAllDisconnected(env: SeatEnv, home: string, seats: readonly Seat[], now: number): void {
  if (!seats.every((s) => disconnectedWhy(home, s.account) !== undefined)) return;
  const files = seats.map((s) => seatStatePath(home, s.account)).join(", ");
  throw new SeatGone(
    `ESCALATE exit ${ACCOUNT_MISMATCH}: every writing seat is disconnected, so nothing was sent; ` +
      `a person removes ${files} once the account is signed in again (${seatWhy(env, home, seats, now)})`,
  );
}

/** One line per seat saying why it cannot be called now: disconnected, resting until when, or busy with whose lock. */
function seatWhy(env: SeatEnv, home: string, seats: readonly Seat[], now: number): string {
  return seats
    .map((s) => {
      const d = disconnectedWhy(home, s.account);
      if (d) return `${s.account} disconnected (${d})`;
      const r = restingUntil(home, s.account, now);
      return r
        ? `${s.account} resting until ${new Date(r).toISOString()}`
        : `${s.account} busy (${holder(env.root, lockName(s.account))?.owner ?? "?"})`;
    })
    .join("; ");
}
