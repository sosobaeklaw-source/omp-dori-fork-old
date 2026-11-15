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
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
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

function record(run: string, broker: number, name: string, pid: number, state: string, lane?: string) {
  const dir = join(run, "daemons", "scope1", "daemons", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(run, "daemons", "scope1", "broker.pid"), JSON.stringify({ pid: broker }));
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ daemon: { name, state, pid, startedAt: 1 } }));
  writeFileSync(join(dir, "spec.json"), JSON.stringify({ env: lane === undefined ? {} : { DORI_LANE: lane } }));
}

describe("done stops the lane's omp named services", () => {
  test("only the closed lane's live services under the broker get SIGTERM; a re-run on a done lane sweeps", async () => {
    const run = mkdtempSync(join(tmpdir(), "dori-omp-run-"));
    const { d: base, brief } = setup();
    const d = { ...base, exec: spawnExec, ompRunDir: run };
    const mine = service();
    const other = service();
    const ended = service();
    record(run, process.pid, "vite", mine.pid!, "ready", "fix-login");
    record(run, process.pid, "other-lane", other.pid!, "ready", "someone-else");
    record(run, process.pid, "failed-before", ended.pid!, "failed", "fix-login");
    record(run, process.pid, "not-a-broker-child", process.pid, "ready", "fix-login");

    await startLane(d, "fix-login", brief, { group: "w1" });
    await ready(d, "fix-login", "fixed", ["https://github.com/o/r/pull/1"]);
    expect(await done(d, "fix-login")).toEqual(["vite"]);
    expect(await exited(mine)).toBe("SIGTERM");
    expect(other.exitCode === null && other.signalCode === null).toBe(true);
    expect(ended.exitCode === null && ended.signalCode === null).toBe(true);
    expect(d.store.lane("fix-login")!.status).toBe("done");

    const late = service();
    record(run, process.pid, "vite-late", late.pid!, "ready", "fix-login");
    expect(await done(d, "fix-login")).toEqual(["vite-late"]);
    expect(await exited(late)).toBe("SIGTERM");
  });
});
