import { accessSync, existsSync, readFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join, resolve } from "node:path";
import { shq } from "./delivery.ts";
import { memFreePct } from "./host.ts";
import { OMP_RUN_DIR } from "./lane-services.ts";
import { doriLaunchEnv, processOmpCommand, resolveConsumerOmpCommand } from "./release/runtime.ts";
import { type Exec, spawnExec } from "./runtime/exec.ts";
import { HcRuntime } from "./runtime/hc/index.ts";
import { HerdrRuntime } from "./runtime/herdr/index.ts";
import { Runtimes } from "./runtime/registry.ts";
import { configuredOmp } from "./lane-model.ts";
import { isOmpArgv } from "./runtime/omp.ts";
import { ompStateDir } from "./runtime/omp-state-dir.ts";
import { type RuntimeChoice, readRuntimeChoice } from "./runtime/select.ts";
import { Store } from "./store.ts";
import { type HostLoad, KEY_RE, type Role, reservedKey } from "./store-types.ts";
import { Telemetry, type Usage } from "./telemetry.ts";

export { KEY_RE, reservedKey };

const PROMPTS = join(import.meta.dir, "..", "prompts");
const CLI = resolve(import.meta.dir, "cli.ts");

export type Deps = {
  readonly store: Store;
  /** The session runtimes: `default` opens new sessions, `for(ref)` reaches a stored one on its own runtime. */
  readonly runtimes: Runtimes;
  /** Which runtime new sessions open on, and why (`dori status` prints it). Throws when none can be chosen. */
  readonly choice: () => RuntimeChoice;
  readonly exec: Exec;
  /** omp's run directory, where it records the named services each session started. */
  readonly ompRunDir: string;
  readonly now: () => number;
  readonly agentCmd: string;
  readonly doriCmd: string;
  readonly host: () => HostLoad;
  readonly usage: Usage;
};

/** The runtime is chosen on first use, so commands that open or reach no session work without one installed. */
export const defaultDeps = (): Deps => {
  const store = new Store();
  let chosen: RuntimeChoice | undefined;
  let runtimes: Runtimes | undefined;
  let agent: string | undefined;
  const choice = (): RuntimeChoice =>
    (chosen ??= readRuntimeChoice({ env: process.env, configPath: join(store.root, "config.json") }));
  return {
    store,
    get runtimes() {
      // The choice is made only when a NEW session is opened: a stored session's own runtime needs none.
      runtimes ??= new Runtimes(
        () => choice().kind,
        (k) =>
          k === "hc"
            ? new HcRuntime(spawnExec, { stateDir: ompStateDir(process.env) })
            : new HerdrRuntime(spawnExec, process.env["DORI_HERDR_SESSION"], { stateDir: ompStateDir(process.env) }),
      );
      return runtimes;
    },
    choice,
    exec: spawnExec,
    ompRunDir: OMP_RUN_DIR,
    now: Date.now,
    // Read on first use, so a command that starts no agent never reads config.json for it.
    get agentCmd() {
      agent ??= defaultAgentCmd(store.root);
      return agent;
    },
    doriCmd: process.env["DORI_CMD"] ?? `DORI_HOME=${shq(store.root)} bun ${shq(CLI)}`,
    host: () => ({ load1: loadavg()[0] ?? 0, cores: cpus().length, memFreePct: memFreePct() }),
    usage: new Telemetry(store.root),
  };
};

/**
 * The agent command a default harness launches. Precedence: the managed argv, an explicit DORI_AGENT_CMD, the consumer
 * release's fenced native command, then the OMP wrapper config.json names (a side install's, for a loop pane `up` opens
 * with only DORI_HOME; a bare `omp` there names nothing), then the marked installation's `bin/omp`, finally `omp`. An
 * invalid config.json is a ConfigError here as for every other reader of it. `release` locates the consumer release
 * this harness runs from (tests point it at a fixture).
 */
export function defaultAgentCmd(root: string, release?: { home?: string; sourceRoot?: string }): string {
  const selected = processOmpCommand();
  if (selected) return selected.map(shq).join(" ");
  if (process.env["DORI_AGENT_CMD"] !== undefined) {
    const legacy = [process.env["DORI_AGENT_CMD"]] as const;
    const resolved = resolveConsumerOmpCommand(legacy, release);
    return resolved === legacy ? legacy[0] : resolved.map(shq).join(" ");
  }
  const command = resolveConsumerOmpCommand(["omp"], release);
  if (command[0] !== "omp") return command.map(shq).join(" ");
  const configured = configuredOmp(root);
  if (configured !== undefined && configured !== "omp") return configured;
  return existsSync(join(root, ".omp-dori")) ? shq(join(root, "bin/omp")) : "omp";
}

/** Recognize an OMP executable through quoted paths, environment assignments and the env utility. */
export function isOmpAgentCommand(command: string): boolean {
  return isOmpArgv(
    (command.match(/(?:[^\s"'\\]|\\.|"[^"]*"|'[^']*')+/g) ?? []).map((word) => word.replace(/^(['"])(.*)\1$/, "$2")),
  );
}

/** Give OMP the extension role while preserving configured arguments and explicit role/command overrides. */
export const agentCommand = (d: Deps, role: "dori" | "lane"): string =>
  isOmpAgentCommand(d.agentCmd) && !/(?:^|\s)--dori-role(?:[=\s]|$)/.test(d.agentCmd)
    ? `${d.agentCmd} --dori-role ${role}`
    : d.agentCmd;

/** Native agents and loop controllers keep this home's selection across the terminal server. */
export function harnessLaunchEnv(d: Deps): Record<string, string> {
  const configFile = process.env["DORI_CONFIG"] ?? join(d.store.root, "config.json");
  return doriLaunchEnv(process.env, configFile, {
    doriHome: d.store.root,
    stateDir: ompStateDir({ ...process.env, DORI_CONFIG: configFile }),
  });
}

/** `DORI_PROMPTS_DIR` when set, else the repo's `prompts/`. */
export const promptsDir = (): string => process.env["DORI_PROMPTS_DIR"] || PROMPTS;

/**
 * The template `name` from `promptsDir()`, or the built-in one when that directory has none: a prompts directory made
 * for an older dori lacks the templates added since (nudge-waiting.md), and those keep their defaults.
 */
export function promptFile(name: string): string {
  const own = join(promptsDir(), name);
  try {
    accessSync(own);
    return own;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return join(PROMPTS, name);
  }
}

/** `template` with each `{{name}}` in `vars` replaced; an unknown one is left as written. */
export const fill = (template: string, vars: Record<string, string>): string =>
  template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`);

export const prompt = (name: string, vars: Record<string, string>): string =>
  fill(readFileSync(promptFile(name), "utf8"), vars);

/** The roles `dori role` registers by hand; `dori up` also registers the two loop sessions. */
export const ROLES: readonly Role[] = ["lead", "duty"];
