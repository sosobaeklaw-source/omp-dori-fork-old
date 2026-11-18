import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { outsideRealHomeUnderTest } from "../test-home.ts";
import { ConfigError } from "./select.ts";

type Env = Readonly<Record<string, string | undefined>>;

const expandHome = (path: string): string =>
  path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

/** The extension's config/state precedence; callers with loaded config pass stateDir explicitly. */
export const ompStateDir = (env: Env, fallback?: string): string =>
  outsideRealHomeUnderTest(configuredStateDir(env, fallback));

function configuredStateDir(env: Env, fallback?: string): string {
  if (env["DORI_STATE_DIR"] !== undefined) return expandHome(env["DORI_STATE_DIR"]);
  const doriHome = env["DORI_HOME"] ?? join(homedir(), ".dori");
  const path = env["DORI_CONFIG"] ?? join(doriHome, "config.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return fallback ?? join(doriHome, "state");
  }
  let config: unknown;
  try {
    config = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof config !== "object" || config === null || Array.isArray(config))
    throw new ConfigError(`${path} must hold a JSON object`);
  const stateDir: unknown = Reflect.get(config, "stateDir");
  if (stateDir === undefined || stateDir === null) return expandHome(fallback ?? join(doriHome, "state"));
  if (typeof stateDir !== "string" || !stateDir) throw new ConfigError(`${path}: "stateDir" must be a nonempty string`);
  return expandHome(stateDir);
}
