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
 * `SENT <id>`. A ready-delivery.json manifest stops automatic delivery: a lane can forge its own verdict, and no
 * independently protected desk exists here. The result is handed to the lead to verify and deliver manually. A comparison picture, which the desk
 * never reads, still goes with `--send-without-desk-review` and the posted text says so. Before
 * that call the sender is probed from a fresh empty folder (so a probe of an old copy can never
 * attach a file), and a sender that does not answer it fails with one line saying which file to install. A lane
 * that gets no reply prints `SKIP <why>`, except a lane not marked public: its
 * READY goes to the macmini lead for review (`HANDED`), through DORI_TO_MACMINI (default `<home>/bin/to-macmini.sh`,
 * see examples/sobaek/), with the lane, the orders its brief header marks and its 결과.md itself (the macmini cannot
 * open MacBook paths). No `--order` is passed: a hand-off waiting for review is not the order's delivery, so the
 * hourly loop keeps naming it 결과미전달 until the lead answers the owner. Each READY hands over again (rework is new).
 * Only a lane whose brief carries the line `public: true` (written by the lead for public-material work) is answered;
 * the reply text and the picture's OCR text are checked against salted client-name hashes exported by the macmini:
 * DORI_NAME_HASHES (default `<stateDir>/case-name-hashes.json`) under the salt in DORI_NAME_HASH_SALT_FILE (default
 * `<stateDir>/name_hash_salt`, mode 600). Without both, readable, no lane is answered. OCR is `tesseract`.
 * Every outcome (reply, skip, failure) is appended to `<stateDir>/ready-reply.log`, and a failure, including a sender
 * that is missing or cannot start, is also told to the lead, so a detached run never fails silently. A lane whose
 * owner message already has a REPLIED line is skipped, so READY after rework does not answer twice.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordSent } from "../skills/dori-mode/scripts/src/messenger/discord-sent.ts";
import { need, parse } from "../src/cli-args.ts";
import { type Deps, defaultDeps } from "../src/harness.ts";
import { send } from "../src/inbox.ts";
import { homeStateDir } from "../src/lane-model.ts";
import { loadNameHashes, ocrPicture, ownerMessages, planReply } from "../src/ready-reply.ts";
import { briefOrders } from "./open_orders.ts";

function note(stateDir: string, line: string): void {
  appendFileSync(join(stateDir, "ready-reply.log"), `${new Date().toISOString()} ${line}\n`);
}

/** The repo copy of the sender: the file an outdated installed copy has to be replaced with. */
const SENDER_SRC = join(import.meta.dir, "..", "examples", "sobaek", "dori-send-file.sh");

