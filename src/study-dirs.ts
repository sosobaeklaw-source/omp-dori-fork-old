import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The python that prints sanjai-agent's STUDY_DIRS, the single allowlist of folders the recall may read. */
export const STUDY_LIST_PY =
  "import scripts.ontology.refresh_public as r; print('\\n'.join(f for f, _ in r.STUDY_DIRS))";

/**
 * The allowed study folders, read at run time from sanjai-agent itself so the list is never copied into this repo:
 * DORI_STUDY_DIRS (comma-separated), then the local ~/sanjai-agent's venv python, then ssh to the host in
 * ~/.omp-dori/onto-host (DORI_ONTO_HOST, DORI_SANJAI_PYTHON override). Undefined when none of them could be read —
 * the caller then recalls nothing rather than everything.
 */
export function readStudyDirs(from: { python?: string; host?: string } = {}): string[] | undefined {
  const env = process.env["DORI_STUDY_DIRS"];
  if (env && env.trim())
    return [
      ...new Set(
        env
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
  const home = homedir();
  const run = (cmd: string[], cwd?: string, stdin?: Buffer): string[] | undefined => {
    try {
      const r = Bun.spawnSync(cmd, {
        ...(cwd === undefined ? {} : { cwd }),
        stdin: stdin ?? "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      if (r.exitCode !== 0) return undefined;
      const dirs = [
        ...new Set(
          Buffer.from(r.stdout)
            .toString()
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean),
        ),
      ];
      return dirs.length > 0 ? dirs : undefined;
    } catch {
      return undefined;
    }
  };
  const agent = join(home, "sanjai-agent");
  if (existsSync(join(agent, "scripts", "ontology", "refresh_public.py"))) {
    const python = from.python ?? process.env["DORI_SANJAI_PYTHON"] ?? join(agent, ".venv", "bin", "python3");
    const local = run([python, "-c", STUDY_LIST_PY], agent);
    if (local) return local;
  }
  const hostFile = join(home, ".omp-dori", "onto-host");
  const host =
    from.host ?? process.env["DORI_ONTO_HOST"] ?? (existsSync(hostFile) ? readFileSync(hostFile, "utf8").trim() : "");
  if (!host) return undefined;
  return run(
    [
      "ssh",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "BatchMode=yes",
      "-S",
      "none",
      host,
      "cd ~/sanjai-agent && ./.venv/bin/python3 -",
    ],
    undefined,
    Buffer.from(STUDY_LIST_PY),
  );
}
