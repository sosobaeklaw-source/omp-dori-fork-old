import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

/** A stand-in herdr: panes are files, every call is logged, and `kill-on-run` makes the typed start command kill its caller. */
const HERDR = `#!/bin/bash
d="\${FAKE_HERDR:?}"; mkdir -p "$d/panes"
echo "$*" >> "$d/calls.log"
case "\${1:-} \${2:-}" in
  "pane get")
    if [ -e "$d/panes/$3" ]; then printf '{"result":{"pane":{"pane_id":"%s","agent":"pi","agent_status":"idle"}}}' "$3"
    else echo "pane_not_found $3" >&2; exit 1; fi ;;
  "pane process-info")
    printf '{"result":{"process_info":{"pane_id":"%s","shell_pid":1,"foreground_process_group_id":2,"foreground_processes":[{"name":"omo","argv":["omo"],"pid":3}]}}}' "$4" ;;
  "workspace create")
    n=$(( $(cat "$d/next" 2>/dev/null || echo 1) + 1 )); echo "$n" > "$d/next"; touch "$d/panes/w9:p$n"
    printf '{"result":{"root_pane":{"pane_id":"w9:p%s","tab_id":"w9:t1","workspace_id":"w9"}}}' "$n" ;;
  "pane run")
    echo "typed into $3" >> "$d/runs.log"
    [ -e "$d/kill-on-run" ] && kill -9 "$PPID"
    printf '{"result":{}}' ;;
  *) echo "unhandled $*" >&2; exit 1 ;;
esac
`;

test("a pulse killed after it created the lead's workspace and before it registered it leaves a mark: the next pulse starts no second lead", async () => {
  const root = mkdtempSync(join(tmpdir(), "pulse-kill-"));
  const [home, state, fake, bin] = ["home", "home/state", "fake", "bin"].map((d) => join(root, d)) as [
    string,
    string,
    string,
    string,
  ];
  for (const d of [home, state, fake, bin, join(root, "cwd")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, "herdr"), HERDR);
  chmodSync(join(bin, "herdr"), 0o755);
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ runtime: "herdr", stateDir: state, defaultCwd: join(root, "cwd") }),
  );
  writeFileSync(join(home, "roles.json"), JSON.stringify({ lead: "w9:p1" }));
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: root,
    DORI_HOME: home,
    DORI_CONFIG: join(home, "config.json"),
    DORI_STATE_DIR: state,
    DORI_RUNTIME: "herdr",
    DORI_TELEMETRY: "0",
    DORI_AGENT_CMD: "omo",
    FAKE_HERDR: fake,
  };
  const pulse = async () => {
    const proc = Bun.spawn([process.execPath, CLI, "lead-pulse"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [out] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out: out.trim(), signal: proc.signalCode };
  };
  const calls = () => (existsSync(join(fake, "calls.log")) ? readFileSync(join(fake, "calls.log"), "utf8") : "");
  const creates = () =>
    calls()
      .split("\n")
      .filter((l) => l.startsWith("workspace create")).length;
  const log = () => readFileSync(join(state, "lead-pulse.log"), "utf8");

  expect((await pulse()).out).toContain("PULSE alive=false");
  writeFileSync(join(fake, "kill-on-run"), "");
  const killed = await pulse();
  expect(killed.signal).toBe("SIGKILL");
  expect(creates()).toBe(1);
  expect(JSON.parse(readFileSync(join(home, "roles.json"), "utf8")).lead).toBe("w9:p1");
  expect(existsSync(join(state, "lead-starting.json"))).toBe(true);

  const next = await pulse();
  expect(next.signal).toBeNull();
  expect(next.out).toContain("PULSE alive=false");
  expect(creates()).toBe(1);
  expect(readFileSync(join(fake, "runs.log"), "utf8").trim().split("\n")).toHaveLength(1);
  expect(log()).toContain("did not finish: waiting for it, not starting a second lead");

  writeFileSync(join(state, "lead-starting.json"), `${JSON.stringify({ at: Date.now() - 11 * 60_000 })}\n`);
  expect((await pulse()).signal).toBe("SIGKILL");
  expect(creates()).toBe(2);
});
