import { describe, expect, spyOn, test } from "bun:test";
import { enqueue, tickets } from "../src/lock-queue.ts";
import { lockWorld } from "./lock-setup.ts";

const NAME = "demo";

// Two waiters that arrive in the same millisecond must keep their arrival order: the queue is a line, not a lottery.
// The ticket id carried a random suffix, so equal-priority, equal-time tickets were ordered by that suffix, and a later
// waiter could go first. One serialized arrival sequence orders them (inbox-lock-order.md: ticket publication and the
// head check are one serialized step).

describe("same-millisecond arrivals", () => {
  test("are ordered by arrival, not by a random suffix", () => {
    const w = lockWorld();
    const env = w.env(7);
    // Every ticket gets the same time, and the random suffixes hand out in descending order.
    let n = 0;
    spyOn(crypto, "randomUUID").mockImplementation(
      (() => `ffffffff-0000-0000-0000-${String(9 - n++).padStart(12, "0")}`) as never,
    );
    const lanes = Array.from({ length: 6 }, (_, i) => `a${i}`);
    for (const lane of lanes) enqueue(env, NAME, lane, 5);
    expect(tickets(env, NAME).map((t) => t.lane)).toEqual(lanes);
  });
});
