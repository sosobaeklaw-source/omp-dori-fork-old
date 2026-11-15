import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startLane } from "../src/lanes.ts";
import { loopTick } from "../src/loop.ts";
import { setup } from "./loop-setup.ts";

// The home's own config decides the state directory here, not the environment of the shell running the tests.
const saved = ["DORI_STATE_DIR", "DORI_CONFIG"].map((k) => [k, process.env[k]] as const);
beforeEach(() => {
  for (const [k] of saved) delete process.env[k];
});
afterEach(() => {
  for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
});

const KICKOFF = "'Read your brief at ";

function omp() {
  // `workspace create` failing is a start that dies after the pin is written and before any pane runs.
  const failing = { create: false };
  const s = setup({
    exec: (inner) => (cmd, argv, o) =>
      failing.create && argv[0] === "workspace"
        ? Promise.resolve({ code: 1, stdout: "", stderr: "no" })
        : inner(cmd, argv, o),
  });
  const d = { ...s.d, agentCmd: "omp" };
  const state = join(d.store.root, "omp-state");
  const pin = join(state, "next-lane-model");
  const config = (extra: object) =>
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ stateDir: state, ...extra }));
  const ran = (key: string) => s.w.panes.get(d.store.lane(key)!.paneId)!.ran[0]!;
  const tick = () => loopTick(d, { force: true, maxStarts: 1 });
  return { ...s, d, pin, config, ran, tick, failing };
}

test("the loop starts each OMP lane on config.json loopLaneModel; no setting leaves the command as it was", async () => {
  const { add, pin, config, ran, tick } = omp();
  config({});
  add("unpinned");
  expect((await tick()).started).toEqual(["unpinned (p5)"]);
  expect(ran("unpinned")).toStartWith(`omp --dori-role lane ${KICKOFF}`);

  // The state directory does not exist yet: the loop creates it for the pin.
  config({ loopLaneModel: "p/m|high" });
  add("pinned");
  expect((await tick()).started).toEqual(["pinned (p5)"]);
  expect(ran("pinned")).toStartWith(`omp --dori-role lane --model 'p/m' --thinking 'high' ${KICKOFF}`);
  expect(existsSync(pin)).toBe(false);
});

test("an invalid loopLaneModel or a start that fails before its pane opens leaves no pin for a later lane", async () => {
  const { d, add, brief, pin, config, ran, tick, failing } = omp();
  config({ loopLaneModel: "a b" });
  add("bad-pin");
  const bad = await tick();
  expect(bad.started).toEqual([]);
  expect(bad.findings[0]).toStartWith("start bad-pin failed: config.json: loopLaneModel must look like");

  config({ loopLaneModel: "p/m|high" });
  add("no-workspace", { priority: 1 });
  failing.create = true;
  const failed = await tick();
  failing.create = false;
  expect(failed.started).toEqual([]);
  expect(failed.findings[0]).toStartWith("start no-workspace failed:");
  expect(existsSync(pin)).toBe(false);

  // A lead's own `start` with no pin of its own, after those failures, does not get the loop's model.
  config({});
  await startLane(d, "by-hand", brief, { cwd: d.store.root });
  expect(ran("by-hand")).toStartWith(`omp --dori-role lane ${KICKOFF}`);
});

test("startLane takes a lead's hand-written pin once, and an explicit --model in the command wins over it", async () => {
  const { d, brief, pin, config, ran } = omp();
  config({});
  mkdirSync(join(pin, ".."), { recursive: true });
  writeFileSync(pin, "x/y\n");
  await startLane(d, "first", brief, { cwd: d.store.root });
  expect(ran("first")).toStartWith(`omp --dori-role lane --model 'x/y' ${KICKOFF}`);
  await startLane(d, "second", brief, { cwd: d.store.root });
  expect(ran("second")).toStartWith(`omp --dori-role lane ${KICKOFF}`);

  writeFileSync(pin, "x/y|low");
  await startLane({ ...d, agentCmd: "omp --model a/b" }, "explicit", brief, { cwd: d.store.root });
  expect(ran("explicit")).toStartWith(`omp --model a/b --dori-role lane ${KICKOFF}`);
  expect(existsSync(pin)).toBe(true);
});
