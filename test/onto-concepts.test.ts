import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { allowedSource, conceptsPath, guidelineSource } from "../src/onto-concepts.ts";

const ROOT = "/Users/x/sobaegi-lead/results";

test("guidelineSource counts only the home sanjai-agent corpus, anchored", () => {
  const home = "/Users/x";
  const guide = (source: string) => guidelineSource(source, home);
  // The two corpus folders under this home, however the path is spelled.
  expect(guide(`${home}/sanjai-agent/corpus/jichim/x.md`)).toBe(true);
  expect(guide(`${home}/sanjai-agent/corpus/knowledge/deep/x.md`)).toBe(true);
  expect(guide(`${home}//sanjai-agent/./corpus/knowledge/x.md`)).toBe(true);
  // Another tree that merely holds the same path, a sibling that only starts with the same word and a climb out.
  expect(guide("/tmp/x/sanjai-agent/corpus/jichim/x.md")).toBe(false);
  expect(guide(`${home}/sanjai-agent/corpus/knowledge-old/x.md`)).toBe(false);
  expect(guide(`${home}/sanjai-agent/corpus/jichim/../../secret/x.md`)).toBe(false);
  // The home's other folders, the corpus root itself and relative paths are not guideline sources.
  expect(guide(`${home}/sanjai-agent/cases/A/난청지침.pdf`)).toBe(false);
  expect(guide(`${home}/sanjai-agent/corpus/x.md`)).toBe(false);
  expect(guide("sanjai-agent/corpus/jichim/x.md")).toBe(false);
});

test("allowedSource follows sanjai-agent's is_allowed_source rule", () => {
  const allow = ["book-reading", "seo-9-1111"];
  const ok = (source: string) => allowedSource(source, allow, ROOT);
  expect(ok(`${ROOT}/book-reading/a/독서메모.md`)).toBe(true);
  expect(ok(`${ROOT}/seo-9-1111/deep/nested/독후감.md`)).toBe(true);
  expect(ok(`${ROOT}//book-reading/./a.md`)).toBe(true);
  expect(ok(`${ROOT}/case-9999/독후감.md`)).toBe(false);
  expect(ok(`${ROOT}/book-reading-x/a.md`)).toBe(false);
  // The top folder alone decides: a case folder nested inside an allowed one stays allowed, as upstream does.
  expect(ok(`${ROOT}/book-reading/cases/x.md`)).toBe(true);
  // Outside the results tree, the tree itself, a relative path, another tree and a climb out are all refused.
  expect(ok("/tmp/법령원문.txt")).toBe(false);
  expect(ok(ROOT)).toBe(false);
  expect(ok("sobaegi-lead/results/book-reading/a.md")).toBe(false);
  expect(ok("/tmp/z/sobaegi-lead/results/book-reading/a.md")).toBe(false);
  expect(ok("/Users/x/case-9999/results/book-reading/x.md")).toBe(false);
  expect(ok(`${ROOT}/book-reading/../case-9999/a.md`)).toBe(false);
});

function run(home: string, db: string, studyDirs: string, args: string[] = ["--host", "local", "--db", db]) {
  const { DORI_STATE_DIR: _s, DORI_CONFIG: _c, DORI_LANE: _l, ...rest } = process.env;
  return Bun.spawnSync(["bun", join(import.meta.dir, "..", "tools", "onto_concepts.ts"), ...args], {
    env: { ...rest, DORI_HOME: home, DORI_STUDY_DIRS: studyDirs },
  });
}

test("onto_concepts exports only concepts with an allowed, unflagged public fact", () => {
  const home = mkdtempSync(join(tmpdir(), "onto-concepts-"));
  const dbPath = join(home, "onto.sqlite");
  const db = new Database(dbPath);
  db.run("create table objects(id integer primary key, type text, name text)");
  db.run("create table aliases(object_id integer, alias text)");
  db.run("create table links(src_id integer, dst_id integer)");
  db.run("create table facts(id integer primary key, object_id integer, source text, origin text)");
  db.run("create table review_flags(fact_id integer)");
  const results = join(homedir(), "sobaegi-lead", "results");
  const corpus = join(homedir(), "sanjai-agent", "corpus", "jichim", "난청지침.pdf");
  const caseFile = join(homedir(), "sanjai-agent", "cases", "A", "난청지침.pdf");
  const rows: [number, string, string, string, boolean][] = [
    [1, "공개상병", `${results}/book-reading/a.md`, "public_reading.jsonl", false],
    [2, "사건상병", `${results}/book-reading/a.md`, "case_import.jsonl", false],
    [3, "검수제외상병", `${results}/book-reading/a.md`, "public_reading.jsonl", true],
    [4, "허용밖상병", `${results}/case-9999/a.md`, "public_reading.jsonl", false],
    [5, "결과밖상병", "/tmp/a.md", "public_reading.jsonl", false],
    [6, "지침상병", corpus, "noise_guideline_records.jsonl", false],
    [7, "지침꼴사건상병", caseFile, "noise_guideline_records.jsonl", false],
    [8, "지침제외상병", corpus, "noise_guideline_records.jsonl", true],
  ];
  for (const [id, name, source, origin, flagged] of rows) {
    db.run("insert into objects values (?, '상병', ?)", [id, name]);
    db.run("insert into aliases values (?, ?)", [id, `${name}별칭`]);
    db.run("insert into facts values (?, ?, ?, ?)", [id, id, source, origin]);
    if (flagged) db.run("insert into review_flags values (?)", [id]);
  }
  db.close();
  const r = run(home, dbPath, "book-reading");
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(readFileSync(conceptsPath(home), "utf8")) as { concepts: { name: string }[] };
  expect(out.concepts.map((c) => c.name)).toEqual(["공개상병", "지침상병"]);
});

test("onto_concepts --help prints the usage and writes nothing", () => {
  const home = mkdtempSync(join(tmpdir(), "onto-concepts-"));
  const r = run(home, "", "book-reading", ["--help"]);
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toContain("usage:");
  expect(existsSync(conceptsPath(home))).toBe(false);
});

test("onto_concepts without a readable allowlist replaces an earlier export with an empty one", () => {
  const home = mkdtempSync(join(tmpdir(), "onto-concepts-"));
  const dbPath = join(home, "onto.sqlite");
  const db = new Database(dbPath);
  db.run("create table objects(id integer primary key, type text, name text)");
  db.close();
  writeFileSync(
    conceptsPath(home),
    JSON.stringify({ made: "x", concepts: [{ type: "상병", name: "옛개념", terms: ["a"] }] }),
  );
  const { DORI_STATE_DIR: _s, DORI_CONFIG: _c, DORI_LANE: _l, DORI_STUDY_DIRS: _d, ...rest } = process.env;
  const r = Bun.spawnSync(
    ["bun", join(import.meta.dir, "..", "tools", "onto_concepts.ts"), "--host", "local", "--db", dbPath],
    { env: { ...rest, DORI_HOME: home, HOME: home, DORI_ONTO_HOST: "" } },
  );
  expect(r.exitCode).toBe(1);
  const out = JSON.parse(readFileSync(conceptsPath(home), "utf8")) as { concepts: unknown[] };
  expect(out.concepts).toEqual([]);
});
