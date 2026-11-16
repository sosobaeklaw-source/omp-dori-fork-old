import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Refusal } from "../src/refusal.ts";
import {
  addEntry,
  buildRequest,
  casesPath,
  countCases,
  END,
  type Kind,
  ledgerPath,
  readRange,
  writerOf,
} from "../src/writer-request.ts";

// One synthetic entry per kind, one for all kinds, and a repeat pair whose first entry is seo-only.
const LEDGER = `# ledger

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

const KIND_ONLY: Record<Kind, string> = {
  seo: "seo only rejection",
  card: "card only rejection",
  video: "video only rejection",
  legal: "legal only rejection",
};

const CASE_1 = '전: "the first sentence before it was fixed"';
const CASE_2 = '후: "the same sentence after it was fixed"';
// Lines 1-5 hold two case lines: a heading, a table rule and a short line are not case lines; line 6 is outside.
const NOTES = ["# heading", CASE_1, "|---|---|", "short", CASE_2, "a line outside the range, long enough"].join("\n");

function setup(): { home: string; lane: string; task: string; notes: string } {
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

describe("writer request", () => {
  test("each kind gets its own rejections, the all-kind ones and every repeat pair, then the task", () => {
    const { home, lane, task, notes } = setup();
    for (const kind of Object.keys(KIND_ONLY) as Kind[]) {
      const built = buildRequest({ home, kind, model: "argon", laneDir: lane, tasks: [task] });
      const body = readFileSync(built.path, "utf8");
      for (const [other, words] of Object.entries(KIND_ONLY)) expect(body.includes(words)).toBe(other === kind);
      expect(body).toContain("every kind rejection");
      // The repeat pair reaches every kind, the seo-only first saying included, with the fixed sentences.
      for (const words of ["first time said", "second time said", '전: "before sentence"', '후: "after sentence"'])
        expect(body).toContain(words);
      expect(body).toContain(`[${notes}:1-5]\n${NOTES.split("\n").slice(0, 5).join("\n")}\n`);
      expect(body).not.toContain("a line outside the range");
      expect(body.indexOf(CASE_1)).toBeLessThan(body.indexOf("Write section 2."));
      expect(built).toMatchObject({ dok: 2, reject: 2, repeat: 2 });
    }
  });

  test("bodies are numbered in the lane's requests folder with the counts beside them", () => {
    const { home, lane, task, notes } = setup();
    const first = buildRequest({ home, kind: "card", model: "hydrogen", laneDir: lane, tasks: [task] });
    const second = buildRequest({ home, kind: "card", model: "argon", laneDir: lane, tasks: [task], label: "s2" });
    expect(first.path).toBe(join(lane, "requests", "01_hydrogen.txt"));
    expect(second.path).toBe(join(lane, "requests", "02_argon_s2.txt"));
    expect(readFileSync(join(lane, "requests", "02_argon_s2.count"), "utf8")).toBe(
      `dok=2 reject=2 repeat=2\n${notes}:1-5 2/2\n`,
    );
  });

  test("a case line counts only above the task line", () => {
    const { notes } = setup();
    const r = [readRange(`${notes}:1-5`)];
    expect(countCases("rule: put the deadline first.", r)[0]).toMatchObject({ hit: 0, total: 2 });
    expect(countCases(`${CASE_1}\n${END}\n`, r)[0]).toMatchObject({ hit: 1, total: 2 });
    expect(countCases(`intro\n${END}\n${CASE_1}\n${CASE_2}\n`, r)[0]).toMatchObject({ hit: 0, total: 2 });
  });

  test("the CLI refuses a second value after one flag, and count exits 1 unless every case line is there", () => {
    const { home, lane, task, notes } = setup();
    const run = (...args: string[]) => {
      const p = Bun.spawnSync(["bun", join(import.meta.dir, "../tools/writer_request.ts"), ...args], {
        env: { ...process.env, DORI_HOME: home },
      });
      return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
    };
    const extra = join(home, "extra.md");
    writeFileSync(extra, `${CASE_2}\n`);
    const base = ["build", "--kind", "seo", "--model", "argon", "--lane-dir", lane, "--task", task];
    expect(run(...base, "--cases", `${notes}:1-5`, `${extra}:1-1`)).toMatchObject({ code: 1 });
    expect(run(...base, "--cases", `${notes}:1-5`, "--cases", `${extra}:1-1`).code).toBe(0);
    const body = join(lane, "requests", "01_argon.txt");
    expect(run("count", body, "--kind", "seo", "--cases", `${extra}:1-1`).code).toBe(0);
    writeFileSync(join(home, "hand.txt"), `${CASE_1}\n${END}\n`);
    expect(run("count", join(home, "hand.txt"), "--kind", "seo").code).toBe(1);
    writeFileSync(join(home, "noend.txt"), `${CASE_1}\n${CASE_2}\n`);
    expect(run("count", join(home, "noend.txt"), "--kind", "seo")).toMatchObject({ code: 1 });
    expect(run("count", join(home, "noend.txt"), "--kind", "seo").out).toContain(`no "${END}" line`);
  });

  test("a range must be PATH:START-END inside the file, hold a case line and not hold the task line", () => {
    const { home, lane, task, notes } = setup();
    for (const span of ["5-3", "0-2", "3", "x-4"])
      expect(() => readRange(`${notes}:${span}`)).toThrow("PATH:START-END");
    expect(() => readRange(`${notes}:1-99`)).toThrow("file has 6");
    const build = (spec: string) => () =>
      buildRequest({ home, kind: "seo", model: "argon", laneDir: lane, tasks: [task], cases: [spec] });
    expect(build(`${notes}:3-4`)).toThrow("holds no case line");
    const trap = join(home, "trap.md");
    writeFileSync(trap, `${CASE_1}\n${END}\n`);
    expect(build(`${trap}:1-2`)).toThrow("would end the case block");
  });

  test("only argon and hydrogen write: carbon is the red team and anything else is refused", () => {
    expect(writerOf("argon")).toBe("argon");
    expect(writerOf("hydrogen")).toBe("hydrogen");
    expect(() => writerOf("carbon")).toThrow("carbon is the red team");
    for (const other of ["opus", "gpt", undefined]) expect(() => writerOf(other)).toThrow(Refusal);
  });

  test("add appends an owner 지적 verbatim and marks a repeat only of an entry already in the ledger", () => {
    const { home } = setup();
    const id = "1571654989041115348";
    expect(() => addEntry({ home, kinds: "card", msg: id, text: "x", repeats: "999" })).toThrow("not in the ledger");
    expect(() => addEntry({ home, kinds: "blog", msg: id, text: "x" })).toThrow(Refusal);
    addEntry({ home, kinds: "card", msg: id, text: "new words", repeats: "102", before: "a b", after: "c d" });
    expect(() => addEntry({ home, kinds: "card", msg: id, text: "again" })).toThrow("already in the ledger");
    expect(readFileSync(ledgerPath(home), "utf8")).toEndWith(
      `\n## 2026-11-16 07:35 · card · msg ${id} · post - · 반복 102\n원문: "new words"\n전: "a b"\n후: "c d"\n`,
    );
  });
});
