/**
 * What `agy` itself records on this machine: the account it is signed into and every run, by any lane, with or
 * without the writing seat. The seat's account check and gap read from here.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * seat-account runs by anyone on this machine, not only this seat: when the last one ended, whether an `agy -p` is running
 * right now (another lane calling it outside the seat's lock), and whether the latest seat-account run got the 403 (a lane that
 * calls agy directly never writes the seat's stop file; this holds past midnight).
 */
export type AgyUsage = { lastEndAt: number; running: boolean; forbidden: boolean };

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
 * 403 in the latest of those, cleared only by a later run that surely was the seat's. `running` is any `agy` process with a
 * print flag anywhere in its arguments.
 */
export function usageFromLogs(logDir: string, psOutput: string, account: string): AgyUsage {
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
  const running = psOutput.split("\n").some((l) => {
    const [bin, ...args] = l.trim().split(/\s+/);
    return /(^|\/)agy$/.test(bin ?? "") && args.some((a) => /^(-p|--print|--prompt)(=|$)/.test(a));
  });
  return { lastEndAt, running, forbidden };
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

/** The live machine's usage: agy's log folder and `ps`. */
export function machineUsage(logDir: string, account: string): AgyUsage {
  return usageFromLogs(logDir, execFileSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" }), account);
}
