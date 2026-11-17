// The lead pulse: asks the runtime whether the lead is still there and writes `<stateDir>/lead-alive.json`. The lead is
// dead when its pane is gone, or when its program has died and only an interactive shell is left in the pane.
// Two dead answers in a row start the lead once, with the open orders as its first message: a gone pane the way `dori up`
// does (a new workspace), a leftover shell by typing the same start command into that shell, so the pane keeps its
// workspace, its duty and loop panes and its registration.
// Starting the lead sends nothing to the owner: a start that fails twice goes to the macmini as one line, and the macmini
// tells. The one line the MacBook itself sends to the shared room is about the macmini going quiet (mini-quiet.ts).
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { leadCommand, openLead } from "./cli-up.ts";
import { failureDetail } from "./delivery.ts";
import type { Deps } from "./harness.ts";
import { readConfig } from "./hooks.ts";
import { homeStateDir } from "./lane-model.ts";
import { acquire, release } from "./loop-lock.ts";
import { miniQuiet } from "./mini-quiet.ts";
import { ordersMine } from "./orders-mine.ts";
import type { Order } from "../tools/open_orders.ts";
import { refText } from "./refs.ts";
import { ompProcess } from "./runtime/omp.ts";
import type { Probe, SessionRef } from "./runtime/types.ts";

export type Pulse = { at: number; alive: boolean; openOrders: number; oldestMinutes: number; reviveFailed: boolean };
type Env = Readonly<Record<string, string | undefined>>;
type Note = (line: string) => void;

const TRIES = 2;
/** A start that began and left its mark this recently may still be running, or was killed before it registered the lead. */
const STARTING_MS = 10 * 60_000;

type Dead = "gone" | "shell";

/**
 * Why the lead is not there, if it is not. `shell`: no program of the lead's is in front and an interactive shell is, read
 * from a foreground list that was really read (a failed lookup is doubt, not death). `unknown` counts like `shell`: a
 * crashed omp leaves its state record behind, and the probe then reports `unknown` over the same shell. A shell in front
 * of a pane the runtime still reports as idle or working is a suspended agent (#66), which this leaves alone.
 */
function deadOf(p: Probe): Dead | undefined {
  if (p.status === "gone") return "gone";
  const front = p.foreground ?? [];
  const bare = (p.status === "shell" || p.status === "unknown") && p.shellInFront && front.length > 0;
  return bare && !front.some(ompProcess) ? "shell" : undefined;
}

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

const SHOWN = 10;

