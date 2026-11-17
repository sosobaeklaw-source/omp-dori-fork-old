import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const SCRIPT = join(import.meta.dir, "..", "examples", "sobaek", "owner-now-sync.sh");
export const rsync = Bun.which("rsync");
export const ORDER = "1572108521254944830";
export const OTHER = "1572108521254944831";

/** The sync against a MacBook home and a "macmini" home, both temporary; ssh is a stand-in that runs the remote command here. */
export function rig(dori: string) {
  const root = mkdtempSync(join(tmpdir(), "owner-sync-"));
  const [home, remote, bin, repo] = ["home", "remote", "bin", "repo"].map((d) => join(root, d)) as [
    string,
    string,
    string,
    string,
  ];
  const h = join(home, ".omp-dori");
  const put = (path: string, text: string, mode?: number) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    if (mode) chmodSync(path, mode);
  };
  put(
    join(bin, "ssh"),
    `#!/bin/sh\n[ -n "$SSH_FAIL" ] && exit 255\nwhile [ $# -gt 0 ]; do case "$1" in -o) shift 2;; macmini) shift; break;; *) break;; esac; done\ncmd="$*"\ncase "$cmd" in */Users/*) exit 255;; esac\ncd "${remote}" && HOME="${remote}" exec /bin/sh -c "$cmd"\n`,
    0o755,
  );
  put(join(h, "bin", "dori"), dori.replaceAll("@ROOT@", root), 0o755);
  put(join(repo, "tools", "open_orders.ts"), "// fixture\n");
  mkdirSync(join(remote, "sobaegi-lead", "state"), { recursive: true });
  for (const f of ["inbound.log", "discord-sent.log", "to-macmini.log", "orders-closed.log"])
    put(join(h, "state", f), `${f}\n`);
  put(
    join(h, "lanes", "lane-a.json"),
    JSON.stringify({
      key: "lane-a",
      status: "working",
      lastActivityAt: 1760000000000,
      log: [{ text: "SECRET-LANE-TEXT" }],
    }),
  );
  put(join(h, "lanes", "broken.json"), "{");
  put(join(h, "briefs", "lane-a.md"), `\n회장님 원문(${ORDER}, ${OTHER}):\nSECRET-BRIEF-TEXT ${ORDER}\n`);
  put(
    join(h, "lanes", "quoter.json"),
    JSON.stringify({ key: "quoter", status: "ready", orders: [ORDER, "x"], note: OTHER }),
  );
  put(
    join(h, "briefs", "quoter.md"),
    `# 제목\n배경: 회장님 원문(${OTHER}) 참고\n하나\n둘\n셋\n회장님 원문(${OTHER}): 여섯째 줄\n`,
  );
  put(join(h, "lanes", "array.json"), "[1, 2]");
  put(join(h, "lanes", "null.json"), "null");
  put(join(h, "lanes", "number-key.json"), JSON.stringify({ key: 5, status: "working" }));
  const mini = (name: string, text: string) => put(join(remote, "sobaegi-lead", "state", name), text);
  const run = (env: Record<string, string> = {}) => {
    const path = [bin, dirname(rsync ?? "/usr/bin/rsync"), "/usr/bin", "/bin"].join(":");
    const r = Bun.spawnSync(["bash", SCRIPT], {
      env: { PATH: path, HOME: home, RSYNC: rsync!, DORI_REPO: repo, ...env },
    });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };
  const ls = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);
  return {
    root,
    remote,
    h,
    mini,
    run,
    ls,
    macbookDir: join(remote, "sobaegi-lead", "state", "macbook"),
    fromMini: join(h, "state", "macmini"),
  };
}

export const PULSE = `#!/bin/bash
ls "$HOME/.omp-dori/state/macmini" > "@ROOT@/saw-macmini.txt" 2>&1
echo "$PATH" > "@ROOT@/path.txt"
echo "$@" > "@ROOT@/args.txt"
echo "\${DORI_MINI_FETCHED_AT-unset}" > "@ROOT@/fetched.txt"
echo '{"at":1,"alive":true}' > "$HOME/.omp-dori/state/lead-alive.json"
`;