/** Runs the sender; a spawn that throws (missing or non-executable file) comes back as a failure, not an exception. */
function post(sender: string, text: string, image: string | undefined, env: Record<string, string>) {
  try {
    // Probe features only when needed, from an empty folder: old senders may treat the probe as post text.
    if (image || text.startsWith("-")) {
      const feature = text.startsWith("-") ? "end-of-options" : "send-without-desk-review";
      const probe = Bun.spawnSync([sender, "--supports", feature], {
        cwd: mkdtempSync(join(tmpdir(), "send-probe-")),
        env: { ...process.env, ...env },
      });
      if (probe.exitCode !== 0 || !probe.stdout.toString().trim().startsWith("SUPPORTED"))
        return {
          why: `센더가 ${feature} 기능을 지원하지 않습니다. ${SENDER_SRC} 를 ${sender} 에 설치하세요`,
        };
    }
    const argv = [
      sender,
      ...(image ? ["--send-without-desk-review"] : []),
      ...(text.startsWith("-") ? ["--"] : []),
      text,
      ...(image ? [image] : []),
    ];
    const r = Bun.spawnSync(argv, { env: { ...process.env, ...env } });
    const out = r.stdout.toString().trim();
    const id = /^SENT (\d+)$/m.exec(out)?.[1];
    if (r.exitCode === 0 && id) return { id };
    return { why: (out || r.stderr.toString()).trim().split("\n")[0] || `exit ${r.exitCode}` };
  } catch (error) {
    return { why: `cannot run ${sender}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** At most this much of 결과.md goes into the hand-off; the lead asks the lane for the rest. */
const HAND_MAX = 6000;

/** Hands a READY the owner did not get to the macmini lead; returns the sender's first line or why it failed. */
function hand(sender: string, key: string, resultsDir: string, orders: readonly string[], reason?: string) {
  const file = join(resultsDir, "결과.md");
  const result = existsSync(file) ? readFileSync(file, "utf8") : "(결과.md 없음)";
  const cut = result.length > HAND_MAX ? `${result.slice(0, HAND_MAX)}\n… (맥북 ${file}에 이어짐)` : result;
  const body = `job: ${key}\n원 글번호: ${orders.join(", ") || "-"}\n결과 폴더(맥북): ${resultsDir}\n${reason ? `검수 필요: ${reason}\n` : ""}\n${cut}\n`;
  try {
    const r = Bun.spawnSync([sender, `리드 검수 대기 READY ${key}`], { stdin: Buffer.from(body) });
    const out = (r.stdout.toString() || r.stderr.toString()).trim().split("\n")[0] ?? "";
    return r.exitCode === 0 ? { ok: out } : { why: out || `exit ${r.exitCode}` };
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
    caseNames: loadNameHashes(
      process.env["DORI_NAME_HASHES"] ?? join(stateDir, "case-name-hashes.json"),
      process.env["DORI_NAME_HASH_SALT_FILE"] ?? join(stateDir, "name_hash_salt"),
    ),
    readPicture: ocrPicture,
  });
  const logFile = join(stateDir, "ready-reply.log");
  const replied =
    plan.post && existsSync(logFile) && readFileSync(logFile, "utf8").includes(` REPLIED ${key} ${plan.owner.id} `);
  if (!plan.post || replied) {
    // READY again after rework does not answer the same owner message twice.
    const why = plan.post ? `already replied to ${plan.owner.id}` : plan.why;
    console.log(`SKIP ${key}: ${why}`);
    if (a.flags.has("dry-run")) return 0;
    if (plan.post || !plan.toLead) {
      note(stateDir, `SKIP ${key}: ${why}`);
      return 0;
    }
    // Not public: the owner's room is not the place to decide that, the lead is. It reviews and forwards.
    const orders = plan.toLead.orders;
    const sender = process.env["DORI_TO_MACMINI"] ?? join(home, "bin", "to-macmini.sh");
    const r = hand(sender, key, join(home, "results", key), orders);
    const ids = orders.join(",") || "-";
    if ("ok" in r) {
      note(stateDir, `HANDED ${key} ${ids}: ${why}, to the lead (${r.ok})`);
      return 0;
    }
    const told = await tell(d, `[READY ${key}] 리드 검수 넘김 실패: ${r.why}`, key);
    note(stateDir, `FAIL ${key} ${ids}: not handed to the lead: ${r.why} (lead: ${told})`);
    console.error(`FAIL ${r.why}`);
    return 1;
  }
  const { owner, image } = plan;
  const results = join(home, "results", key);
  const manifest = join(results, "ready-delivery.json");
  if (existsSync(manifest)) {
    const why = "untrusted review: automatic reviewed delivery disabled; lead must verify and deliver";
    const log = join(stateDir, "ready-reply.log");
    const file = join(results, "결과.md");
    const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
    const receipt = ` HANDED ${key} owner=${owner.id} sha256=${hash} `;
    if (
      existsSync(log) &&
      readFileSync(log, "utf8")
        .split("\n")
        .some((line) => line.includes(receipt))
    ) {
      console.log(`SKIP ${key}: already handed to lead`);
      if (!a.flags.has("dry-run")) note(stateDir, `SKIP ${key} ${owner.id}: already handed sha256=${hash}`);
      return 0;
    }
    if (a.flags.has("dry-run")) {
      console.log(`HAND ${key}: ${why}`);
      return 0;
    }
    const orders = [
      ...new Set([...briefOrders(existsSync(briefPath) ? readFileSync(briefPath, "utf8") : ""), owner.id]),
    ];
    const sender = process.env["DORI_TO_MACMINI"] ?? join(home, "bin", "to-macmini.sh");
    const r = hand(sender, key, results, orders, why);
    const ids = orders.join(",") || "-";
    if ("ok" in r) {
      note(stateDir, `HANDED ${key} owner=${owner.id} sha256=${hash} ${ids}: ${why}, to the lead (${r.ok})`);
      return 0;
    }
    const told = await tell(d, `[READY ${key}] 리드 검수 넘김 실패: ${r.why}`, key);
    note(stateDir, `FAIL ${key} ${ids}: not handed to the lead: ${r.why} (lead: ${told})`);
    console.error(`FAIL ${why}: ${r.why}`);
    return 1;
  }
  const text = plan.text;
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
  // The reply is up: from here a failure is noted, never reported as a failed reply.
  note(stateDir, `REPLIED ${key} ${owner.id} ${id}`);
  try {
    recordSent(stateDir, id, key, "all", { reply: owner.id, closes: owner.id });
  } catch (error) {
    note(
      stateDir,
      `NOTE ${key}: reply ${id} not recorded as sent (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const told = await tell(
    d,
    `[REPLY ${key}] 회장님 원글 ${owner.id}에 결과 답글 ${id}${image ? " (그림 1)" : ""}`,
    key,
  );
  if (told.startsWith("not told")) note(stateDir, `NOTE ${key}: reply ${id}, lead ${told}`);
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
