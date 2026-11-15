// Which OMP a lane starts with, and which model the installed wrapper gives the next lane the hourly loop opens.
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shq } from "./delivery.ts";
import { ConfigError, readConfig } from "./hooks.ts";
import { ompStateDir } from "./runtime/omp.ts";

/** The OMP state directory of a home: DORI_STATE_DIR, else its config's stateDir, else `<root>/state`. */
export const homeStateDir = (root: string): string =>
  ompStateDir(
    { ...process.env, DORI_CONFIG: process.env["DORI_CONFIG"] ?? join(root, "config.json") },
    process.env["DORI_CONFIG"] === undefined ? join(root, "state") : undefined,
  );

/** config.json `agentCommand[0]` as a shell word when it names an OMP executable (the installer's wrapper). */
export function configuredOmp(root: string): string | undefined {
  const argv: unknown = Reflect.get(readConfig(root), "agentCommand");
  const cmd: unknown = Array.isArray(argv) ? argv[0] : undefined;
  if (typeof cmd !== "string" || cmd.split("/").at(-1) !== "omp") return undefined;
  return /^[\w./-]+$/.test(cmd) ? cmd : shq(cmd);
}

/**
 * Writes config.json `loopLaneModel` ("<model>|<thinking>") to `<state>/next-lane-model`, the pin the installed OMP
 * wrapper consumes at the next lane start, the same file a lead writes by hand before `start`. No setting writes nothing.
 */
export function pinLoopLaneModel(root: string): void {
  const pin: unknown = Reflect.get(readConfig(root), "loopLaneModel");
  if (pin === undefined) return;
  if (typeof pin !== "string" || !/^[^\s|]+(\|[^\s|]+)?$/.test(pin))
    throw new ConfigError('config.json: loopLaneModel must look like "provider/model" or "provider/model|thinking"');
  const path = join(homeStateDir(root), "next-lane-model");
  writeFileSync(`${path}.tmp.${process.pid}`, pin, { mode: 0o600 });
  renameSync(`${path}.tmp.${process.pid}`, path);
}
