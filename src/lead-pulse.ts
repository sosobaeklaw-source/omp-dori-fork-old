// The lead pulse: asks the runtime whether the lead's pane is still there and writes `<stateDir>/lead-alive.json`.
// Two dead answers in a row start the lead once, the way `dori up` does, with the open orders as its first message.
// Starting the lead sends nothing to the owner: a start that fails twice goes to the macmini as one line, and the macmini
// tells. The one line the MacBook itself sends to the shared room is about the macmini going quiet (mini-quiet.ts).
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openLead } from "./cli-up.ts";
import { failureDetail } from "./delivery.ts";
import type { Deps } from "./harness.ts";
import { readConfig } from "./hooks.ts";
import { homeStateDir } from "./lane-model.ts";
import { acquire, release } from "./loop-lock.ts";
import { miniQuiet } from "./mini-quiet.ts";
import { ordersMine, ordersText } from "./orders-mine.ts";
import { refText } from "./refs.ts";

export type Pulse = { at: number; alive: boolean; openOrders: number; oldestMinutes: number; reviveFailed: boolean };
type Env = Readonly<Record<string, string | undefined>>;
type Note = (line: string) => void;

const TRIES = 2;

function readPulse(file: string): Pulse | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Pulse;
  } catch {
    return undefined;
  }
}

/** Written whole through a rename, so the sync that copies it to the other Mac never takes half a file. */
function writePulse(file: string, pulse: Pulse): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(pulse)}\n`);
  renameSync(tmp, file);
}

/** The lead starts where the home's config.json says; a scheduled run's own cwd is `/`. */
function leadCwd(d: Deps): string {
  const cwd: unknown = Reflect.get(readConfig(d.store.root), "defaultCwd");
  return typeof cwd === "string" && cwd !== "" ? cwd : d.store.root;
}

function firstMessage(d: Deps): string {
  const orders = ordersText(d.store.root, d.now()).join(" | ");
  return `[LEAD-PULSE] Your pane was gone on two checks in a row, so you were started in its place. Before you trust any memory run dori boot and dori orders --mine; do not tell the owner you restarted. Open orders now: ${orders}`;
}

/** `to-macmini.sh` (or `DORI_TO_MACMINI`) takes the line as the report's title; the macmini lead reads it from there. */
async function tellMacmini(d: Deps, env: Env, line: string, note: Note): Promise<void> {
  const sender = env["DORI_TO_MACMINI"] ?? join(d.store.root, "bin", "to-macmini.sh");
  try {
    const r = await d.exec(sender, [line]);
    note(r.code === 0 ? `told the macmini: ${line}` : `macmini not told (exit ${r.code}): ${line}`);
  } catch (e) {
    note(`macmini not told (${failureDetail(e)}): ${line}`);
  }
}

async function revive(d: Deps, env: Env, stateDir: string, pulse: Pulse, note: Note): Promise<void> {
  const path = join(stateDir, "lead-pulse.lock");
  const lock = acquire(d, path);
  if ("holder" in lock) {
    note(`lead not started: ${lock.holder}`);
    return;
  }
  try {
    let why = "";
    for (let i = 1; i <= TRIES; i++) {
      try {
        const ref = await openLead(d, leadCwd(d), firstMessage(d));
        pulse.alive = true;
        note(`lead started in ${refText(ref)}`);
        return;
      } catch (e) {
        why = failureDetail(e);
        note(`lead start ${i} of ${TRIES} failed: ${why}`);
      }
    }
    pulse.reviveFailed = true;
    await tellMacmini(d, env, `맥북 리드 창이 사라졌고 두 번 다시 세우지 못했다: ${why}`, note);
  } finally {
    release(d, lock.nonce, path);
  }
}

/**
 * One pulse. `gone` is the one dead answer; a runtime that cannot be asked throws and leaves the file as it was. After
 * a failed start the incident is reported once: the next dead answers neither start the lead nor tell the macmini
 * again, until the pane is seen alive. A home with no lead registered has nothing to watch and starts nothing.
 */
export async function leadPulse(d: Deps, env: Env = process.env): Promise<Pulse> {
  const stateDir = homeStateDir(d.store.root);
  mkdirSync(stateDir, { recursive: true });
  const file = join(stateDir, "lead-alive.json");
  const note: Note = (line) =>
    appendFileSync(join(stateDir, "lead-pulse.log"), `${new Date(d.now()).toISOString()} ${line}\n`);
  await miniQuiet(d, env, stateDir, note).catch((e: unknown) => note(`macmini pulse not read: ${failureDetail(e)}`));
  const before = readPulse(file);
  const now = d.now();
  const lead = d.store.roles().lead;
  const gone = lead !== undefined && (await d.runtimes.for(lead).probe(lead)).status === "gone";
  const open = ordersMine(d.store.root, now).orders.filter((o) => o.state !== "닫힘");
  const oldest = open[0];
  const pulse: Pulse = {
    at: now,
    alive: lead !== undefined && !gone,
    openOrders: open.length,
    oldestMinutes: oldest ? Math.floor((now - oldest.at) / 60_000) : 0,
    reviveFailed: false,
  };
  if (gone && before?.alive !== false) note("lead pane gone, first check");
  if (gone && before?.alive === false) {
    if (before.reviveFailed) pulse.reviveFailed = true;
    else await revive(d, env, stateDir, pulse, note);
  }
  writePulse(file, pulse);
  return pulse;
}
