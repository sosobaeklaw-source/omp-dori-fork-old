import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { done, ready, startLane } from "../src/lanes.ts";
import { spawnExec } from "../src/runtime/exec.ts";
import { setup } from "./harness-setup.ts";

// This test process plays omp's broker: services are its children, each leading its own process group.
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) {
    try {
      process.kill(-c.pid!, "SIGKILL");
    } catch (e) {
      // ESRCH: already gone; EPERM: macOS killpg on a group left with only unreaped zombies.
      if (!["ESRCH", "EPERM"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
    }
  }
});

function service(): ChildProcess {
  // `sh` stays the group leader and `sleep` its child, like `npm run dev` and the vite it spawns.
  const c = spawn("sh", ["-c", "sleep 60 & wait"], { detached: true, stdio: "ignore" });
  children.push(c);
  return c;
}

function exited(c: ChildProcess): Promise<NodeJS.Signals | null> {
  const { promise, resolve } = Promise.withResolvers<NodeJS.Signals | null>();
  if (c.exitCode !== null || c.signalCode !== null) resolve(c.signalCode);
  else c.once("exit", (_code: number | null, signal: NodeJS.Signals | null) => resolve(signal));
  return promise;
}

type Rec = { name: string; pid: number; state?: string; lane: string; home: string; startedAt?: number };

function record(run: string, broker: number, r: Rec) {
  const dir = join(run, "daemons", "scope1", "daemons", r.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(run, "daemons", "scope1", "broker.pid"), JSON.stringify({ pid: broker }));
  const daemon = { name: r.name, state: r.state ?? "ready", pid: r.pid, startedAt: r.startedAt ?? 1 };
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ daemon }));
  writeFileSync(join(dir, "spec.json"), JSON.stringify({ env: { DORI_LANE: r.lane, DORI_HOME: r.home } }));
}

const alive = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;

describe("done stops the lane's omp named services", () => {
  test("only the closed lane's live services under the broker get SIGTERM; a re-run on a done lane sweeps", async () => {
    const run = mkdtempSync(join(tmpdir(), "dori-omp-run-"));
    const { d: base, brief } = setup();
    const d = { ...base, exec: spawnExec, ompRunDir: run };
    const home = d.store.root;
    const lane = "fix-login";
    const [mine, other, ended, sideHome, reused] = [service(), service(), service(), service(), service()];
    record(run, process.pid, { name: "vite", pid: mine.pid!, lane, home: `${home}/.` });
    record(run, process.pid, { name: "other-lane", pid: other.pid!, lane: "someone-else", home });
    record(run, process.pid, { name: "failed-before", pid: ended.pid!, state: "failed", lane, home });
    record(run, process.pid, { name: "not-a-broker-child", pid: process.pid, lane, home });
    record(run, process.pid, { name: "same-key-other-home", pid: sideHome.pid!, lane, home: `${home}-side` });
    // The pid of an old record of this lane now belongs to a newer service of another lane.
    record(run, process.pid, { name: "old-vite", pid: reused.pid!, lane, home, startedAt: 1 });
    record(run, process.pid, { name: "new-owner", pid: reused.pid!, lane: "someone-else", home, startedAt: 2 });

    await startLane(d, lane, brief, { group: "w1" });
    await ready(d, lane, "fixed", ["https://github.com/o/r/pull/1"]);
    expect(await done(d, lane)).toEqual(["vite"]);
    expect(await exited(mine)).toBe("SIGTERM");
    for (const c of [other, ended, sideHome, reused]) expect(alive(c)).toBe(true);
    expect(d.store.lane(lane)!.status).toBe("done");

    const late = service();
    record(run, process.pid, { name: "vite-late", pid: late.pid!, lane, home });
    expect(await done(d, lane)).toEqual(["vite-late"]);
    expect(await exited(late)).toBe("SIGTERM");
  });
});
