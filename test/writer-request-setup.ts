/** A synthetic ledger, case notes and lane for the writer-request tests. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Kind, ledgerPath } from "../src/writer-ledger.ts";
import { casesPath } from "../src/writer-request.ts";

// One synthetic entry per kind, one for all kinds, and a repeat pair whose first entry is seo-only.
export const LEDGER = `# ledger

## 2026-01-01 09:00 · seo · msg 101 · post 7
원문: "seo only rejection"

## 2026-01-01 09:01 · card · msg 102 · post -
원문: "card only rejection"

## 2026-01-01 09:02 · video · msg 103 · post -
원문: "video only rejection"

## 2026-01-01 09:03 · legal · msg 104 · post -
원문: "legal only rejection"

## 2026-01-01 09:04 · all · msg 105 · post -
원문: "every kind rejection"

## 2026-01-01 09:05 · seo · msg 106 · post 7
원문: "first time said"

## 2026-01-02 09:00 · seo,card · msg 107 · post 7 · 반복 106
원문: "second time said"
전: "before sentence"
후: "after sentence"
`;

export const KIND_ONLY: Record<Kind, string> = {
  seo: "seo only rejection",
  card: "card only rejection",
  video: "video only rejection",
  legal: "legal only rejection",
};

export const CASE_1 = '전: "the first sentence before it was fixed"';
export const CASE_2 = '후: "the same sentence after it was fixed"';
// Lines 1-5 hold two case lines: a heading, a table rule and a short line are not case lines; line 6 is outside.
export const NOTES = ["# heading", CASE_1, "|---|---|", "short", CASE_2, "a line outside the range, long enough"].join(
  "\n",
);

export function setup(): { home: string; lane: string; task: string; notes: string } {
  const home = mkdtempSync("/tmp/dwr-");
  const notes = join(home, "notes.md");
  writeFileSync(ledgerPath(home), LEDGER);
  writeFileSync(notes, NOTES);
  mkdirSync(join(home, "writer-cases"));
  for (const kind of Object.keys(KIND_ONLY) as Kind[])
    writeFileSync(casesPath(home, kind), `# ${kind}\n${notes}:1-5\n`);
  const lane = join(home, "lane");
  const task = join(home, "task.txt");
  writeFileSync(task, "Write section 2.");
  return { home, lane, task, notes };
}
