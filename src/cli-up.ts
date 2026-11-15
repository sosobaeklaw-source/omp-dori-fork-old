import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shq } from "./delivery.ts";
import { agentCommand, promptFile, type Deps } from "./harness.ts";
import { lockEnv } from "./lock.ts";
import { lockLines } from "./lock-list.ts";
import { refText } from "./refs.ts";
import { groupId } from "./runtime/group.ts";
import { openSession, type SessionRef } from "./runtime/types.ts";
import { RuntimeChoiceError } from "./runtime/select.ts";
import { laneBoard } from "./status-view.ts";

export function renderPrompt(d: Deps, name: string): string {
  const dir = join(d.store.root, "prompts");
  mkdirSync(dir, { recursive: true });
  const src = readFileSync(promptFile(name), "utf8");
  const out = join(dir, name);
  const local = join(dir, name.replace(/\.md$/, ".local.md"));
  const overlay = existsSync(local) ? readFileSync(local, "utf8") : "";
  writeFileSync(out, (overlay ? `${src.trimEnd()}\n\n${overlay}` : src).replaceAll("{{dori}}", d.doriCmd));
  return out;
}

/**
 * Opens lead, duty, the duty loop and the hourly loop on the selected runtime and registers all four roles. herdr: the
 * lead is a new workspace's root pane, duty a tab in it, the loops splits below duty. hc: four terminals labelled with
 * this home's group.
 */
export async function up(d: Deps, cwd: string): Promise<void> {
  const rt = d.runtimes.default;
  const env = { DORI_HOME: d.store.root };
  const agent = (name: string) => `${agentCommand(d, "dori")} --append-system-prompt ${shq(renderPrompt(d, name))}`;
  // herdr ignores the group of a workspace-root session and reports the new workspace as the lead ref's group.
  const lead = await openSession(
    rt,
    { name: "dori", role: "lead", container: "workspace-root", cwd, env: {}, group: groupId(d.store.root) },
    agent("lead.md"),
  );
  d.store.setRole("lead", lead);
  const group = lead.group;
  const inGroup = group === undefined ? {} : { group };
  const duty = await openSession(
    rt,
    { name: "duty", role: "duty", container: "tab", cwd, env, ...inGroup },
    agent("duty.md"),
  );
  d.store.setRole("duty", duty);
  const loop = await openSession(
    rt,
    { name: "duty-loop", role: "duty-loop", container: "split-below", near: duty, cwd, env, ...inGroup },
    `${d.doriCmd} duty --interval 60`,
  );
  d.store.setRole("duty-loop", loop);
  // The hourly loop starts lanes, so it gets the agent command this `up` resolved, not whatever its own shell finds.
  const loopEnv = { ...env, DORI_AGENT_CMD: d.agentCmd };
  const hourlyEnv = rt.kind === "herdr" && group !== undefined ? { ...loopEnv, HERDR_WORKSPACE_ID: group } : loopEnv;
  const hourly = await openSession(
    rt,
    { name: "hourly-loop", role: "hourly-loop", container: "split-below", near: loop, cwd, env: hourlyEnv, ...inGroup },
    `${d.doriCmd} loop`,
  );
  d.store.setRole("hourly-loop", hourly);
  console.log(
    `UP runtime=${rt.kind} lead=${refText(lead)} duty=${refText(duty)} loop=${refText(loop)} hourly=${refText(hourly)} home=${d.store.root}`,
  );
}

/** The runtime line first (a runtime that cannot be chosen is shown, not thrown; a bad setting still throws). */
function runtimeLine(d: Deps): string {
  try {
    const c = d.choice();
    return `RUNTIME ${c.kind} (from ${c.source})`;
  } catch (e) {
    if (e instanceof RuntimeChoiceError) return `RUNTIME unset: ${e.message}`;
    throw e;
  }
}

/**
 * The runtime line, the roles and the home path, each on a line of its own and never wrapped: the runtime line can name
 * the config file and the home is a path, either of which may hold spaces, and a path broken at one names no file.
 * Wider than a line, the terminal folds them. The lane board below keeps within WIDTH, and so does the line per lock
 * held or waited for (lock-list.ts) at the end.
 */
export function status(d: Deps): void {
  const roles = d.store.roles();
  const show = (ref: SessionRef | undefined) => (ref ? refText(ref) : "-");
  for (const line of [runtimeLine(d), `lead=${show(roles.lead)} duty=${show(roles.duty)}`, `home=${d.store.root}`])
    console.log(line);
  for (const line of laneBoard(d.store.lanes(), d.now())) console.log(line);
  for (const line of lockLines({ ...lockEnv(d.store.root), now: d.now })) console.log(line);
}
