import { homedir, userInfo } from "node:os";
import { join, resolve, sep } from "node:path";

/**
 * Under `bun test` (NODE_ENV=test), a harness home or state dir inside the operator's real home is refused. The test
 * preload (test/isolate-home.ts) only runs when `bun test` starts in a directory with a bunfig.toml, and a shell that
 * sourced a live harness's env.sh points DORI_HOME at it, so a test started anywhere else would write there.
 * userInfo() reads the account database, so a mocked homedir() or a changed HOME does not hide the real home.
 */
export const outsideRealHomeUnderTest = (path: string): string => {
  if (process.env["NODE_ENV"] !== "test") return path;
  const real = userInfo().homedir;
  const full = resolve(path);
  if (full === real || full.startsWith(`${real}${sep}`))
    throw new Error(`refusing ${full} under bun test: it is inside the real home ${real}; use a temporary home`);
  return path;
};

/** The harness home: DORI_HOME, else ~/.dori. */
export const defaultHome = (): string => outsideRealHomeUnderTest(process.env["DORI_HOME"] ?? join(homedir(), ".dori"));
