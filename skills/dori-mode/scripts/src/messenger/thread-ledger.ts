import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { takeLock } from "../checkpoint-lock.ts";
import { MessengerError } from "./http.ts";

export const tsAfter = (a: string, b: string): boolean => Number(a) > Number(b);

export type LedgerThread = { readonly channel: string; readonly rootTs: string; readonly seenTs: string };
type Threads = Map<string, LedgerThread>;

const LOCK_RETRY_MS = 20;
const LOCK_WAIT_MS = 10_000;
const keyOf = (channel: string, rootTs: string): string => `${channel}:${rootTs}`;

/**
 * The Slack threads the Dori posted in, shared by every `dori send slack` and the long-lived receiver. Nothing is
 * cached: a read takes the file as it is now, and a change re-reads it under a writer lock, merges, and replaces it
 * atomically, so no process writes an old snapshot over another's threads and a seen position only moves forward.
 */
export class ThreadLedger {
  constructor(
    private readonly file: string,
    private readonly wait: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
  ) {}

  private read(): Threads {
    const threads: Threads = new Map();
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return threads;
      throw error;
    }
    for (const t of JSON.parse(raw) as LedgerThread[]) threads.set(keyOf(t.channel, t.rootTs), t);
    return threads;
  }

  /** Wait for the shared checkpoint writer lock; updates below hold it only across synchronous file I/O. */
  private async lock(): Promise<() => void> {
    mkdirSync(dirname(this.file), { recursive: true });
    const lock = `${this.file}.lock`;
    const fail = (message: string) => new MessengerError(`slack thread ledger lock ${message}`, 0);
    for (let waited = 0; ; waited += LOCK_RETRY_MS) {
      const held = takeLock(lock, Date.now(), fail);
      if (typeof held !== "string") return held;
      if (waited >= LOCK_WAIT_MS) throw new MessengerError(`slack thread ledger ${lock} stayed locked (${held})`, 0);
      await this.wait(LOCK_RETRY_MS);
    }
  }

  /** Apply `change` to the latest threads on disk; a change that returns false writes nothing. */
  private async update(change: (threads: Threads) => boolean): Promise<void> {
    const release = await this.lock();
    try {
      const threads = this.read();
      if (!change(threads)) return;
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify([...threads.values()], null, 1));
      renameSync(tmp, this.file);
    } finally {
      release();
    }
  }

  /**
   * Registers a thread the Dori posted in. A new thread is read from the Dori's post on; a known one keeps its seen
   * position, which only the receiver moves (`markSeen`, after delivery): a reply that arrived before this post but has
   * not been delivered yet must still be read, and the Dori's own messages are skipped as they are read.
   */
  async record(channel: string, rootTs: string, postedTs: string): Promise<void> {
    await this.update((threads) => {
      if (threads.has(keyOf(channel, rootTs))) return false;
      threads.set(keyOf(channel, rootTs), { channel, rootTs, seenTs: postedTs });
      return true;
    });
  }

  async markSeen(channel: string, rootTs: string, ts: string): Promise<void> {
    await this.update((threads) => {
      const prev = threads.get(keyOf(channel, rootTs));
      if (!prev || !tsAfter(ts, prev.seenTs)) return false;
      threads.set(keyOf(channel, rootTs), { ...prev, seenTs: ts });
      return true;
    });
  }

  async list(): Promise<LedgerThread[]> {
    return [...this.read().values()];
  }
}
