import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lockDir, release, tryTake } from "../src/lock-queue.ts";
import { lockWorld } from "./lock-setup.ts";

const NAME = "demo";
const REAL_WRITE = fs.writeFileSync;
const CLAIM = ".takeover";

// Clearing a stale lock must never move or remove a lock that appeared in its place. A shell waiter can clear the stale
// lock and take a fresh one between the stale read and the takeover; the taker then claims, re-reads the owner line and
// finds it changed, so it stays out and the fresh holder keeps its lock (inbox-lock-order.md rule 4). Paused at the
// claim, with the other process's steps run there.

afterEach(() => mock.restore());

describe("stale recovery racing a fresh holder", () => {
  test("does not take a lock a shell waiter re-took in the meantime", () => {
    const w = lockWorld();
    const dir = lockDir(w.root, NAME);
    const fresh = "fresh 2026-11-14 09:00:00 pid=2";
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "owner"), "dead 2026-11-14 09:00:00 pid=99\n");
    w.live.add(2);
    // The window: another process clears the stale lock and takes a new one, with a live owner (pid 2).
    let armed = true;
    spyOn(fs, "writeFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, data: string, o?: never) => {
      if (armed && String(p).endsWith(CLAIM)) {
        armed = false;
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir);
        REAL_WRITE(join(dir, "owner"), `${fresh}\n`);
      }
      return REAL_WRITE(p, data, o as never);
    }) as never);
    const got = tryTake(w.env(1), NAME, "mine", () => {});
    expect(armed).toBe(false);
    expect("busy" in got).toBe(true);
    expect(fs.readFileSync(join(dir, "owner"), "utf8").trim()).toBe(fresh);
    release(w.root, NAME, fresh);
  });
});
