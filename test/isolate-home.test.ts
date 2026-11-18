import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
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

// Bun reads bunfig.toml only where `bun test` starts, so a probe run from /tmp gets no preload and keeps whatever
// DORI_* its shell exported: absolute homes, configs and state dirs inside the real home are refused, also through a
// symlink from outside it, while a relative path (one that names the checkout, which may sit in the home) is not.
test("bun test started outside a preloaded root refuses a home inside the real one", () => {
  const real = userInfo().homedir;
  // Never created: the probe must refuse it before writing anything.
  const live = join(real, `.dori-test-guard-${process.pid}`);
  const dir = mkdtempSync("/tmp/dth-probe-");
  try {
    symlinkSync(real, join(dir, "home-link"));
    const src = join(import.meta.dir, "..", "src");
    writeFileSync(
      join(dir, "probe.test.ts"),
      `import { expect, test } from "bun:test";
import { Store } from ${JSON.stringify(join(src, "store.ts"))};
import { ompStateDir } from ${JSON.stringify(join(src, "runtime", "omp-state-dir.ts"))};
import { configPath } from ${JSON.stringify(join(src, "..", "skills", "dori-mode", "scripts", "src", "config.ts"))};
import { outsideRealHomeUnderTest } from ${JSON.stringify(join(src, "test-home.ts"))};
test("probe", () => {
  expect(() => new Store()).toThrow("under bun test");
  expect(() => configPath()).toThrow("under bun test");
  expect(() => ompStateDir(process.env)).toThrow("under bun test");
  const linked = ${JSON.stringify(join(dir, "home-link", `.dori-test-guard-${process.pid}`))};
  expect(() => outsideRealHomeUnderTest(linked)).toThrow("under bun test");
  // A relative path is the caller's own business even when the cwd is inside the real home (a checkout under ~).
  process.chdir(${JSON.stringify(real)});
  for (const relative of ["", ".", "..", "config.json"]) expect(outsideRealHomeUnderTest(relative)).toBe(relative);
  expect(outsideRealHomeUnderTest("/tmp/elsewhere/.dori")).toBe("/tmp/elsewhere/.dori");
});
`,
    );
    const r = Bun.spawnSync([process.execPath, "test", "./probe.test.ts"], {
      cwd: dir,
      env: {
        PATH: process.env["PATH"],
        HOME: real,
        DORI_HOME: live,
        DORI_CONFIG: join(live, "config.json"),
        DORI_STATE_DIR: join(live, "state"),
      },
    });
    expect({ code: r.exitCode, err: r.stderr.toString() }).toMatchObject({ code: 0 });
    expect(existsSync(live)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
