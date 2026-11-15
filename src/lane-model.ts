// Which OMP a lane starts with, and which model it runs: the lane pin a lead writes by hand before `start` or the
// hourly loop writes from config.json `loopLaneModel`, taken by the next lane start.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

/** Where the next lane start finds its model pin: written by a lead by hand or by the hourly loop, taken by `startLane`. */
export const lanePinPath = (root: string): string => join(homeStateDir(root), "next-lane-model");

/** `<root>/config.json` `agentCommand[0]` as a shell word when it names an OMP executable (the installer's wrapper). */
export function configuredOmp(root: string): string | undefined {
  const argv: unknown = Reflect.get(readConfig(root), "agentCommand");
  const raw: unknown = Array.isArray(argv) ? argv[0] : undefined;
  if (typeof raw !== "string" || raw.split("/").at(-1) !== "omp") return undefined;
  const cmd = raw.replace(/^~(?=\/)/, homedir());
  return /^[\w./-]+$/.test(cmd) ? cmd : shq(cmd);
}

/** Writes `<root>/config.json` `loopLaneModel` ("<model>|<thinking>") as the lane pin; false (nothing written) with no setting. */
export function pinLoopLaneModel(root: string): boolean {
  const pin: unknown = Reflect.get(readConfig(root), "loopLaneModel");
  if (pin === undefined) return false;
  if (typeof pin !== "string" || !PIN.test(pin))
    throw new ConfigError('config.json: loopLaneModel must look like "provider/model" or "provider/model|thinking"');
  const path = lanePinPath(root);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(`${path}.tmp.${process.pid}`, pin, { mode: 0o600 });
  renameSync(`${path}.tmp.${process.pid}`, path);
  return true;
}

/**
 * Takes the lane pin (it is gone afterwards) as OMP arguments: ` --model <m>[ --thinking <t>]`, or "" with no pin.
 * A pin that is not "<model>|<thinking>" is a ConfigError and stays in place for the person who wrote it.
 */
export function takeLanePin(root: string): string {
  const path = lanePinPath(root);
  if (!existsSync(path)) return "";
  const pin = readFileSync(path, "utf8").trim();
  if (!PIN.test(pin)) throw new ConfigError(`${path} must look like "provider/model" or "provider/model|thinking"`);
  rmSync(path, { force: true });
  const [model, thinking] = pin.split("|");
  return ` --model ${shq(model!)}${thinking ? ` --thinking ${shq(thinking)}` : ""}`;
}
