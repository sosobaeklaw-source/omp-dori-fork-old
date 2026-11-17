import { describe, expect, test } from "bun:test";
import { ready, startLane } from "../src/lanes.ts";
import { HOUR } from "../src/loop.ts";
import { setup } from "./loop-setup.ts";

/** Hours 1..14 after a lane went READY, one forced run each; returns the hours whose run named the lane. */
async function namedHours(leadDown: (h: number) => boolean): Promise<number[]> {
  let down = false;
  const { w, d, brief, tick } = setup({
    exec: (inner) => async (cmd, argv, o) =>
      down && cmd === "herdr" && argv[0] === "agent" && argv[2] === "w1:p1"
        ? { code: 1, stdout: "", stderr: "lead pane hung" }
        : inner(cmd, argv, o),
  });
  const fin = await startLane(d, "finished", brief, { group: "w1" });
  await ready(d, "finished", "done", ["https://github.com/acme/app/pull/3"]);
  w.panes.get(fin.paneId)!.status = "idle";
  w.gh = () => ({ code: 0, stdout: JSON.stringify({ state: "OPEN" }) });
  const named: number[] = [];
  for (let h = 1; h <= 14; h++) {
    w.clock += HOUR;
    down = leadDown(h);
    if ((await tick({ maxStarts: 0 })).findings.some((f) => f.startsWith("finished READY"))) named.push(h);
  }
  return named;
}

describe("unclosed READY reminders", () => {
  test("an unclosed READY lane is named at 2h, then only every 6h, not every hourly run", async () => {
    expect(await namedHours(() => false)).toEqual([2, 8, 14]);
  });

  test("a reminder whose report never reached the lead is named again on the next run", async () => {
    expect(await namedHours((h) => h === 2 || h === 8)).toEqual([2, 3, 8, 9, 14]);
  });
});
