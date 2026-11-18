/**
 * What `agy` itself records on this machine: the account it is signed into and every run, by any lane, with or
 * without the writing seat. The seat's account check and 403 check read from here.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Seat-account runs by anyone on this machine, not only this seat: when the last one ended, and whether the latest
 * seat-account run got the 403 (a lane that calls agy directly never writes the seat's stop file; this holds past midnight).
 */
export type AgyUsage = { lastEndAt: number; forbidden: boolean };

/** Every mail on an `applyAuthResult` line; a run can sign in more than once. */
export const mailsIn = (text: string): string[] =>
  [...text.matchAll(/applyAuthResult: email=([^,\s]+)/g)].map((m) => m[1] ?? "");

/** The mail on the last `applyAuthResult` line of agy's current CLI log (`~/.gemini/antigravity-cli/cli.log`). */
export function accountFromLog(logPath: string): string | undefined {
  if (!existsSync(logPath)) return undefined;
  const hits = [...readFileSync(logPath, "utf8").matchAll(/applyAuthResult: email=([^,\s]+)/g)];
  return hits.at(-1)?.[1];
}

/**
 * Seat-account print runs from agy's log folder: agy writes one `cli-YYYYMMDD_HHMMSS.log` per run (local time), with
 * `Print mode: starting` for `-p` and the signed-in mail on `applyAuthResult`; the file's mtime is when the run ended.
 * A print run with the account among its mails, or with no mail at all, counts as the seat's (it may have been). `forbidden` is the
 * 403 in the latest of those, cleared only by a later run that surely was the seat's.
 */
export function usageFromLogs(logDir: string, account: string): AgyUsage {
  let lastEndAt = 0;
  let forbidden = false;
  for (const name of (existsSync(logDir) ? readdirSync(logDir) : []).sort()) {
    const m = /^cli-(\d{8})_\d{6}\.log$/.exec(name);
    if (!m) continue;
    const path = join(logDir, name);
    const text = readFileSync(path, "utf8");
    if (!text.includes("Print mode: starting")) continue;
    const mails = mailsIn(text);
    if (mails.length > 0 && !mails.includes(account)) continue;
    if (/PERMISSION_DENIED \(code 403\)/.test(text)) forbidden = true;
    else if (mails.length > 0 && mails.every((x) => x === account)) forbidden = false;
    lastEndAt = Math.max(lastEndAt, statSync(path).mtimeMs);
  }
  return { lastEndAt, forbidden };
}

/**
 * The run log of the call made in `workDir`: agy names the workspace on its `workspaceDirs=[…]` line, and the seat
 * makes a fresh `mkdtemp` folder per call, so its name picks out this call's log and no other lane's.
 */
export function runLogFor(logDir: string, workDir: string): string | undefined {
  const tail = `/${basename(workDir)}]`;
  for (const name of existsSync(logDir) ? readdirSync(logDir) : []) {
    if (!/^cli-\d{8}_\d{6}\.log$/.test(name)) continue;
    const text = readFileSync(join(logDir, name), "utf8");
    if (/workspaceDirs=\[[^\]\n]*\]/.exec(text)?.[0].endsWith(tail)) return text;
  }
  return undefined;
}

/** The live machine's usage, from agy's log folder. */
export function machineUsage(logDir: string, account: string): AgyUsage {
  return usageFromLogs(logDir, account);
}
