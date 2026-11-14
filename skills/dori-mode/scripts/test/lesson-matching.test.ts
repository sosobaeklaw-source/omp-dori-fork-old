import { afterEach, beforeEach, expect, test } from "bun:test";
import { Lessons, prepareLessons, REPO_LESSON_CAP } from "../src/lessons.ts";
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

test("omission warnings name only matching lessons excluded by the cap", () => {
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
  expect(prepared.warnings).toEqual([expect.stringContaining(oldest.id)]);
  expect(prepared.warnings.join("\n")).not.toContain(unrelated.id);
});
