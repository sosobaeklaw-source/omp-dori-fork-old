// Preloaded by every bun test root (see the bunfig.toml files). Tests must never reach the operator's home:
// a lead's shell sources ~/.omp-dori/env.sh, so DORI_HOME/DORI_CONFIG/DORI_STATE_DIR point at the live harness,
// and any test that calls defaultDeps(), configPath() or homedir() would write there.
import { afterAll, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

// /tmp, not os.tmpdir(): runtimes put Unix sockets under HOME (herdr: ~/.config/herdr/sessions/<session>/), and
// macOS's long per-user tmpdir would push them past the 104-byte socket path limit.
const home = mkdtempSync("/tmp/dth-");
// A preload's afterAll runs once per test process (process.on("exit") does not run under bun test).
afterAll(() => rmSync(home, { recursive: true, force: true }));

for (const key of Object.keys(process.env))
  if (/^(DORI_|HERDR_|HC_)/.test(key) && !key.startsWith("DORI_TEST_")) delete process.env[key];
Object.assign(process.env, {
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  XDG_CACHE_HOME: join(home, ".cache"),
  // git reads ~/.gitconfig from HOME; give commits in fixtures a fixed identity instead.
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "dori test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "dori test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
});

// Bun resolves homedir() and the default env of Bun.spawn/Bun.$ from the env the process started with,
// so the assignments above only reach them through these overrides.
const homedir = () => home;
mock.module("node:os", () => ({ ...os, homedir, default: { ...os, homedir } }));
mock.module("os", () => ({ ...os, homedir, default: { ...os, homedir } }));

type SpawnArgs = [unknown, ...unknown[]];
const withEnv = (args: SpawnArgs): SpawnArgs => {
  const [first, second] = args;
  if (Array.isArray(first)) {
    const opts = (second ?? {}) as { env?: unknown };
    return [first, { ...opts, env: opts.env ?? process.env }, ...args.slice(2)];
  }
  const opts = first as { env?: unknown };
  return [{ ...opts, env: opts.env ?? process.env }, ...args.slice(1)];
};
const { spawn, spawnSync } = Bun;
Bun.spawn = ((...args: SpawnArgs) => Reflect.apply(spawn, Bun, withEnv(args))) as typeof Bun.spawn;
Bun.spawnSync = ((...args: SpawnArgs) => Reflect.apply(spawnSync, Bun, withEnv(args))) as typeof Bun.spawnSync;
Bun.$.env(process.env);
