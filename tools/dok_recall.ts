#!/usr/bin/env bun
/**
 * Print the case-note (독후감) passages a brief needs, as `PATH:START-END` lines for `writer_request --cases` or
 * `DORI_HOME/writer-cases/<kind>.txt`. See src/dok-recall.ts. The harness home is DORI_HOME (default ~/.dori).
 * The passages go to a writing model, so one holding a client name is left out. Names are matched by salted hash, the
 * same files ready_reply reads: DORI_NAME_HASHES (default `<stateDir>/case-name-hashes.json`) under the salt in
 * DORI_NAME_HASH_SALT_FILE (default `<stateDir>/name_hash_salt`, mode 600). Without both, readable, nothing prints.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { need, one, parse } from "../src/cli-args.ts";
import { briefQuery, citations, label, loadNotes, rank, recall } from "../src/dok-recall.ts";
import { homeStateDir } from "../src/lane-model.ts";
import { loadNameHashes } from "../src/ready-reply.ts";
import { Refusal } from "../src/refusal.ts";
import { readStudyDirs } from "../src/study-dirs.ts";
import { defaultHome } from "../src/test-home.ts";

const USAGE = `usage:
  dok_recall BRIEF [--root DIR] [--allow a,b,c] [--limit N] [--max-chars CHARS]
      -> up to N passages (default 10) of at most CHARS/N characters each, CHARS in all (default 8000), best
         first, one PATH:START-END a line; then the notes the budget left out, as "# over budget: PATH:START-END"
         lines. DIR defaults to ~/sobaegi-lead/results, read only in its allowed top folders: sanjai-agent's
         STUDY_DIRS at run time (local ~/sanjai-agent, then ssh to ~/.omp-dori/onto-host), or --allow's folders.
         When no allowlist can be read, nothing is recalled and one line says so. Notes cited in DORI_HOME/briefs
         and writer-cases rank higher. Passages holding a client name, registration or phone number or case-folder
         path are left out.`;

try {
  const a = parse(process.argv.slice(2));
  const brief = need(a.pos[0], "BRIEF");
  if (a.pos.length > 1) throw new Refusal(`unexpected argument ${a.pos.slice(1).join(" ")}\n${USAGE}`);
  const limit = Number(one(a, "limit") ?? 10);
  const maxChars = Number(one(a, "max-chars") ?? 8000);
  if (!(limit >= 1) || !(maxChars >= 1)) throw new Refusal(`--limit and --max-chars take a positive number\n${USAGE}`);
  const stateDir = homeStateDir(defaultHome());
  const hashFile = process.env["DORI_NAME_HASHES"] ?? join(stateDir, "case-name-hashes.json");
  const saltFile = process.env["DORI_NAME_HASH_SALT_FILE"] ?? join(stateDir, "name_hash_salt");
  const names = loadNameHashes(hashFile, saltFile);
  if (!names) throw new Refusal(`no readable client-name hashes and salt (${hashFile}, ${saltFile})`);
  // The allowlist is sanjai-agent's own (never a copy in this repo); without one, nothing is recalled.
  const given = one(a, "allow")
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allow = given && given.length > 0 ? given : readStudyDirs();
  if (!allow)
    throw new Refusal(
      "cannot read sanjai-agent STUDY_DIRS (DORI_STUDY_DIRS, ~/sanjai-agent, ~/.omp-dori/onto-host): nothing is recalled",
    );
  const notes = loadNotes(one(a, "root") ?? join(homedir(), "sobaegi-lead", "results"), allow);
  if (notes.length === 0) throw new Refusal("no 독후감 notes under the root");
  const query = briefQuery(readFileSync(brief, "utf8"));
  const ranked = rank(query, notes, citations(defaultHome(), brief));
  const { kept, over } = recall(query, ranked, limit, maxChars, names);
  if (kept.length === 0) console.error(`no 독후감 passage matches ${brief} (${notes.length} notes read)`);
  for (const p of kept) console.log(label(p));
  for (const p of over) console.log(`# over budget: ${label(p)}`);
} catch (e) {
  if (!(e instanceof Refusal)) throw e;
  console.error(e.message);
  process.exit(1);
}
