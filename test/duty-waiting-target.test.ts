import { describe, expect, test } from "bun:test";
import { dutyTick } from "../src/duty.ts";
import { hhmm } from "../src/fit.ts";
import { report, startLane } from "../src/lanes.ts";
import { audit } from "../src/loop-audit.ts";
import { laneBoard } from "../src/status-view.ts";
import type { LoopRun } from "../src/store-types.ts";
import { setup } from "./harness-setup.ts";

const MIN = 60_000;
// A CI job link with no space in it: any prefix of it names no job, and a long lane key leaves a short prefix.
const URL =
  "https://github.com/example-org/example-repo/actions/runs/123456789012/job/987654321098?check_suite_focus=true";

/** A 41-character lane key, its idle pane waiting on `target`; `at(m)` runs one duty pass m minutes after it started. */
async function longWait(target = URL) {
  const s = setup();
  const key = `k${"-long".repeat(8)}`;
  const lane = await startLane(s.d, key, s.brief, { group: "w1" });
  const pane = s.w.panes.get(lane.paneId)!;
  pane.status = "idle";
  await report(s.d, key, "WAITING: CI", { status: "waiting", waitingFor: target });
  const at = (min: number) => {
    s.w.clock = lane.createdAt + min * MIN;
    return dutyTick(s.d);
  };
  return { ...s, key, lane, pane, at };
}

const within120 = (lines: readonly string[]) => {
  for (const l of lines) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(120);
};

describe("a long waiting target or evidence link", () => {
  test("the nudge keeps its first line short and names the whole target in its body", async () => {
    const { key, lane, pane, at } = await longWait();
    expect(await at(10)).toContainEqual({ lane: key, action: "nudge-1" });
    const lines = pane.received.at(-1)!.split("\n");
    expect(lines[0]).toMatch(
      new RegExp(`^\\[duty -> ${key}\\] Waiting on https://\\S*… since ${hhmm(lane.createdAt)};`),
    );
    expect(lines.slice(1)).toContain(`  ${URL}`);
    // The command lines hold the key whole and run past 120 columns; the lines naming the target do not.
    within120(lines.filter((l) => !l.includes("`")));
  });

  test("a target longer than a line is wrapped whole, every part of it indented", async () => {
    const target = `${URL} then the deploy of release 2026.11.15-rc3 to the staging cluster eu-west-1`;
    const { pane, at } = await longWait(target);
    await at(10);
    const lines = pane.received.at(-1)!.split("\n");
    const parts = lines.slice(1).filter((l) => l.startsWith("  "));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((l) => l.slice(2)).join(" ")).toBe(target);
    within120(parts);
  });

  test("the escalation keeps its short waiting line and names the whole target under it", async () => {
    const { key, lane, lead, at } = await longWait();
    expect(await at(40)).toContainEqual({ lane: key, action: "escalated" });
    const lines = lead.received.at(-1)!.split("\n");
    expect(lines[1]).toMatch(new RegExp(`^waiting on https://\\S*… since ${hhmm(lane.createdAt)}$`));
    expect(lines[2]).toBe(`  ${URL}`);
    expect(lines[3]).toStartWith("pane idle, ");
    expect(lines.filter((l) => l.startsWith("[ESCALATE"))).toHaveLength(1);
    within120(lines);
  });

  test("the board keeps the lane on its line and puts the whole target below it when the line cut it", async () => {
    const { d, w, key, lane } = await longWait();
    const lines = laneBoard(d.store.lanes(), w.clock);
    expect(lines[0]).toMatch(new RegExp(`^${key} .* waiting: https://\\S*… since ${hhmm(lane.createdAt)}`));
    expect(lines).toContain(`  ${URL}`);
    within120(lines);
    await report(d, key, "x", { status: "waiting", waitingFor: "CI 812" });
    expect(laneBoard(d.store.lanes(), w.clock)).toHaveLength(1);
  });

  test("the hourly audit names the whole target", async () => {
    const { d, w, key, lane } = await longWait();
    w.clock = lane.createdAt + 4 * 60 * MIN;
    const run: LoopRun = { at: w.clock, synced: [], findings: [], started: [], held: [], asked: [] };
    await audit(d, run);
    expect(run.findings).toEqual([`${key} waiting, no progress for 4h: on ${URL} since ${hhmm(lane.createdAt)}`]);
  });

  test("the escalation names the whole last evidence under its line when the line cut it", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "talker", brief, { group: "w1" });
    w.panes.get(lane.paneId)!.status = "idle";
    await report(d, "talker", "CI is running", { evidence: [URL] });
    w.clock = lane.createdAt + 41 * MIN;
    expect(await dutyTick(d)).toContainEqual({ lane: "talker", action: "escalated" });
    const lines = lead.received.at(-1)!.split("\n");
    expect(lines[2]).toMatch(/^last evidence: …\S+ @ \d\d:\d\d\. Next: check the lane/);
    expect(lines.slice(3)).toEqual([`  ${URL}`]);
    within120(lines);
  });
});
