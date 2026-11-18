import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeStateDir } from "../src/lane-model.ts";
import { miniQuiet } from "../src/mini-quiet.ts";
import { href, World } from "./fake.ts";

const T0 = Date.UTC(2026, 10, 17, 12, 0, 0);
export const MIN = 60_000;
const ROOM = "/fake/ompdori-send.sh";

export function setup() {
  const w = new World();
  w.clock = T0;
  w.addPane("w1:p1", "idle");
  const d = w.deps();
  d.store.setRole("lead", href("w1:p1"));
  const state = homeStateDir(d.store.root);
  mkdirSync(join(state, "macmini"), { recursive: true });
  const env: Record<string, string | undefined> = { DORI_ROOM_SEND: ROOM };
  const notes: string[] = [];
  const mini = (secondsOld: number) =>
    writeFileSync(
      join(state, "macmini", "lead-alive.json"),
      JSON.stringify({ at: w.clock - secondsOld * 1000, alive: true }),
    );
  /** What the macmini's own pulse writes: `at` in epoch seconds, with the extra fields it carries. */
  const miniSeconds = (secondsOld: number) =>
    writeFileSync(
      join(state, "macmini", "lead-alive.json"),
      JSON.stringify({ at: Math.floor(w.clock / 1000) - secondsOld, alive: true, kind: "herdr", revivedAt: null }),
    );
  /** A marker from an earlier run, so the check under test is not the first one that looked. */
  const seed = (seen: string) =>
    writeFileSync(join(state, "macmini-pulse.json"), JSON.stringify({ seen, fetched: true }));
  const fetchedAt = (at: number | null) => {
    env["DORI_MINI_FETCHED_AT"] = at === null ? undefined : String(at);
  };
  const check = (at: number | null = w.clock) => {
    fetchedAt(at);
    return miniQuiet(d, env, state, (line) => notes.push(line));
  };
  const sent = () => w.calls.filter((c) => c.cmd === ROOM).map((c) => c.argv);
  const marker = () =>
    JSON.parse(readFileSync(join(state, "macmini-pulse.json"), "utf8")) as { seen: string; fetched: boolean };
  return { w, d, state, env, notes, mini, miniSeconds, seed, check, fetchedAt, sent, marker };
}
