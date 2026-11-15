import { afterEach, beforeEach, expect, test } from "bun:test";
import { BRIEF_EVIDENCE_CHARS, Lessons, prepareLessons, REPO_LESSON_CAP } from "../src/lessons.ts";
import { type TestState, withState } from "./fakes.ts";

const T0 = Date.parse("2026-10-29T00:00:00Z");
let state: TestState;
let lessons: Lessons;
const input = { lane: "demo-lane", cwd: "/repo", rule: "Subscribe before triggering", evidence: "/evidence/test.txt" };

beforeEach(() => {
  state = withState();
  lessons = new Lessons(state.dir);
});
afterEach(() => state.done());

test("brief matching includes short Korean and technical tokens but excludes unrelated and common-word matches", () => {
  const korean = lessons.add({ ...input, rule: "산재 판정 확인" }, T0);
  const technical = lessons.add({ ...input, rule: "Fix API response" }, T0 + 1);
  lessons.add({ ...input, rule: "Run deployment checks" }, T0 + 2);
  const selected = lessons.forRepo("/repo", "산재 API 작업을 확인");
  expect(selected.lessons.map((lesson) => lesson.id)).toEqual([technical.id, korean.id]);
  expect(selected.omitted).toEqual([]);
  expect(lessons.forRepo("/repo", "Run the deployment").lessons.map((lesson) => lesson.rule)).toEqual([
    "Run deployment checks",
  ]);
  expect(lessons.forRepo("/repo", "the and for").lessons).toEqual([]);
});

test("warnings name each lesson a cap omitted and each repo lesson the brief match filtered", () => {
  const matching = Array.from({ length: REPO_LESSON_CAP + 1 }, (_, i) =>
    lessons.add({ ...input, rule: `Login rule ${i}` }, T0 + i),
  );
  const unrelated = lessons.add({ ...input, rule: "Deployment checks" }, T0 + 100);
  const prepared = prepareLessons(state.dir, "/repo", "Login task");
  expect(prepared.lessons.map((lesson) => lesson.id)).toEqual(
    matching
      .slice(1)
      .reverse()
      .map((lesson) => lesson.id),
  );
  const oldest = matching[0];
  if (!oldest) throw new Error("fixture missing");
  expect(prepared.warnings).toEqual([
    expect.stringMatching(new RegExp(`^LESSON_OMITTED ${oldest.id} `)),
    `LESSON_FILTERED ${unrelated.id} (/repo) Deployment checks`,
  ]);
});

test("a global standing rule reaches a brief it shares no word with; a filtered repo lesson is named", () => {
  const global = lessons.add(
    { lane: "lead", scope: "global", rule: "Never change the global Git identity", evidence: "slack:D1/2.1" },
    T0,
  );
  const repo = lessons.add({ ...input, rule: "Run deployment checks" }, T0 + 1);
  const prepared = prepareLessons(state.dir, "/repo", "Fix the login bug.");
  expect(prepared.lessons.map((lesson) => lesson.id)).toEqual([global.id]);
  expect(lessons.forRepo("/repo", "Fix the login bug.").filtered.map((lesson) => lesson.id)).toEqual([repo.id]);
  expect(prepared.warnings).toEqual([`LESSON_FILTERED ${repo.id} (/repo) Run deployment checks`]);
  expect(prepareLessons(state.dir, "/repo", "Run the deployment").warnings).toEqual([]);
});

test("matching follows plurals, word stems and Korean particles; numbers and common verbs alone never match", () => {
  const plural = lessons.add({ ...input, rule: "Tests must subscribe first" }, T0);
  const stem = lessons.add({ ...input, rule: "Deploy behind a flag" }, T0 + 1);
  const korean = lessons.add({ ...input, rule: "테스트를 먼저 고정" }, T0 + 2);
  lessons.add({ ...input, rule: "Fix 50 flaky checks" }, T0 + 3);
  lessons.add({ ...input, rule: "Confirm the owner" }, T0 + 4);
  const brief = "Fix the test for the deployment config; 테스트는 50초 안에 끝나야 한다.";
  expect(lessons.forRepo("/repo", brief).lessons.map((lesson) => lesson.id)).toEqual([korean.id, stem.id, plural.id]);
});

test("a brief shows the first BRIEF_EVIDENCE_CHARS of long evidence; the journal keeps it whole", () => {
  const evidence = `/evidence/${"x".repeat(2 * BRIEF_EVIDENCE_CHARS)}`;
  const lesson = lessons.add({ ...input, evidence }, T0);
  const { preamble } = prepareLessons(state.dir, "/repo", "Subscribe first");
  const shown = `${evidence.slice(0, BRIEF_EVIDENCE_CHARS - 3)}...`;
  expect(preamble).toContain(`source: ${shown}] ${input.rule}`);
  expect(preamble).not.toContain(evidence);
  expect(lessons.read().lessons).toEqual([lesson]);
});
