import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { Slack } from "../src/messenger/slack.ts";
import { pollSlackInbound } from "../src/messenger/slack-inbound.ts";
import { ThreadLedger } from "../src/messenger/thread-ledger.ts";
import { fakeClock, type TestState, withState } from "./fakes.ts";

let state: TestState;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

const openSync = fs.openSync;
const threads = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ channel: `C${i}`, rootTs: "1.0", seenTs: "1.0" }));
const updates = (count: number) => threads(count).map(({ channel, rootTs }) => ({ channel, rootTs, ts: "2.0" }));

test("one poll commits 1,000 cursors with one lock and one replacement after all emits", async () => {
  const file = join(state.dir, "threads.json");
  fs.writeFileSync(file, JSON.stringify(threads(1000)));
  const ledger = new ThreadLedger(file);
  let calls = 0;
  const slack = new Slack(
    async (req) => {
      calls++;
      const body = req.url.endsWith("conversations.replies")
        ? { messages: [{ ts: "2.0", user: "owner", text: "reply" }] }
        : {};
      return { status: 200, headers: {}, body: JSON.stringify({ ok: true, ...body }) };
    },
    fakeClock(0),
    { token: "fixture" },
  );
  let locks = 0;
  let commits = 0;
  let emitted = 0;
  const open = spyOn(fs, "openSync").mockImplementation(
    new Proxy(openSync, {
      apply(target, receiver, args) {
        if (args[0] === `${file}.lock`) locks++;
        return Reflect.apply(target, receiver, args);
      },
    }),
  );
  const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (to === file) {
      commits++;
      expect(emitted).toBe(1000);
    }
    return renameSync(from, to);
  });
  try {
    await pollSlackInbound(slack, ledger, { selfUserId: "self" }, () => {
      emitted++;
    });
    expect(calls).toBe(1002);
    expect(emitted).toBe(1000);
    expect(locks).toBe(1);
    expect(commits).toBe(1);
    expect(await ledger.list()).toEqual(threads(1000).map((t) => ({ ...t, seenTs: "2.0" })));
  } finally {
    rename.mockRestore();
    open.mockRestore();
  }
});

const renameSync = fs.renameSync;
test("empty, unknown and stale updates write nothing; duplicate updates only advance", async () => {
  const file = join(state.dir, "threads.json");
  const ledger = new ThreadLedger(file);
  await ledger.markSeen([]);
  expect(fs.existsSync(file)).toBe(false);
  fs.writeFileSync(file, JSON.stringify(threads(2)));
  let commits = 0;
  const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (to === file) commits++;
    return renameSync(from, to);
  });
  try {
    await ledger.markSeen([
      { channel: "missing", rootTs: "1.0", ts: "9.0" },
      { channel: "C0", rootTs: "1.0", ts: "0.5" },
    ]);
    expect(commits).toBe(0);
    await ledger.markSeen([...updates(2), { channel: "C0", rootTs: "1.0", ts: "3.0" }, ...updates(2)]);
    expect(commits).toBe(1);
    expect((await ledger.list()).map((t) => t.seenTs)).toEqual(["3.0", "2.0"]);
  } finally {
    rename.mockRestore();
  }
});

test("a batch re-reads after a competing writer releases its lock and preserves newer cursors and threads", async () => {
  const file = join(state.dir, "threads.json");
  fs.writeFileSync(file, JSON.stringify(threads(2)));
  fs.writeFileSync(
    `${file}.lock`,
    JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString(), nonce: "writer" }),
  );
  let waits = 0;
  const ledger = new ThreadLedger(file, async () => {
    waits++;
    fs.writeFileSync(file, JSON.stringify(threads(3).map((t) => (t.channel === "C0" ? { ...t, seenTs: "4.0" } : t))));
    fs.rmSync(`${file}.lock`);
  });
  await ledger.markSeen(updates(2));
  expect(waits).toBe(1);
  expect((await ledger.list()).map((t) => t.seenTs)).toEqual(["4.0", "2.0", "1.0"]);
  expect(fs.existsSync(`${file}.lock`)).toBe(false);
});

test("a failed batch replacement commits no partial cursor and releases the writer lock", async () => {
  const file = join(state.dir, "threads.json");
  const original = JSON.stringify(threads(2));
  fs.writeFileSync(file, original);
  const ledger = new ThreadLedger(file);
  const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (to === file) throw new Error("injected rename failure");
    return renameSync(from, to);
  });
  try {
    await expect(ledger.markSeen(updates(2))).rejects.toThrow("injected rename failure");
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  } finally {
    rename.mockRestore();
  }
  await ledger.markSeen(updates(2));
  expect((await ledger.list()).map((t) => t.seenTs)).toEqual(["2.0", "2.0"]);
});