/** The count and the oldest SHOWN open orders as id, state and age, never a body or the whole list. */
function firstMessage(now: number, open: readonly Order[], dead: Dead): string {
  const oldest = open.slice(0, SHOWN).map((o) => `${o.id} ${o.state} ${Math.floor((now - o.at) / 60_000)}m`);
  const what =
    open.length === 0
      ? "no open orders"
      : `${open.length} open orders, the ${oldest.length} oldest: ${oldest.join("; ")}`;
  const why = dead === "gone" ? "was gone" : "held only a shell";
  const where = dead === "gone" ? "in its place" : "again in it";
  return `[LEAD-PULSE] Your pane ${why} on two checks in a row, so you were started ${where}. ${what}. Before you trust any memory run dori boot and dori orders --mine for the whole list; do not tell the owner you restarted.`;
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

/** When a start that never finished began, or undefined: its mark is removed by the start that ends, however it ends. */
function beganAt(file: string): number | undefined {
  try {
    const at: unknown = (JSON.parse(readFileSync(file, "utf8")) as { at?: unknown }).at;
    return typeof at === "number" ? at : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A new workspace for the lead, with a mark of the time written first and removed when this start ends. A pulse killed
 * between creating the workspace and registering the lead (the sync gives it a time limit) leaves the mark behind.
 */
async function openMarked(d: Deps, mark: string, first: string): Promise<SessionRef> {
  writeFileSync(mark, `${JSON.stringify({ at: d.now() })}\n`);
  try {
    return await openLead(d, leadCwd(d), first);
  } finally {
    rmSync(mark, { force: true });
  }
}

/**
 * The lead started again in the shell its program left behind. A start that threw may still have reached the shell, so a
 * second try first looks again: the command is never typed into a program that is running by then.
 */
async function startAgain(d: Deps, shell: SessionRef, first: string, retry: boolean): Promise<SessionRef> {
  const rt = d.runtimes.for(shell);
  if (retry && deadOf(await rt.probe(shell)) !== "shell") return shell;
  await rt.start(shell, leadCommand(d, first));
  return shell;
}

async function revive(
  d: Deps,
  env: Env,
  stateDir: string,
  pulse: Pulse,
  first: string,
  shell: SessionRef | undefined,
  note: Note,
): Promise<void> {
  const path = join(stateDir, "lead-pulse.lock");
  const lock = acquire(d, path);
  if ("holder" in lock) {
    note(`lead not started: ${lock.holder}`);
    return;
  }
  const mark = join(stateDir, "lead-starting.json");
  try {
    const began = shell === undefined ? beganAt(mark) : undefined;
    if (began !== undefined) {
      const since = new Date(began).toISOString();
      if (d.now() - began < STARTING_MS) {
        note(`a lead start begun at ${since} did not finish: waiting for it, not starting a second lead`);
        return;
      }
      note(`a lead start begun at ${since} never finished: starting again`);
    }
    let why = "";
    for (let i = 1; i <= TRIES; i++) {
      try {
        const ref = shell === undefined ? await openMarked(d, mark, first) : await startAgain(d, shell, first, i > 1);
        pulse.alive = true;
        note(`lead started in ${refText(ref)}${shell === undefined ? "" : " (the same pane, no new workspace)"}`);
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
 * One pulse. A runtime that cannot be asked throws and leaves the file as it was. After a failed start the incident is
 * reported once: the next dead answers neither start the lead nor tell the macmini again, until the lead is seen alive.
 * A home with no lead registered has nothing to watch and starts nothing. While the store's stop file exists
 * (`dori harness loop stop`) the file is still written but nothing is started or sent.
 */
export async function leadPulse(d: Deps, env: Env = process.env): Promise<Pulse> {
  const stateDir = homeStateDir(d.store.root);
  mkdirSync(stateDir, { recursive: true });
  const file = join(stateDir, "lead-alive.json");
  const note: Note = (line) =>
    appendFileSync(join(stateDir, "lead-pulse.log"), `${new Date(d.now()).toISOString()} ${line}\n`);
  const stopped = d.store.stop() !== undefined;
  if (!stopped)
    await miniQuiet(d, env, stateDir, note).catch((e: unknown) => note(`macmini pulse not read: ${failureDetail(e)}`));
  const before = readPulse(file);
  const now = d.now();
  const lead = d.store.roles().lead;
  const dead = lead === undefined ? undefined : deadOf(await d.runtimes.for(lead).probe(lead));
  const open = ordersMine(d.store.root, now).orders.filter((o) => o.state !== "닫힘");
  const oldest = open[0];
  const pulse: Pulse = {
    at: now,
    alive: lead !== undefined && dead === undefined,
    openOrders: open.length,
    oldestMinutes: oldest ? Math.floor((now - oldest.at) / 60_000) : 0,
    reviveFailed: false,
  };
  if (lead !== undefined && dead !== undefined) {
    if (before?.alive !== false) note(`lead pane ${dead === "gone" ? "gone" : "holds only a shell"}, first check`);
    else if (before.reviveFailed) pulse.reviveFailed = true;
    else if (!stopped)
      await revive(d, env, stateDir, pulse, firstMessage(now, open, dead), dead === "shell" ? lead : undefined, note);
  }
  writePulse(file, pulse);
  return pulse;
}
