// The macmini's own pulse as the sync copied it to `<stateDir>/macmini/lead-alive.json`. When its `at` is more than 15
// minutes old the shared room gets one line, once per incident: the next one only after the file was fresh again. A
// missing or unreadable file sends nothing. The macmini never does this for the MacBook: a closed lid is not a failure.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { failureDetail } from "./delivery.ts";
import type { Deps } from "./harness.ts";

const QUIET_MIN = 15;
type Seen = "missing" | "unreadable" | "fresh" | "stale";

function seenOf(file: string, now: number): { seen: Seen; minutes: number } {
  if (!existsSync(file)) return { seen: "missing", minutes: 0 };
  let at: unknown;
  try {
    at = (JSON.parse(readFileSync(file, "utf8")) as { at?: unknown }).at;
  } catch {}
  if (typeof at !== "number") return { seen: "unreadable", minutes: 0 };
  return { seen: now - at > QUIET_MIN * 60_000 ? "stale" : "fresh", minutes: Math.floor((now - at) / 60_000) };
}

/** The line goes out through `DORI_ROOM_SEND` (default `DORI_HOME/bin/ompdori-send.sh`, which posts to the shared room). */
export async function miniQuiet(
  d: Deps,
  env: Readonly<Record<string, string | undefined>>,
  stateDir: string,
  note: (line: string) => void,
): Promise<void> {
  const marker = join(stateDir, "macmini-pulse.json");
  const { seen, minutes } = seenOf(join(stateDir, "macmini", "lead-alive.json"), d.now());
  let before: unknown;
  try {
    before = (JSON.parse(readFileSync(marker, "utf8")) as { seen?: unknown }).seen;
  } catch {}
  if (seen === before) return;
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
  writeFileSync(marker, `${JSON.stringify({ seen })}\n`);
}
