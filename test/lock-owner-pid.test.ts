import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lockDir, tryTake } from "../src/lock-queue.ts";
import { lockWorld } from "./lock-setup.ts";

const NAME = "demo";

// The owner line names the waiter's pid. Once the command starts, the line also names the command (`cmd=<pid>`). If the
// waiter is killed with SIGKILL while its command keeps running, the next waiter sees a dead waiter pid; the live
// command pid must keep the lock, or a second command starts against the same resource (inbox-lock-order.md: ownership
// covers the protected command).

describe("a waiter killed while its command keeps running", () => {
  test("leaves a lock the next waiter does not clear while the command lives", () => {
    const w = lockWorld();
    const command = 77;
    w.live.add(command);
    const dir = lockDir(w.root, NAME);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "owner"), "mine 2026-11-14 09:00:00 pid=2 cmd=77\n");
    // The waiter (pid 2) is dead; the command (pid 77) is not.
    const got = tryTake(w.env(3), NAME, "other", () => {});
    expect("busy" in got).toBe(true);
    expect(w.live.has(command)).toBe(true);
  });
});
