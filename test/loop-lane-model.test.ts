import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setup } from "./loop-setup.ts";

// The home's own config decides the state directory here, not the environment of the shell running the tests.
const saved = ["DORI_STATE_DIR", "DORI_CONFIG"].map((k) => [k, process.env[k]] as const);
beforeEach(() => {
  for (const [k] of saved) delete process.env[k];
});
afterEach(() => {
  for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
});

test("the loop pins config.json loopLaneModel to the OMP state directory before each start; no setting writes no pin", async () => {
  const { d, add, tick } = setup();
  const state = join(d.store.root, "omp-state");
  mkdirSync(state);
  const pin = join(state, "next-lane-model");
  const config = (extra: object) =>
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ stateDir: state, ...extra }));
  config({});
  add("unpinned");
  expect((await tick({ maxStarts: 1 })).started).toEqual(["unpinned (p5)"]);
  expect(existsSync(pin)).toBe(false);

  config({ loopLaneModel: "p/m|high" });
  add("pinned");
  expect((await tick({ maxStarts: 1 })).started).toEqual(["pinned (p5)"]);
  expect(readFileSync(pin, "utf8")).toBe("p/m|high");

  config({ loopLaneModel: "a b" });
  add("bad-pin");
  const bad = await tick({ maxStarts: 1 });
  expect(bad.started).toEqual([]);
  expect(bad.findings[0]).toStartWith("start bad-pin failed: config.json: loopLaneModel must look like");
  expect(d.store.lane("bad-pin")).toBeUndefined();
});
