/**
 * What every lane reads before it takes a web writing seat: whether the seat is disconnected, and how long it rests
 * after lost answers. `sendOnSeat` writes both, under the seat's lock, so the next lane sees them.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LOST_TURN = 14;
export const CALL_REST_MS = 30 * 60_000;

const callLogPath = (home: string, account: string): string => join(home, "state", `writer-calls-${account}.tsv`);
export const seatStatePath = (home: string, account: string): string =>
  join(home, "state", `writer-seat-${account}.json`);

export type SeatState = { connected: boolean; why: string; seenAt: string };

/** An absent or malformed runner receipt cannot establish which account was on screen. */
export function runnerAccount(path: string): string {
  if (!existsSync(path)) return "";
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text)?.googleAccount ?? "";
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    return "";
  }
}

/**
 * Why a seat is not connected, or undefined when it is (or was never marked). Every lane reads this before trying it.
 * A file that cannot be read as JSON is a broken mark, not a reason to crash every lane's seat scan: it is reported as
 * unreadable, so the seat is left alone and the ESCALATE line names the file a person clears.
 */
export function disconnectedWhy(home: string, account: string): string | undefined {
  const path = seatStatePath(home, account);
  if (!existsSync(path)) return undefined;
  let s: Partial<SeatState>;
  try {
    s = JSON.parse(readFileSync(path, "utf8")) as Partial<SeatState>;
  } catch {
    return `unreadable state file (${path})`;
  }
  return s.connected === false ? (s.why ?? "disconnected") : undefined;
}

/** Writes through a temp file and a rename, so a lane reading it never sees half a mark. */
export function markSeat(home: string, account: string, connected: boolean, why: string, now: number): void {
  const dir = join(home, "state");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const state: SeatState = { connected, why, seenAt: new Date(now).toISOString() };
  const path = seatStatePath(home, account);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 1)}\n`);
  renameSync(tmp, path);
}

/**
 * Lost answers in a row, and the time the seat rests until. The window opens when the third (or sixth, ...) lost
 * answer is logged, so it holds however old the earlier rows are, and every further three doubles it. The time is
 * counted from the row that completed that run, never from the latest loss: once the window has passed, a further loss
 * leaves the seat free instead of resting it again for 30 minutes.
 */
export function lostRun(home: string, account: string): { streak: number; until: number } {
  const path = callLogPath(home, account);
  if (!existsSync(path)) return { streak: 0, until: 0 };
  const rows = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  let streak = 0;
  let last = 0;
  for (const row of rows) {
    const [timestamp, , result] = row.split("\t");
    if (result !== "lost") {
      streak = 0;
      continue;
    }
    streak++;
    if (streak % 3 === 0) last = Date.parse(timestamp ?? "");
  }
  const runs = Math.floor(streak / 3);
  if (runs < 1) return { streak, until: 0 };
  return { streak, until: last + CALL_REST_MS * 2 ** (runs - 1) };
}

/** One line of the per-seat call log, written before the lock is released so the next lane reads it. */
export function recordCall(home: string, account: string, at: number, code: number): void {
  const dir = join(home, "state");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const result = code === 0 ? "success" : code === LOST_TURN ? "lost" : "other";
  appendFileSync(callLogPath(home, account), `${new Date(at).toISOString()}\t${account}\t${result}\t${code}\n`);
}
