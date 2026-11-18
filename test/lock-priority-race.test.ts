import { describe, expect, test } from "bun:test";
import { enqueue, holder, release, take } from "../src/lock-queue.ts";
import { lockWorld } from "./lock-setup.ts";

const NAME = "demo";
const never = new AbortController().signal;

// A p5 waiter that finds itself at the head can be overtaken by a p1 that arrives before it actually takes the lock,
// and then runs ahead of it. Taking the lock has to be conditional on still being the head: a waiter that was overtaken
// hands the lock straight back and waits its turn (inbox-lock-order.md: the head check and the take are serialized).

describe("a waiter overtaken between the head check and the take", () => {
  test("never runs while a higher-priority waiter is in line ahead of it", async () => {
    const w = lockWorld();
    const env = w.env(2);
    let took: string | undefined;
    // The p5 waiter is queued; the p1 arrives in the same turn, before the p5 one takes the free lock.
    const p5 = take(env, NAME, "p5-lane", 5, never).then((owner) => {
      took = owner && holder(w.root, NAME)?.lane;
      return owner;
    });
    enqueue({ ...env, pid: 3 }, NAME, "p1-lane", 1);
    await w.turn();
    // Either the p5 waiter has not taken it yet, or it handed it back: never "p5-lane" as the holder here.
    expect(took).not.toBe("p5-lane");
    // p1 goes next.
    const p1 = await take({ ...env, pid: 3 }, NAME, "p1-lane", 1, never);
    expect(p1 && holder(w.root, NAME)?.lane).toBe("p1-lane");
    release(w.root, NAME, p1 as string);
    void p1;
    const got = await p5;
    release(w.root, NAME, got as string);
  });
});
