import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CALL_REST_MS, lostRun } from "../src/writer-seat-log.ts";
import { restingUntil } from "../src/writer-seat.ts";

function home() {
  const h = mkdtempSync("/tmp/dwsl-");
  mkdirSync(join(h, "state"));
  return h;
}
const lost = (at: string) => `${at}\tu0\tlost\t14`;
const log = (h: string, rows: string[]) =>
  writeFileSync(join(h, "state", "writer-calls-u0.tsv"), `${rows.join("\n")}\n`);

describe("lost answer rest", () => {
  test("the rest runs from the loss that completed the third, so one more later does not rest it again", () => {
    const h = home();
    log(h, [
      lost("2026-11-16T00:00:00.000Z"),
      lost("2026-11-16T00:10:00.000Z"),
      lost("2026-11-16T00:20:00.000Z"),
      lost("2026-11-16T01:00:00.000Z"),
    ]);
    const run = lostRun(h, "u0");
    expect(run.streak).toBe(4);
    // Counted from the third loss (00:20), not from the fourth at 01:00.
    expect(run.until).toBe(Date.parse("2026-11-16T00:20:00.000Z") + CALL_REST_MS);
    // That window ended at 00:50, so the seat is free again instead of resting until 01:30.
    expect(restingUntil(h, "u0", Date.parse("2026-11-16T01:00:00.000Z"))).toBeUndefined();
  });

  test("the sixth loss doubles the rest and is still the row the time is counted from", () => {
    const h = home();
    const rows = ["00:00", "00:10", "00:20", "00:30", "00:40", "05:00"].map((t) => lost(`2026-11-16T${t}:00.000Z`));
    log(h, rows);
    const run = lostRun(h, "u0");
    expect([run.streak, run.until]).toEqual([6, Date.parse("2026-11-16T05:00:00.000Z") + 2 * CALL_REST_MS]);
  });

  test("a success resets the run", () => {
    const h = home();
    log(h, [
      lost("2026-11-16T00:00:00.000Z"),
      "2026-11-16T00:05:00.000Z\tu0\tsuccess\t0",
      lost("2026-11-16T00:10:00.000Z"),
    ]);
    expect(lostRun(h, "u0")).toEqual({ streak: 1, until: 0 });
  });
});
