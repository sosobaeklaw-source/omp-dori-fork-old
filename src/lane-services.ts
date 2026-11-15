import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Exec } from "./runtime/exec.ts";

/** omp's per-user run directory: one `daemons/<scope>` per worker broker. */
export const OMP_RUN_DIR = join(homedir(), ".omp", "run");

// A lane's omp named services (`bash name=…`: dev servers, previews, headless browsers) are children of omp's shared
// worker broker, not of the lane's pane, so closing the pane leaves them running for days. omp records each one under
// <run>/daemons/<scope>/daemons/<name>/ with the environment it was started in, which carries the lane key and the
// Dori home. Every home shares one omp run directory, so a lane is identified by both.

type Meta = { readonly daemon?: { readonly state?: string; readonly pid?: number; readonly startedAt?: number } };
type Spec = { readonly env?: Readonly<Record<string, string>> };
type Service = {
  readonly name: string;
  readonly pid: number;
  readonly startedAt: number;
  readonly lane: string | undefined;
  readonly home: string | undefined;
};

/** States omp writes once a service's process is gone; any other state with a pid may still be running. */
const ENDED: Record<string, true> = { exited: true, failed: true };

const readJson = <T>(path: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
};

const dirs = (path: string): string[] => {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
};

function scopes(runDir: string): { broker: number | undefined; services: Service[] }[] {
  return dirs(join(runDir, "daemons")).map((scope) => {
    const root = join(runDir, "daemons", scope);
    const broker = readJson<{ pid?: number }>(join(root, "broker.pid"))?.pid;
    const services: Service[] = [];
    for (const name of dirs(join(root, "daemons"))) {
      const meta = readJson<Meta>(join(root, "daemons", name, "meta.json"))?.daemon;
      if (!meta || ENDED[meta.state ?? ""] || !Number.isSafeInteger(meta.pid) || (meta.pid ?? 0) <= 1) continue;
      const env = readJson<Spec>(join(root, "daemons", name, "spec.json"))?.env;
      services.push({
        name,
        pid: meta.pid!,
        startedAt: meta.startedAt ?? 0,
        lane: env?.["DORI_LANE"],
        home: env?.["DORI_HOME"],
      });
    }
    return { broker, services };
  });
}

/**
 * Stops the live omp named services started from lane `key` of the Dori home `home` and returns their names. A service
 * is stopped only while its pid is still the broker's child leading its own process group (the broker starts every
 * service that way), and only when no later record claims the same pid, so a reused pid is never signalled. The pid
 * could still be reused between that `ps` check and the signal; the window is one exec. The whole group gets SIGTERM,
 * which takes `npm run dev` and the vite it spawned together.
 */
export async function stopLaneServices(exec: Exec, runDir: string, home: string, key: string): Promise<string[]> {
  const stopped: string[] = [];
  const ours = (s: Service) => s.lane === key && s.home !== undefined && resolve(s.home) === resolve(home);
  for (const { broker, services } of scopes(runDir)) {
    if (broker === undefined) continue;
    for (const s of services) {
      if (!ours(s)) continue;
      if (services.some((o) => o !== s && o.pid === s.pid && o.startedAt > s.startedAt)) continue;
      const ps = await exec("ps", ["-o", "ppid=,pgid=", "-p", String(s.pid)]);
      const [ppid, pgid] = ps.stdout.trim().split(/\s+/).map(Number);
      if (ps.code !== 0 || ppid !== broker || pgid !== s.pid) continue;
      try {
        process.kill(-s.pid, "SIGTERM");
        stopped.push(s.name);
      } catch (e) {
        // ESRCH: the group is gone. EPERM: macOS refuses killpg on a group left with only zombies (exited, unreaped).
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ESRCH" && code !== "EPERM") throw e;
      }
    }
  }
  return stopped;
}
