import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "examples", "sobaek", "owner-now-sync.sh");
const rsync = Bun.which("rsync");
const ORDER = "1572108521254944830";

/** The sync against a MacBook home and a "macmini" home, both temporary; ssh is a stand-in that runs the remote command here. */
function rig(dori: string) {
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
    `#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -o) shift 2;; macmini) shift; break;; *) break;; esac; done\ncmd="$*"\ncase "$cmd" in */Users/*) exit 255;; esac\ncd "${remote}" && HOME="${remote}" exec /bin/sh -c "$cmd"\n`,
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
  put(join(h, "briefs", "lane-a.md"), `회장님 원문(${ORDER}): SECRET-BRIEF-TEXT\n`);
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
    h,
    mini,
    run,
    ls,
    macbookDir: join(remote, "sobaegi-lead", "state", "macbook"),
    fromMini: join(h, "state", "macmini"),
  };
}

const PULSE = `#!/bin/bash
ls "$HOME/.omp-dori/state/macmini" > "@ROOT@/saw-macmini.txt" 2>&1
echo "$PATH" > "@ROOT@/path.txt"
echo "$@" > "@ROOT@/args.txt"
echo '{"at":1,"alive":true}' > "$HOME/.omp-dori/state/lead-alive.json"
`;

describe.skipIf(!rsync)("owner-now-sync.sh: records between the Macs", () => {
  test("each Mac's records go one way into their own folder; lanes go as a summary without any text", () => {
    const s = rig(PULSE);
    s.mini("open-orders.json", '{"orders":[]}');
    s.mini("reply.log", "x to=1\n");
    s.mini("lead-alive.json", '{"at":2}');
    s.mini("private.log", "not a record file\n");
    const r = s.run();
    expect(r.code).toBe(0);
    expect(s.ls(s.macbookDir)).toEqual([
      "discord-sent.log",
      "inbound.log",
      "lanes",
      "lead-alive.json",
      "open_orders.ts",
      "orders-closed.log",
      "to-macmini.log",
    ]);
    expect(s.ls(join(s.macbookDir, "lanes"))).toEqual(["lane-a.json"]);
    expect(JSON.parse(readFileSync(join(s.macbookDir, "lanes", "lane-a.json"), "utf8"))).toEqual({
      key: "lane-a",
      status: "working",
      lastActivityAt: 1760000000000,
      orders: [ORDER],
    });
    const sentText = Bun.spawnSync(["grep", "-r", "SECRET", s.macbookDir]);
    expect(sentText.exitCode).toBe(1);
    expect(s.ls(s.fromMini)).toEqual(["lead-alive.json", "open-orders.json", "reply.log"]);
    expect(readFileSync(join(s.macbookDir, "lead-alive.json"), "utf8")).toBe('{"at":1,"alive":true}\n');
  });

  test("the pulse runs after the macmini's files arrived and before the MacBook's go, with launchd's PATH plus ~/.local/bin", () => {
    const s = rig(PULSE);
    s.mini("lead-alive.json", '{"at":2}');
    s.run();
    expect(readFileSync(join(s.root, "saw-macmini.txt"), "utf8")).toBe("lead-alive.json\n");
    expect(readFileSync(join(s.root, "args.txt"), "utf8")).toBe("lead-pulse\n");
    expect(readFileSync(join(s.root, "path.txt"), "utf8")).toStartWith(`${join(s.root, "home")}/.local/bin:`);
  });

  test("files the macmini does not have yet and records this Mac has not written are skipped without a failure line", () => {
    const s = rig(PULSE);
    const r = s.run();
    expect(s.ls(s.fromMini)).toEqual([]);
    expect(s.ls(s.macbookDir)).not.toContain("ready-reply.log");
    expect(r.out).not.toContain("기록받음");
    expect(r.out).not.toContain("기록보냄 FAILED");
  });

  test("a pulse that fails, or hangs past PULSE_TIMEOUT, does not stop the copies after it", () => {
    const failing = rig("#!/bin/bash\necho boom >&2\nexit 3\n");
    const bad = failing.run();
    expect(bad.out).toContain("lead-pulse FAILED boom");
    expect(failing.ls(failing.macbookDir)).toContain("inbound.log");
    const hanging = rig("#!/bin/bash\nexec sleep 30\n");
    const started = Date.now();
    const slow = hanging.run({ PULSE_TIMEOUT: "1" });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(slow.out).toContain("lead-pulse FAILED");
    expect(hanging.ls(hanging.macbookDir)).toContain("inbound.log");
    expect(hanging.ls(join(hanging.macbookDir, "lanes"))).toEqual(["lane-a.json"]);
  });

  test("a lane that is gone from this Mac is gone from the macmini's summary; nothing else there is deleted", () => {
    const s = rig(PULSE);
    s.run();
    writeFileSync(join(s.macbookDir, "extra.log"), "kept\n");
    writeFileSync(join(s.macbookDir, "lanes", "old-lane.json"), "{}");
    s.run();
    expect(s.ls(join(s.macbookDir, "lanes"))).toEqual(["lane-a.json"]);
    expect(s.ls(s.macbookDir)).toContain("extra.log");
  });
});
