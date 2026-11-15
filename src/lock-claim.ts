import { createHash, randomUUID } from "node:crypto";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

/** What a file lock needs to judge its holder: this process's pid, the clock, and whether a pid still runs. */
export type ClaimEnv = { pid: number; now: () => number; alive: (pid: number) => boolean };

/** The file's text, or undefined once it is gone. */
const textOf = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
};

/** A holder that died; a file with no pid (its creator died before writing it) once it is `ownerlessMs` old. */
function holderGone(env: ClaimEnv, path: string, seen: string, ownerlessMs: number): boolean {
  const pid = /pid=(\d+)/.exec(seen)?.[1];
  if (pid !== undefined) return !env.alive(Number(pid));
  try {
    return env.now() - statSync(path).mtimeMs > ownerlessMs;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/**
 * Takes the file lock `path` (created O_EXCL, naming this pid) and returns its release, or undefined while a live
 * process holds it. A lock whose holder is gone is removed under its claim (underClaim), so a taker that paused after
 * reading it never removes a lock another process took meanwhile.
 */
export function takeFile(env: ClaimEnv, path: string, ownerlessMs: number): (() => void) | undefined {
  const mine = `pid=${env.pid} ${randomUUID()}`;
  for (let tries = 0; tries < 2; tries++) {
    try {
      writeFileSync(path, mine, { flag: "wx" });
      return () => {
        if (textOf(path) === mine) rmSync(path, { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const seen = textOf(path);
    if (seen === undefined) continue;
    if (!holderGone(env, path, seen, ownerlessMs)) return undefined;
    const taken = underClaim(env, path, seen, ownerlessMs, () => {
      if (textOf(path) === seen) rmSync(path, { force: true });
    });
    if (!taken) return undefined;
  }
  return undefined;
}

/**
 * Runs `act` holding `<path>.claim-<digest of seen>`, or returns false while another live process holds that claim.
 * Every process that judged the same content of `path` left behind needs the same claim, so only one of them acts on
 * it, and `act` checks again under the claim that `path` still reads as `seen`. The claim is itself a takeFile lock: a
 * claimer that died is taken over the same way one level down.
 */
export function underClaim(env: ClaimEnv, path: string, seen: string, ownerlessMs: number, act: () => void): boolean {
  const digest = createHash("sha256").update(seen).digest("hex").slice(0, 16);
  const claim = takeFile(env, `${path}.claim-${digest}`, ownerlessMs);
  if (!claim) return false;
  try {
    act();
  } finally {
    claim();
  }
  return true;
}
