// Which OMP a lane starts with, and which model it runs: the hourly loop's config.json `loopLaneModel`, or the lane
// pin a lead writes by hand before `start`.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { shq } from "./delivery.ts";
import { ConfigError, readConfig } from "./hooks.ts";
import { ompStateDir } from "./runtime/omp.ts";

const PIN = /^[^\s|]+(\|[^\s|]+)?$/;

/** The OMP state directory of a home: DORI_STATE_DIR, else its config's stateDir, else `<root>/state`. */
export const homeStateDir = (root: string): string =>
  ompStateDir(
    { ...process.env, DORI_CONFIG: process.env["DORI_CONFIG"] ?? join(root, "config.json") },
    process.env["DORI_CONFIG"] === undefined ? join(root, "state") : undefined,
  );

/** `<root>/config.json` `agentCommand[0]` as a shell word when it names an OMP executable (the installer's wrapper). */
export function configuredOmp(root: string): string | undefined {
  const argv: unknown = Reflect.get(readConfig(root), "agentCommand");
  const raw: unknown = Array.isArray(argv) ? argv[0] : undefined;
  if (typeof raw !== "string" || raw.split("/").at(-1) !== "omp") return undefined;
  const cmd = raw.replace(/^~(?=\/)/, homedir());
  return /^[\w./-]+$/.test(cmd) ? cmd : shq(cmd);
}

/** `<root>/config.json` `loopLaneModel` ("<model>|<thinking>"), the model of every lane the hourly loop opens. */
export function loopLaneModel(root: string): string | undefined {
  const model: unknown = Reflect.get(readConfig(root), "loopLaneModel");
  if (model === undefined || (typeof model === "string" && PIN.test(model))) return model;
  throw new ConfigError('config.json: loopLaneModel must look like "provider/model" or "provider/model|thinking"');
}

/**
 * Takes the lane pin a lead wrote by hand before `start` (it is gone afterwards), or undefined with none. A pin that is
 * not "<model>|<thinking>" is a ConfigError and stays in place for the person who wrote it.
 */
export function takeLanePin(root: string): string | undefined {
  const path = join(homeStateDir(root), "next-lane-model");
  if (!existsSync(path)) return undefined;
  const pin = readFileSync(path, "utf8").trim();
  if (!PIN.test(pin)) throw new ConfigError(`${path} must look like "provider/model" or "provider/model|thinking"`);
  rmSync(path, { force: true });
  return pin;
}
