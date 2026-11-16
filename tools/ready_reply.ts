#!/usr/bin/env bun
/**
 * READY hook: post a lane's result as a reply to the owner's Discord message the lane came from (src/ready-reply.ts
 * decides whether and what), then tell the lead the reply id. Wire it as config.json
 * `hooks.onReady: ["bun", "<repo>/tools/ready_reply.ts", "{key}", "--detach"]`.
 *
 *   ready_reply KEY [--dry-run] [--detach]
 *
 * --detach starts the same command in its own process and returns at once: the harness kills a hook still running two
 * seconds after `ready` (HOOK_SETTLE_MS), and an upload with a picture takes longer. --dry-run prints the plan only.
 * The post goes through DORI_SEND_FILE (default `<home>/bin/dori-send-file.sh`, see examples/sobaek/), which prints
 * `SENT <id>`. A lane that gets no reply prints `SKIP <why>` and tells nobody: it stays inbox-only as before.
 * The client-name list for the case-lane check is DORI_CASE_NAMES (default `<home>/case-names.json`, a JSON array or
 * one name per line); without a readable list every lane stays inbox-only.
 * Every outcome (reply, skip, failure) is appended to `<stateDir>/ready-reply.log`, and a failure, including a sender
 * that is missing or cannot start, is also told to the lead, so a detached run never fails silently.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { recordSent } from "../skills/dori-mode/scripts/src/messenger/discord-sent.ts";
import { need, parse } from "../src/cli-args.ts";
import { type Deps, defaultDeps } from "../src/harness.ts";
import { send } from "../src/inbox.ts";
import { homeStateDir } from "../src/lane-model.ts";
import { loadCaseNames, ownerMessages, planReply } from "../src/ready-reply.ts";

function note(stateDir: string, line: string): void {
  appendFileSync(join(stateDir, "ready-reply.log"), `${new Date().toISOString()} ${line}\n`);
}

/** Runs the sender; a spawn that throws (missing or non-executable file) comes back as a failure, not an exception. */
function post(sender: string, text: string, image: string | undefined, env: Record<string, string>) {
  try {
    const r = Bun.spawnSync([sender, text, ...(image ? [image] : [])], { env: { ...process.env, ...env } });
    const out = r.stdout.toString().trim();
    const id = /^SENT (\d+)$/m.exec(out)?.[1];
    if (r.exitCode === 0 && id) return { id };
    return { why: (out || r.stderr.toString()).trim().split("\n")[0] || `exit ${r.exitCode}` };
  } catch (error) {
    return { why: `cannot run ${sender}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Tells the lead; returns how that went instead of throwing, so a failure is recorded even when the lead is away. */
async function tell(d: Deps, text: string, key: string): Promise<string> {
  try {
    return String(await send(d, "lead", text, key));
  } catch (error) {
    return `not told, ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function main(argv: readonly string[]): Promise<number> {
  // The CLI kills hooks after two seconds; --detach returns at once and lets a detached copy do the posting.
  if (argv.includes("--detach")) {
    const again = process.argv.filter((arg) => arg !== "--detach");
    Bun.spawn(again, { stdio: ["ignore", "ignore", "ignore"], detached: true }).unref();
    return 0;
  }
  const a = parse(argv);
  const key = need(a.pos[0], "lane key");
  const d = defaultDeps();
  const home = d.store.root;
  const stateDir = homeStateDir(home);
  const briefPath = d.store.lane(key)?.brief ?? d.store.briefPath(key);
  const plan = planReply({
    brief: existsSync(briefPath) ? readFileSync(briefPath, "utf8") : "",
    resultsDir: join(home, "results", key),
    owners: ownerMessages(join(stateDir, "inbound.log")),
    caseNames: loadCaseNames(process.env["DORI_CASE_NAMES"] ?? join(home, "case-names.json")),
  });
  if (!plan.post) {
    console.log(`SKIP ${key}: ${plan.why}`);
    if (!a.flags.has("dry-run")) note(stateDir, `SKIP ${key}: ${plan.why}`);
    return 0;
  }
  const { owner, text, image } = plan;
  if (a.flags.has("dry-run")) {
    console.log(`REPLY_TO ${owner.id} channel ${owner.channel}\nIMAGE ${image ?? "-"}\nTEXT\n${text}`);
    return 0;
  }
  const sender = process.env["DORI_SEND_FILE"] ?? join(home, "bin", "dori-send-file.sh");
  const r = post(sender, text, image, { REPLY_TO: owner.id, DISCORD_CHANNEL: owner.channel });
  if (!("id" in r)) {
    const told = await tell(d, `[REPLY ${key}] 회장님 원글 ${owner.id} 답글 실패: ${r.why}`, key);
    note(stateDir, `FAIL ${key} ${owner.id}: ${r.why} (lead: ${told})`);
    console.error(`FAIL ${r.why}`);
    return 1;
  }
  const id = r.id as string;
  note(stateDir, `REPLIED ${key} ${owner.id} ${id}`);
  recordSent(stateDir, id, key, "all");
  await send(d, "lead", `[REPLY ${key}] 회장님 원글 ${owner.id}에 결과 답글 ${id}${image ? " (그림 1)" : ""}`, key);
  console.log(`REPLIED ${owner.id} ${id}`);
  return 0;
}

const argv = process.argv.slice(2);
try {
  process.exit(await main(argv));
} catch (error) {
  // Anything unexpected still leaves a trace and reaches the lead: under --detach nobody sees stderr.
  const why = error instanceof Error ? error.message : String(error);
  const key = argv.find((x) => !x.startsWith("--")) ?? "?";
  try {
    const d = defaultDeps();
    const told = await tell(d, `[REPLY ${key}] 답글 실패: ${why}`, key);
    note(homeStateDir(d.store.root), `FAIL ${key}: ${why} (lead: ${told})`);
  } catch {}
  console.error(`FAIL ${why}`);
  process.exit(1);
}
