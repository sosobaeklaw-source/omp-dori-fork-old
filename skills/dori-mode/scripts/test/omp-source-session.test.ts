import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isOmpArgv } from "../../../../src/runtime/omp.ts";
import { laneGoalActive } from "../src/goal-record.ts";
import { launchLane } from "../src/launch.ts";
import { pauseLane } from "../src/pause.ts";
import { runtimesOf } from "../src/run.ts";
import { resolveSession, sessionDirFor, trustedPaneState } from "../src/session-id.ts";
import { syncRegistry } from "../src/sync.ts";
import { agentIn, depsFor, fakeClock, laneState, newWorld, withState, type TestState, type World } from "./fakes.ts";

// The Linux source launcher runs Bun directly: OMP's own process is `bun --preload <pkg>/scripts/omp.ts ... cli.ts`.
const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const REF = { runtime: "herdr", id: "w:p9" } as const;
const SID = "01a11440-ee81-7f90-b2ed-dcc7d51a0adf";
const pkg = (root: string) => `${root}/packages/coding-agent/`;
const source = (root: string, timing = false): string[] => [
  "/home/user/.bun/bin/bun",
  "--preload",
  `${pkg(root)}scripts/omp.ts`,
  ...(timing ? ["--preload", `${pkg(root)}scripts/../../utils/src/module-timer.ts`] : []),
  `${pkg(root)}scripts/../src/cli.ts`,
  "--dori-role",
  "lane",
];
const forms = [
  ["source", source("/home/user/.cache/omp-dori/native/source")],
  ["spaced source root", source("/home/user/agent tools/native/source")],
  ["timing source", source("/home/user/.cache/omp-dori/native/source", true)],
  ["relative Bun", ["bun", ...source("/opt/native/source").slice(1)]],
] as const;

let state: TestState;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const setup = (argv: readonly string[], key: string, record = true) => {
  const sessionsDir = join(state.dir, "store");
  const dir = sessionDirFor(sessionsDir, "/repo");
  mkdirSync(dir, { recursive: true });
  const sessionFile = join(dir, `2026-01-01T12-00-03-000Z_${SID}.jsonl`);
  const user = { type: "message", message: { role: "user", content: `You are the ${key} lane; report as told.` } };
  writeFileSync(sessionFile, `${JSON.stringify(user)}\n`);
  const brief = join(state.dir, `${key}.md`);
  writeFileSync(brief, "# Fixture\n");
  world.screen = "Working on the task";
  world.panes = [
    {
      pane_id: REF.id,
      workspace_id: "w",
      agent: "omp",
      agent_status: "working",
      cwd: "/repo",
      foreground: [{ name: "bun", argv: [...argv], pid: 4242 }],
    },
  ];
  agentIn(world, REF.id);
  const agent = world.procs?.find((p) => p.pid === 4242);
  if (agent) agent.cmd = argv.join(" ");
  if (record) laneState(state.dir, REF.id, { sessionId: SID, sessionFile, agentStatus: "working" });
  const clock = fakeClock(T0);
  const base = depsFor(world, clock, state.dir, { sessionsDir, startupWaitSeconds: 20 });
  const deps = {
    ...base,
    run: async (cmd: readonly string[]) =>
      cmd[0] === "herdr" && cmd[1] === "tab" && cmd[2] === "create"
        ? { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: REF.id }, tab_id: "w:t9" } }), err: "" }
        : base.run(cmd),
  };
  return { deps, rts: runtimesOf(deps), sessionsDir, sessionFile, brief };
};

test.each(forms)("%s OMP vouches for its session, goal, launch, sync and pause", async (_, argv) => {
  expect(isOmpArgv([...argv, "{prompt}"])).toBe(true);
  const key = "source-lane";
  const { deps, rts, sessionsDir, sessionFile, brief } = setup(argv, key);
  expect((await trustedPaneState(deps.run, state.dir, REF, rts))?.sessionId).toBe(SID);
  const deps2 = { run: deps.run, rts, stateDir: state.dir, sessionsDir };
  expect(await resolveSession(REF, "/repo", world.procs ?? [], deps2)).toEqual({
    id: SID,
    via: "extension",
    pid: 4242,
  });
  const omp = { run: deps.run, rts, stateDir: state.dir, ref: REF };
  expect(await laneGoalActive(sessionsDir, "/repo", key, T0, omp)).toBe(true);
  const launched = await launchLane(
    { ...deps, config: { ...deps.config, agentCommand: [...argv, "--model", "{model}", "{prompt}"] } },
    { key, title: key, brief, done: "file /never-checked" },
  );
  expect(launched.startup).toBe(`STARTUP_OK ${key} ${REF.id}`);
  expect((await syncRegistry(deps, false)).rows[0]?.session).toBe(`${SID} (extension)`);
  world.onSendText = (_id, text) => {
    if (text === "/goal pause")
      laneState(state.dir, REF.id, { sessionId: SID, sessionFile, agentStatus: "working", goal: { status: "paused" } });
  };
  const paused = await pauseLane(deps, launched.lane, "owner said wait");
  expect(paused.code).toBe(0);
});

test("a source OMP without its extension record falls back to OMP's start-time session folder", async () => {
  const argv = forms[1][1];
  const { deps, rts, sessionsDir } = setup(argv, "fallback", false);
  const run = async (cmd: readonly string[]) =>
    cmd[0] === "ps" && cmd.includes("lstart=")
      ? { code: 0, out: "Thu Jan  1 12:00:01 2026 GMT", err: "" }
      : deps.run(cmd);
  const hit = await resolveSession(REF, "/repo", world.procs ?? [], { run, rts, stateDir: state.dir, sessionsDir });
  expect(hit).toEqual({ id: SID, via: "start-time", pid: 4242 });
  expect(world.calls.some((cmd) => cmd.includes("eww"))).toBe(false);
});

test.each([
  ["a shell quoting the source command", ["/bin/sh", "-c", source("/opt/native/source").join(" ")]],
  ["another CLI under the source preload", [...source("/opt/native/source").slice(0, 3), "/elsewhere/src/cli.ts"]],
  ["a Node interpreter", ["node", ...source("/opt/native/source").slice(1)]],
  ["a foreign timing preload", source("/opt/native/source", true).map((a, i) => (i === 4 ? `/x${a}` : a))],
])("%s is neither trusted nor classified as OMP", async (_, argv) => {
  expect(isOmpArgv(argv)).toBe(false);
  const { deps, rts } = setup(argv, "lookalike");
  expect(await trustedPaneState(deps.run, state.dir, REF, rts)).toBeNull();
});
