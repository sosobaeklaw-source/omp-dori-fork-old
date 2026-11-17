// The macmini's own pulse as the sync copied it to `<stateDir>/macmini/lead-alive.json`. The sync tells this run whether it
// fetched the macmini's records (`DORI_MINI_FETCHED_AT`, the epoch milliseconds of that fetch, unset or empty when it
// failed). Only then is the file judged, against the time of the fetch: when its `at` is more than 15 minutes older than
// that, the shared room gets one line, once per incident: the next one only after the file was fresh again. A failed
// fetch (a MacBook waking up before the network is, a broken ssh) judges nothing and sends nothing: the copy on disk is
// old by then, not the macmini silent. A missing or unreadable file sends nothing. The macmini never does this for the
// MacBook: a closed lid is not a failure.
//
// `at` is the file's own clock and comes in two forms: the macmini's pulse writes epoch seconds (with `atIso`), this repo's
// pulse writes epoch milliseconds. A number under 1e11 is read as seconds (1973 in milliseconds, the year 5138 in seconds,
// so no real time is both). A value that makes no sense sends nothing and is noted once instead: a time more than 5
// minutes ahead of the fetch, or a quiet time over 7 days. A seconds value read as milliseconds was "29885463 minutes"
// and reached the owner's room at 22:38 on 2026-11-17. The first run that judges anything (no marker yet, or one that
// never saw the file) only records what it saw, even a macmini that is already quiet: the owner is told of an incident
// that begins after the pulse is running, never of the state it found when it was installed.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { failureDetail } from "./delivery.ts";
import type { Deps } from "./harness.ts";

const QUIET_MIN = 15;
/** Quiet for longer than this is a wrong value or a wrong clock, not the macmini going quiet. */
const ABSURD_MIN = 7 * 24 * 60;
/** The Macs' clocks differ a little: a time this far ahead of the fetch still counts as now. */
const AHEAD_MS = 5 * 60_000;
/** An epoch under this is in seconds. */
const SECONDS_BELOW = 1e11;
type Seen = "missing" | "unreadable" | "fresh" | "stale" | "absurd" | "future";
type Marker = { seen?: Seen; fetched?: boolean };
type Judged = { seen: Seen; minutes: number; at?: number };

function seenOf(file: string, judgedAt: number): Judged {
  if (!existsSync(file)) return { seen: "missing", minutes: 0 };
  let at: unknown;
  try {
    at = (JSON.parse(readFileSync(file, "utf8")) as { at?: unknown }).at;
  } catch {}
  if (typeof at !== "number" || !(at > 0)) return { seen: "unreadable", minutes: 0 };
  const behind = judgedAt - (at < SECONDS_BELOW ? at * 1000 : at);
  const minutes = Math.floor(behind / 60_000);
  if (behind < -AHEAD_MS) return { seen: "future", minutes, at };
  if (minutes > ABSURD_MIN) return { seen: "absurd", minutes, at };
  return { seen: behind > QUIET_MIN * 60_000 ? "stale" : "fresh", minutes };
}

function describe({ seen, minutes, at }: Judged): string {
  if (seen === "absurd") return `시각 값 ${at}이 7일보다 오래됨(${minutes}분): 알리지 않음`;
  if (seen === "future") return `시각 값 ${at}이 미래: 알리지 않음`;
  return { missing: "아직 못 받음", unreadable: "읽지 못함", fresh: "최근 것", stale: `${minutes}분째 조용함` }[seen];
}

function readMarker(file: string): Marker {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Marker;
  } catch {
    return {};
  }
}

/** The line goes out through `DORI_ROOM_SEND` (default `DORI_HOME/bin/ompdori-send.sh`, which posts to the shared room). */
export async function miniQuiet(
  d: Deps,
  env: Readonly<Record<string, string | undefined>>,
  stateDir: string,
  note: (line: string) => void,
): Promise<void> {
  const file = join(stateDir, "macmini-pulse.json");
  const before = readMarker(file);
  const write = (seen: Seen) => writeFileSync(file, `${JSON.stringify({ seen, fetched: true })}\n`);
  const fetchedAt = env["DORI_MINI_FETCHED_AT"] ? Number(env["DORI_MINI_FETCHED_AT"]) : Number.NaN;
  if (!Number.isFinite(fetchedAt)) {
    if (before.fetched !== false) {
      note("macmini records were not fetched this run: its pulse was not judged");
      writeFileSync(file, `${JSON.stringify({ ...before, fetched: false })}\n`);
    }
    return;
  }
  const judged = seenOf(join(stateDir, "macmini", "lead-alive.json"), fetchedAt);
  const { seen, minutes } = judged;
  if (seen === "stale" && before.seen === undefined) {
    note(`macmini lead-alive.json: 처음 읽을 때 이미 ${minutes}분 조용함: 기록만 하고 알리지 않음`);
    write(seen);
    return;
  }
  if (seen === before.seen) {
    if (before.fetched === false) write(seen);
    return;
  }
  if (seen === "stale") {
    const line = `맥미니가 ${minutes}분째 조용해`;
    try {
      const r = await d.exec(env["DORI_ROOM_SEND"] ?? join(d.store.root, "bin", "ompdori-send.sh"), [line]);
      if (r.code !== 0) throw new Error(`exit ${r.code}`);
    } catch (e) {
      note(`room not told, will try again (${failureDetail(e)}): ${line}`);
      return;
    }
    note(`told the room: ${line}`);
  } else {
    note(`macmini lead-alive.json: ${describe(judged)}`);
  }
  write(seen);
}
