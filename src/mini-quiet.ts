// The macmini's own pulse as the sync copied it to `<stateDir>/macmini/lead-alive.json`. The sync tells this run whether it
// fetched the macmini's records (`DORI_MINI_FETCHED_AT`, the epoch milliseconds of that fetch, unset or empty when it
// failed). Only then is the file judged, against the time of the fetch: when its `at` is more than 15 minutes older than
// that, the shared room gets one line, once per incident: the next one only after the file was fresh again. A failed
// fetch (a MacBook waking up before the network is, a broken ssh) judges nothing and sends nothing: the copy on disk is
// old by then, not the macmini silent. A missing or unreadable file sends nothing. The macmini never does this for the
// MacBook: a closed lid is not a failure.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { failureDetail } from "./delivery.ts";
import type { Deps } from "./harness.ts";

const QUIET_MIN = 15;
type Seen = "missing" | "unreadable" | "fresh" | "stale";
type Marker = { seen?: Seen; fetched?: boolean };

function seenOf(file: string, judgedAt: number): { seen: Seen; minutes: number } {
  if (!existsSync(file)) return { seen: "missing", minutes: 0 };
  let at: unknown;
  try {
    at = (JSON.parse(readFileSync(file, "utf8")) as { at?: unknown }).at;
  } catch {}
  if (typeof at !== "number") return { seen: "unreadable", minutes: 0 };
  return {
    seen: judgedAt - at > QUIET_MIN * 60_000 ? "stale" : "fresh",
    minutes: Math.floor((judgedAt - at) / 60_000),
  };
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
  const { seen, minutes } = seenOf(join(stateDir, "macmini", "lead-alive.json"), fetchedAt);
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
    note(`macmini lead-alive.json: ${{ missing: "아직 못 받음", unreadable: "읽지 못함", fresh: "최근 것" }[seen]}`);
  }
  write(seen);
}
