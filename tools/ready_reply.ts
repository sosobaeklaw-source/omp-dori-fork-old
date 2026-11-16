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
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { recordSent } from "../skills/dori-mode/scripts/src/messenger/discord-sent.ts";
import { need, parse } from "../src/cli-args.ts";
import { defaultDeps } from "../src/harness.ts";
import { send } from "../src/inbox.ts";
import { homeStateDir } from "../src/lane-model.ts";
import { ownerMessages, planReply } from "../src/ready-reply.ts";

async function main(argv: readonly string[]): Promise<number> {
  const a = parse(argv);
  const key = need(a.pos[0], "lane key");
  if (a.flags.has("detach")) {
    const again = process.argv.filter((arg) => arg !== "--detach");
    Bun.spawn(again, { stdio: ["ignore", "ignore", "ignore"], detached: true }).unref();
    return 0;
  }
  const d = defaultDeps();
  const home = d.store.root;
  const stateDir = homeStateDir(home);
  const briefPath = d.store.lane(key)?.brief ?? d.store.briefPath(key);
  const plan = planReply({
    brief: existsSync(briefPath) ? readFileSync(briefPath, "utf8") : "",
    resultsDir: join(home, "results", key),
    owners: ownerMessages(join(stateDir, "inbound.log")),
  });
  if (!plan.post) {
    console.log(`SKIP ${key}: ${plan.why}`);
    return 0;
  }
  const { owner, text, image } = plan;
  if (a.flags.has("dry-run")) {
    console.log(`REPLY_TO ${owner.id} channel ${owner.channel}\nIMAGE ${image ?? "-"}\nTEXT\n${text}`);
    return 0;
  }
  const sender = process.env["DORI_SEND_FILE"] ?? join(home, "bin", "dori-send-file.sh");
  const posted = Bun.spawnSync([sender, text, ...(image ? [image] : [])], {
    env: { ...process.env, REPLY_TO: owner.id, DISCORD_CHANNEL: owner.channel },
  });
  const out = posted.stdout.toString().trim();
  const id = /^SENT (\d+)$/m.exec(out)?.[1];
  if (posted.exitCode !== 0 || !id) {
    const why = (out || posted.stderr.toString()).trim().split("\n")[0] || `exit ${posted.exitCode}`;
    await send(d, "lead", `[REPLY ${key}] 회장님 원글 ${owner.id} 답글 실패: ${why}`, key);
    console.error(`FAIL ${why}`);
    return 1;
  }
  recordSent(stateDir, id, key, "all");
  await send(d, "lead", `[REPLY ${key}] 회장님 원글 ${owner.id}에 결과 답글 ${id}${image ? " (그림 1)" : ""}`, key);
  console.log(`REPLIED ${owner.id} ${id}`);
  return 0;
}

process.exit(await main(process.argv.slice(2)));
