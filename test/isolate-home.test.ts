import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultDeps } from "../src/harness.ts";
import { Store } from "../src/store.ts";
import { configPath } from "../skills/dori-mode/scripts/src/config.ts";

// test/isolate-home.ts runs before every test file. A lead's shell exports DORI_HOME/DORI_CONFIG/DORI_STATE_DIR for
// the live harness, so a test (or a reviewer's probe test) that builds the real dependencies would otherwise write
// briefs and config into the operator's ~/.omp-dori.
test("tests run in a temporary home whatever the caller exported", async () => {
  const home = homedir();
  expect(home).toStartWith("/tmp/dth-");
  expect(process.env["HOME"]).toBe(home);
  for (const key of Object.keys(process.env))
    if (!key.startsWith("DORI_TEST_")) expect(key).not.toMatch(/^(DORI_|HERDR_|HC_)/);
  expect(new Store().root).toBe(join(home, ".dori"));
  expect(defaultDeps().store.root).toBe(join(home, ".dori"));
  expect(configPath()).toBe(join(home, ".dori", "config.json"));
  // Children started without an explicit env see the same home.
  expect(Bun.spawnSync(["sh", "-c", 'printf %s "$HOME"']).stdout.toString()).toBe(home);
  expect((await Bun.$`printf %s "$HOME"`.text()).trim()).toBe(home);
  expect(execFileSync("sh", ["-c", 'printf %s "$HOME"']).toString()).toBe(home);
});
