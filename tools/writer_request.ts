#!/usr/bin/env bun
/**
 * Build a writing model's request body, count the case lines in one built by hand, add an owner 지적 to the ledger,
 * or send a built body on whichever writing seat is free. See src/writer-request.ts and src/writer-seat.ts. The
 * harness home is DORI_HOME (default ~/.dori).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { alive } from "../skills/dori-mode/scripts/src/checkpoint-lock.ts";
import { need, one, parse } from "../src/cli-args.ts";
import { RECALL, type Recalled, recallFor } from "../src/dok-recall.ts";
import { homeStateDir } from "../src/lane-model.ts";
import { conceptsPath, loadConcepts } from "../src/onto-concepts.ts";
import { loadNameHashes } from "../src/ready-reply.ts";
import { Refusal } from "../src/refusal.ts";
import { defaultHome } from "../src/test-home.ts";
import { addEntry, kindOf, pairEntry } from "../src/writer-ledger.ts";
import { buildRequest, countCases, END, kindRanges, writerOf } from "../src/writer-request.ts";
import { fillSheet, readSheet } from "../src/writer-sheet.ts";
import { accountFromLog, machineUsage, runLogFor } from "../src/agy-logs.ts";
import { readConfig } from "../src/hooks.ts";
import { AgyStop, sendOnAgy } from "../src/writer-agy.ts";
import { sendOnSeat } from "../src/writer-seat.ts";

/**
 * The 독후감 passages this request's own task and sheet text calls for, widened by the ontology concepts
 * (DORI_HOME/ontology-concepts.json, tools/onto_concepts.ts). Passages go to a writing model, so without the
 * client-name hashes (the same files dok_recall reads) nothing is recalled and the count file says why.
 */
function recallPassages(home: string, texts: readonly string[]): Recalled & { off?: string; concepts: string } {
  const stateDir = homeStateDir(home);
  const hashFile = process.env["DORI_NAME_HASHES"] ?? join(stateDir, "case-name-hashes.json");
  const saltFile = process.env["DORI_NAME_HASH_SALT_FILE"] ?? join(stateDir, "name_hash_salt");
  const names = loadNameHashes(hashFile, saltFile);
  const concepts = loadConcepts(home)?.concepts;
  const have = concepts ? `${concepts.length} concepts` : `no ${conceptsPath(home)}`;
  if (!names)
    return { specs: [], onto: [], concepts: have, off: `no readable client-name hashes and salt (${hashFile})` };
  const root = process.env["DORI_NOTES_ROOT"] ?? join(homedir(), "sobaegi-lead", "results");
  if (!existsSync(root)) return { specs: [], onto: [], concepts: have, off: `no notes root ${root}` };
  const text = texts.map((t) => readFileSync(t, "utf8")).join("\n");
  return { ...recallFor(home, text, names, { root, concepts: concepts ?? [], ...RECALL }), concepts: have };
}

const USAGE = `usage:
  writer_request build --kind seo|card|video|legal --model argon|hydrogen --lane-dir DIR --task FILE [--task FILE]
                       [--sheet FILE] [--cases PATH:START-END] [--cases PATH:START-END] [--label NAME] [--no-recall]
      -> DIR/requests/NN_<model>[_NAME].txt and .count; DORI_HOME/독후감/소화본/<kind>.md, when there, opens the body
         whole (first line "소화: YYYY-MM-DD HH:MM", else exit 1) and the .count head ends digest=DATE; --sheet adds a word sheet's [key] slots (figure, table,
         cover, alt, caption words) after the tasks, and --task may then be left out. The 독후감 passages the task
         and sheet call for are recalled and added (ontology concepts widen the query); the .count lists every atom
         as [PATH:LINE] for the delivery review. --no-recall keeps only the kind's list and --cases
  writer_request fill --sheet FILE --answer FILE --out FILE.json
      -> the writer's words per [key] of the sheet, as JSON for the renderer; exit 1 if a key is missing or empty
  writer_request count FILE --kind seo|card|video|legal [--cases PATH:START-END] [--cases PATH:START-END]
      -> exit 1 unless every case line of those passages sits above the task line of FILE
  writer_request add --kind KIND[,KIND]|all --msg ID --text TEXT [--post ID] [--repeat ID]
                     [--before TEXT --after TEXT] [--date "YYYY-MM-DD HH:MM"]
  writer_request pair --msg ID --before TEXT --after TEXT
      -> puts 전:/후: under that entry's 원문 line; exit 1 if the msg is missing or already has them
  writer_request send --model argon|hydrogen --lane KEY --prompt FILE --out FILE [--meta FILE] [--timeout S]
                      [--runner gemini_web_runner.mjs]
      -> runs the runner on the first free seat of DORI_HOME/writer-seats.txt, waits only while all are busy or
         resting after an on-screen limit; exits with the runner's code, the seat written into the meta
  writer_request agy --lane KEY --prompt FILE --out FILE [--meta FILE] [--timeout S]
      -> one Argon body request through the agy CLI, logged into the one mail set as agyAccount in DORI_HOME/config.json
         (or DORI_AGY_ACCOUNT). Lanes call at the same time. Google's quota error (429) exits 26 and no lane calls until
         the reset Google named (state/agy-s4.quota-until); a file-linked answer is asked once more; a 403 stops the seat (state/agy-stopped.json). The call log is
         GEMINI_CALLS_TSV or state/gemini-calls.tsv. Body writing only: never review, red team or tests.`;

