import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

function omp(agentCmd = "omp") {
  const s = setup();
  const d = { ...s.d, agentCmd };
  const state = join(d.store.root, "omp-state");
  const pin = join(state, "next-lane-model");
  const config = (extra: object) =>
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ stateDir: state, ...extra }));
  const leadPin = (value: string) => {
    mkdirSync(state, { recursive: true });
    writeFileSync(pin, value);
  };
  const ran = (key: string) => s.w.panes.get(d.store.lane(key)!.paneId)!.ran[0]!;
  const tick = () => loopTick(d, { force: true, maxStarts: 1 });
  return { ...s, d, pin, config, leadPin, ran, tick };
}

test("the loop starts each OMP lane on config.json loopLaneModel and never touches a lead's pin", async () => {
  const { add, pin, config, leadPin, ran, tick } = omp();
  config({});
  add("unpinned");
  expect((await tick()).started).toEqual(["unpinned (p5)"]);
  expect(ran("unpinned")).toStartWith(`omp --dori-role lane ${KICKOFF}`);

  config({ loopLaneModel: "p/m|high" });
  leadPin("lead/own|low");
  add("pinned");
  expect((await tick()).started).toEqual(["pinned (p5)"]);
  expect(ran("pinned")).toStartWith(`omp --dori-role lane --model 'p/m' --thinking 'high' ${KICKOFF}`);
  expect(readFileSync(pin, "utf8")).toBe("lead/own|low");
});

test("a lead's hand-written pin is taken once; an explicit --model wins over both pin and loop model", async () => {
  const { d, brief, pin, config, leadPin, ran } = omp();
  config({});
  leadPin("x/y\n");
  await startLane(d, "first", brief, { cwd: d.store.root });
  expect(ran("first")).toStartWith(`omp --dori-role lane --model 'x/y' ${KICKOFF}`);
  await startLane(d, "second", brief, { cwd: d.store.root });
  expect(ran("second")).toStartWith(`omp --dori-role lane ${KICKOFF}`);
  expect(existsSync(pin)).toBe(false);

  const explicit = omp("omp --model a/b");
  explicit.config({ loopLaneModel: "p/m|high" });
  explicit.leadPin("x/y|low");
  explicit.add("explicit");
  expect((await explicit.tick()).started).toEqual(["explicit (p5)"]);
  expect(explicit.ran("explicit")).toStartWith(`omp --model a/b --dori-role lane ${KICKOFF}`);
  expect(readFileSync(explicit.pin, "utf8")).toBe("x/y|low");
});

test("an invalid loopLaneModel holds every start with one config message and counts against no item", async () => {
  const { d, add, config, tick } = omp();
  config({ loopLaneModel: "a b" });
  add("one");
  add("two");
  for (let run = 0; run < 3; run++) {
    const r = await tick();
    expect(r.started).toEqual([]);
    expect(r.findings).toEqual([]);
    expect(r.held[0]).toBe('config.json: loopLaneModel must look like "provider/model" or "provider/model|thinking"');
    expect(r.held).toHaveLength(2);
  }
  expect(d.store.items().map((i) => [i.id, i.startFailures, i.decision])).toEqual([
    ["one", undefined, undefined],
    ["two", undefined, undefined],
  ]);
});
