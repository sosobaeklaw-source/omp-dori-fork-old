import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Order, runOrders } from "../tools/open_orders.ts";

const SCRIPT = join(import.meta.dir, "..", "examples", "sobaek", "owner-now-sync.sh");
const rsync = Bun.which("rsync");
const ORDER = "1572108521254944830";
const OTHER = "1572108521254944831";

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
  put(join(h, "briefs", "lane-a.md"), `\n[보호] 원문(${ORDER}, ${OTHER}):\nSECRET-BRIEF-TEXT ${ORDER}\n`);
  put(
    join(h, "lanes", "quoter.json"),
    JSON.stringify({ key: "quoter", status: "ready", orders: [ORDER, "x"], note: OTHER }),
  );
  put(join(h, "briefs", "quoter.md"), `# 제목\n[보호] 원문(${OTHER})\n회장님 원문(${ORDER})\n`);
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
echo "\${DORI_MINI_FETCHED_AT-unset}" > "@ROOT@/fetched.txt"
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
    expect(s.ls(join(s.macbookDir, "lanes"))).toEqual(["lane-a.json", "quoter.json"]);
    const summary = (name: string) => JSON.parse(readFileSync(join(s.macbookDir, "lanes", name), "utf8"));
    expect(summary("lane-a.json")).toEqual({
      key: "lane-a",
      status: "working",
      lastActivityAt: 1760000000000,
      orders: [ORDER, OTHER],
    });
    expect(summary("quoter.json")).toEqual({ key: "quoter", status: "ready", lastActivityAt: 0, orders: [ORDER] });
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
    expect(hanging.ls(join(hanging.macbookDir, "lanes"))).toEqual(["lane-a.json", "quoter.json"]);
  });

  test("a lane that is gone from this Mac is gone from the macmini's summary; nothing else there is deleted", () => {
    const s = rig(PULSE);
    s.run();
    writeFileSync(join(s.macbookDir, "extra.log"), "kept\n");
    writeFileSync(join(s.macbookDir, "lanes", "old-lane.json"), "{}");
    s.run();
    expect(s.ls(join(s.macbookDir, "lanes"))).toEqual(["lane-a.json", "quoter.json"]);
    expect(s.ls(s.macbookDir)).toContain("extra.log");
  });

  test("a lane file that is not an object is skipped and named, and the other lanes are still summarised", () => {
    const s = rig(PULSE);
    const r = s.run();
    for (const bad of ["array.json", "null.json", "number-key.json", "broken.json"])
      expect(r.out).toContain(`skipped ${bad}`);
    expect(s.ls(join(s.macbookDir, "lanes"))).toEqual(["lane-a.json", "quoter.json"]);
    expect(r.out).not.toContain("일감보냄 FAILED");
  });

  test("a failed summary step keeps the old summary here and on the macmini, and sends no lanes", () => {
    const s = rig(PULSE);
    s.run();
    const before = readFileSync(join(s.h, "state", "lanes-summary", "lane-a.json"), "utf8");
    writeFileSync(join(s.root, "bad-python"), "#!/bin/sh\necho 'no python today' >&2\nexit 1\n", { mode: 0o755 });
    writeFileSync(join(s.h, "lanes", "lane-new.json"), JSON.stringify({ key: "lane-new", status: "working" }));
    const r = s.run({ PYTHON: join(s.root, "bad-python") });
    expect(r.out).toContain("일감요약 FAILED no python today");
    expect(r.out).toContain("일감보냄 건너뜀");
    expect(s.ls(join(s.macbookDir, "lanes"))).toEqual(["lane-a.json", "quoter.json"]);
    expect(readFileSync(join(s.h, "state", "lanes-summary", "lane-a.json"), "utf8")).toBe(before);
    expect(s.ls(join(s.h, "state"))).not.toContain("lanes-summary.new");
    expect(s.ls(s.macbookDir)).toContain("inbound.log");
  });

  test("open_orders reads the summary the way it reads the lane records: the same order gets the same lanes", () => {
    const s = rig(PULSE);
    s.run();
    const ids = [ORDER, OTHER];
    const inbound = join(s.root, "inbound.log");
    writeFileSync(inbound, ids.map((id) => `INBOUND discord 1 ${id} from=owner ref=- "지시"`).join("\n"));
    const seen = (lanes: string): [string, string[]][] => {
      const out: string[] = [];
      runOrders(["--inbound", `macbook=${inbound}`, "--lanes", `macbook=${lanes}`, "--json", "--since", "3650d"], (l) =>
        out.push(l),
      );
      return (JSON.parse(out[0]!) as { orders: Order[] }).orders.map((o) => [o.id, o.lanes.map((l) => l.key).sort()]);
    };
    expect(seen(join(s.macbookDir, "lanes"))).toEqual(seen(join(s.h, "lanes")));
    expect(seen(join(s.h, "lanes"))).toEqual([
      [ORDER, ["lane-a", "quoter"]],
      [OTHER, ["lane-a"]],
    ]);
  });

  test("the pulse is told the fetch time only when this run fetched the macmini's records", () => {
    const ok = rig(PULSE);
    ok.mini("lead-alive.json", '{"at":2}');
    const before = Date.now();
    ok.run();
    const stamp = Number(readFileSync(join(ok.root, "fetched.txt"), "utf8"));
    expect(stamp).toBeGreaterThan(before - 1000);
    expect(stamp).toBeLessThan(Date.now() + 1000);
    const down = rig(PULSE);
    down.mini("lead-alive.json", '{"at":2}');
    const r = down.run({ SSH_FAIL: "1" });
    expect(r.out).toContain("기록받음 FAILED");
    expect(readFileSync(join(down.root, "fetched.txt"), "utf8")).toBe("\n");
  });
});