/** `agyAccount` in config.json: the one mail the agy seat calls as, kept out of this repo. */
function agyAccountIn(config: object): string | undefined {
  const v = (config as { agyAccount?: unknown }).agyAccount;
  if (v === undefined || (typeof v === "string" && /^[^@\s]+@[^@\s]+$/.test(v))) return v;
  throw new Refusal("config.json: agyAccount must be one mail address");
}

/** `--timeout` in seconds: a positive whole number, or 1800 when absent; anything else would reach agy as `NaNs`. */
function secondsOf(v: string | undefined): number {
  if (v === undefined) return 1800;
  if (!/^[1-9]\d*$/.test(v)) throw new Refusal(`--timeout must be a positive whole number of seconds, not ${v}`);
  return Number(v);
}

try {
  const a = parse(process.argv.slice(2));
  const home = defaultHome();
  const cmd = a.pos[0];
  // Every flag takes one value, so a second value after --cases or --task would otherwise drop out unseen.
  const stray = a.pos.slice(cmd === "count" ? 2 : 1);
  if (stray.length > 0)
    throw new Refusal(`unexpected argument ${stray.join(" ")}: repeat the flag for each value\n${USAGE}`);
  if (cmd === "build") {
    const tasks = a.flags.get("task") ?? [];
    const sheet = one(a, "sheet");
    const recalled = a.flags.has("no-recall")
      ? { specs: [], onto: [], off: "--no-recall" }
      : recallPassages(
          home,
          [...tasks, ...(sheet ? [sheet] : [])].filter((f) => existsSync(f)),
        );
    const built = buildRequest({
      home,
      kind: kindOf(one(a, "kind")),
      model: writerOf(one(a, "model")),
      laneDir: need(one(a, "lane-dir"), "--lane-dir"),
      tasks,
      sheet,
      cases: a.flags.get("cases") ?? [],
      label: one(a, "label"),
      recalled,
    });
    console.log(`BUILT ${built.path} dok=${built.dok} reject=${built.reject} repeat=${built.repeat}`);
  } else if (cmd === "fill") {
    const sheet = readSheet(need(one(a, "sheet"), "--sheet"), END);
    const words = fillSheet(sheet, readFileSync(need(one(a, "answer"), "--answer"), "utf8"));
    const out = need(one(a, "out"), "--out");
    writeFileSync(out, `${JSON.stringify(words, null, 1)}\n`);
    console.log(`FILLED ${out} ${sheet.keys.length} keys`);
  } else if (cmd === "count") {
    const file = need(a.pos[1], "FILE");
    const request = readFileSync(file, "utf8");
    if (!request.includes(`\n${END}\n`)) console.error(`${file}: no "${END}" line, so no case line counts`);
    const counts = countCases(request, kindRanges(home, kindOf(one(a, "kind")), a.flags.get("cases")));
    for (const c of counts) console.log(`${file}\t${c.label}\t${c.hit}/${c.total}`);
    if (counts.length === 0 || counts.some((c) => c.total === 0 || c.hit < c.total)) process.exit(1);
  } else if (cmd === "add") {
    const head = addEntry({
      home,
      kinds: need(one(a, "kind"), "--kind"),
      msg: need(one(a, "msg"), "--msg"),
      text: need(one(a, "text"), "--text"),
      post: one(a, "post"),
      repeats: one(a, "repeat"),
      before: one(a, "before"),
      after: one(a, "after"),
      date: one(a, "date"),
    });
    console.log(`ADDED ${head}`);
  } else if (cmd === "pair") {
    const head = pairEntry({
      home,
      msg: need(one(a, "msg"), "--msg"),
      before: need(one(a, "before"), "--before"),
      after: need(one(a, "after"), "--after"),
    });
    console.log(`PAIRED ${head}`);
  } else if (cmd === "send") {
    const out = need(one(a, "out"), "--out");
    const runner = one(a, "runner") ?? join(homedir(), "sanjai-agent", "scripts", "gemini_web_runner.mjs");
    const { code, seat } = await sendOnSeat(
      {
        root: home,
        pid: process.pid,
        now: Date.now,
        alive,
        sleep: (ms) => Bun.sleep(ms),
        log: (line) => console.error(line),
        // The runner is named on the lock (onSpawn) and gets this process's SIGTERM/SIGINT, so killing `send`
        // stops the runner too instead of leaving it on an account whose lock looks free.
        run: async (args, onSpawn) => {
          const child = Bun.spawn(["node", runner, ...args], { stdio: ["ignore", "inherit", "inherit"] });
          onSpawn(child.pid);
          const term = () => child.kill("SIGTERM");
          const int = () => child.kill("SIGINT");
          process.on("SIGTERM", term).on("SIGINT", int);
          try {
            return await child.exited;
          } finally {
            process.off("SIGTERM", term).off("SIGINT", int);
          }
        },
      },
      {
        home,
        lane: need(one(a, "lane"), "--lane"),
        model: writerOf(one(a, "model")),
        prompt: need(one(a, "prompt"), "--prompt"),
        out,
        meta: one(a, "meta") ?? `${out.replace(/\.txt$/, "")}.meta.json`,
        timeout: secondsOf(one(a, "timeout")),
      },
    );
    console.log(`SENT_ON ${seat.account} ${seat.expect} exit=${code}`);
    process.exit(code);
  } else if (cmd === "agy") {
    const out = need(one(a, "out"), "--out");
    const agyDir = join(homedir(), ".gemini", "antigravity-cli");
    const agyLog = join(agyDir, "cli.log");
    const seatAccount = process.env["DORI_AGY_ACCOUNT"] || agyAccountIn(readConfig(home));
    let code: number;
    try {
      code = await sendOnAgy(
        {
          now: Date.now,
          log: (line) => console.error(line),
          account: () => accountFromLog(agyLog),
          seatAccount,
          usage: () => machineUsage(join(agyDir, "log"), seatAccount ?? ""),
          runLog: (workDir) => runLogFor(join(agyDir, "log"), workDir),
          run: async (args, cwd) => {
            const child = Bun.spawn(["agy", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
            const term = () => child.kill("SIGTERM");
            process.on("SIGTERM", term).on("SIGINT", term);
            try {
              const [stdout, stderr, exit] = await Promise.all([
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
                child.exited,
              ]);
              return { code: exit, stdout, stderr };
            } finally {
              process.off("SIGTERM", term).off("SIGINT", term);
            }
          },
        },
        {
          home,
          lane: need(one(a, "lane"), "--lane"),
          prompt: need(one(a, "prompt"), "--prompt"),
          out,
          meta: one(a, "meta") ?? `${out.replace(/\.txt$/, "")}.meta.json`,
          timeout: secondsOf(one(a, "timeout")),
          calls: process.env["GEMINI_CALLS_TSV"] || join(home, "state", "gemini-calls.tsv"),
        },
      );
    } catch (e) {
      if (!(e instanceof AgyStop)) throw e;
      console.error(e.message);
      process.exit(e.code);
    }
    console.log(`SENT_ON agy-s4 exit=${code}`);
    process.exit(code);
  } else throw new Refusal(USAGE);
} catch (e) {
  if (!(e instanceof Refusal)) throw e;
  console.error(e.message);
  process.exit(1);
}
