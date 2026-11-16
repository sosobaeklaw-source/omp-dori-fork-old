#!/usr/bin/env bun
/**
 * Print the case-note (독후감) passages a brief needs, as `PATH:START-END` lines for `writer_request --cases` or
 * `DORI_HOME/writer-cases/<kind>.txt`. See src/dok-recall.ts. The harness home is DORI_HOME (default ~/.dori).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { need, one, parse } from "../src/cli-args.ts";
import { briefQuery, citations, label, loadNotes, rank, recall } from "../src/dok-recall.ts";
import { Refusal } from "../src/refusal.ts";
import { defaultHome } from "../src/test-home.ts";

const USAGE = `usage:
  dok_recall BRIEF [--root DIR] [--limit N] [--max-chars CHARS]
      -> up to N passages (default 10) of at most CHARS/N characters each, CHARS in all (default 8000), best
         first, one PATH:START-END a line; then the notes the budget left out, as "# over budget: PATH:START-END"
         lines. DIR defaults to ~/sobaegi-lead/results. Notes cited in DORI_HOME/briefs and writer-cases rank higher.`;

try {
  const a = parse(process.argv.slice(2));
  const brief = need(a.pos[0], "BRIEF");
  if (a.pos.length > 1) throw new Refusal(`unexpected argument ${a.pos.slice(1).join(" ")}\n${USAGE}`);
  const limit = Number(one(a, "limit") ?? 10);
  const maxChars = Number(one(a, "max-chars") ?? 8000);
  if (!(limit >= 1) || !(maxChars >= 1)) throw new Refusal(`--limit and --max-chars take a positive number\n${USAGE}`);
  const notes = loadNotes(one(a, "root") ?? join(homedir(), "sobaegi-lead", "results"));
  if (notes.length === 0) throw new Refusal("no 독후감 notes under the root");
  const query = briefQuery(readFileSync(brief, "utf8"));
  const { kept, over } = recall(query, rank(query, notes, citations(defaultHome(), brief)), limit, maxChars);
  for (const p of kept) console.log(label(p));
  for (const p of over) console.log(`# over budget: ${label(p)}`);
} catch (e) {
  if (!(e instanceof Refusal)) throw e;
  console.error(e.message);
  process.exit(1);
}
