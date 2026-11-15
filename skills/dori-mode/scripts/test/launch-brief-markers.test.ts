import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { prepareLaunch } from "../src/launch.ts";
import { LESSONS_START } from "../src/launch-footer.ts";
import { Lessons } from "../src/lessons.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-10-29T00:00:00Z");

test("a brief that quotes the lessons marker ships whole on first launch and again on relaunch", async () => {
  // Given a brief that quotes launch's lessons marker line and a repo lesson that matches it.
  const state = withState();
  try {
    const deps = depsFor(newWorld(), fakeClock(T0), state.dir);
    const brief = join(state.dir, "brief.md");
    const original = `Subscribe before triggering the fixture work.\n${LESSONS_START}\nThen keep the work below that quoted marker.`;
    writeFileSync(brief, original);
    new Lessons(state.dir).add({ lane: "old", cwd: "/repo", rule: "Subscribe before triggering", evidence: "/e" }, T0);
    const input = { key: "marker-lane", title: "QA", brief, done: "merged acme/app#1", cwd: "/repo" };
    // When launch writes its text over the brief and is prepared again from that file.
    const first = (await prepareLaunch(deps, input)).preamble;
    writeFileSync(brief, first);
    const again = (await prepareLaunch(deps, input)).preamble;
    // Then both carry the owner text whole, with one lessons block.
    expect(first).toContain(original);
    expect(again).toBe(first);
    expect(again.split("## Lessons for this repo").length - 1).toBe(1);
  } finally {
    state.done();
  }
});
