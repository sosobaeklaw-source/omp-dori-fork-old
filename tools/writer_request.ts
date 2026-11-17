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
import { addEntry, kindOf } from "../src/writer-ledger.ts";
import { buildRequest, countCases, END, kindRanges, writerOf } from "../src/writer-request.ts";
import { fillSheet, readSheet } from "../src/writer-sheet.ts";
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
      -> DIR/requests/NN_<model>[_NAME].txt and .count; --sheet adds a word sheet's [key] slots (figure, table,
         cover, alt, caption words) after the tasks, and --task may then be left out. The 독후감 passages the task
         and sheet call for are recalled and added (ontology concepts widen the query); the .count lists every atom
         as [PATH:LINE] for the delivery review. --no-recall keeps only the kind's list and --cases
  writer_request fill --sheet FILE --answer FILE --out FILE.json
      -> the writer's words per [key] of the sheet, as JSON for the renderer; exit 1 if a key is missing or empty
  writer_request count FILE --kind seo|card|video|legal [--cases PATH:START-END] [--cases PATH:START-END]
      -> exit 1 unless every case line of those passages sits above the task line of FILE
  writer_request add --kind KIND[,KIND]|all --msg ID --text TEXT [--post ID] [--repeat ID]
                     [--before TEXT --after TEXT] [--date "YYYY-MM-DD HH:MM"]
  writer_request send --model argon|hydrogen --lane KEY --prompt FILE --out FILE [--meta FILE] [--timeout S]
                      [--runner gemini_web_runner.mjs]
      -> runs the runner on the first free seat of DORI_HOME/writer-seats.txt, waits only while all are busy or
         resting after an on-screen limit; exits with the runner's code, the seat written into the meta`;

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
        timeout: Number(one(a, "timeout") ?? 1800),
      },
    );
    console.log(`SENT_ON ${seat.account} ${seat.expect} exit=${code}`);
    process.exit(code);
  } else throw new Refusal(USAGE);
} catch (e) {
  if (!(e instanceof Refusal)) throw e;
  console.error(e.message);
  process.exit(1);
}
