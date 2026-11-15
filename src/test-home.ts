import { realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";

// The path with symlinks resolved as far as it exists, so a link elsewhere into the home is seen as the home.
const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(real(parent), basename(path));
  }
};

/**
 * Under `bun test` (NODE_ENV=test), an absolute harness home, config or state path inside the operator's real home is
 * refused. The test preload (test/isolate-home.ts) only runs when `bun test` starts in a directory with a bunfig.toml,
 * and a shell that sourced a live harness's env.sh exports DORI_HOME/DORI_CONFIG/DORI_STATE_DIR as absolute paths into
 * it, so a test started anywhere else would write there. userInfo() reads the account database, so a mocked homedir()
 * or a changed HOME does not hide the real home. A relative path names the test's own checkout and is left to its
 * caller: a checkout may itself sit inside the home.
 */
export const outsideRealHomeUnderTest = (path: string): string => {
  if (process.env["NODE_ENV"] !== "test" || !isAbsolute(path)) return path;
  const home = real(userInfo().homedir);
  const full = real(path);
  if (full === home || full.startsWith(`${home}${sep}`))
    throw new Error(`refusing ${path} under bun test: it is inside the real home ${home}; use a temporary home`);
  return path;
};

/** The harness home: DORI_HOME, else ~/.dori. */
export const defaultHome = (): string => outsideRealHomeUnderTest(process.env["DORI_HOME"] ?? join(homedir(), ".dori"));
