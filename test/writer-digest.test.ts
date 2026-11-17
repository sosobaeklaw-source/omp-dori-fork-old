import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Refusal } from "../src/refusal.ts";
import { buildRequest, casesPath, digestPath } from "../src/writer-request.ts";
import { setup } from "./writer-request-setup.ts";

describe("writer request digest", () => {
  test("a digest opens the body whole, the ledger sections stay, and the kind needs no case list", () => {
    const { home, lane, task } = setup();
    const digest = "소화: 2026-11-17 13:00\n제목은 독자가 겪은 처분 이름으로 시작한다.\n";
    mkdirSync(join(home, "독후감", "소화본"), { recursive: true });
    writeFileSync(digestPath(home, "seo"), digest);
    writeFileSync(casesPath(home, "seo"), "# no list\n");
    const built = buildRequest({ home, kind: "seo", model: "argon", laneDir: lane, tasks: [task] });
    const body = readFileSync(built.path, "utf8");
    expect(body).toStartWith(`=== 0. 지금의 이해 (소화본), verbatim. ===\n\n${digest}`);
    for (const words of ["seo only rejection", "every kind rejection", "first time said", "second time said"])
      expect(body).toContain(words);
    expect(readFileSync(built.path.replace(/\.txt$/, ".count"), "utf8").split("\n")[0]).toEndWith(
      " digest=2026-11-17 13:00",
    );
  });

  test("a digest whose first line is not 소화: YYYY-MM-DD HH:MM is refused", () => {
    const { home, lane, task } = setup();
    mkdirSync(join(home, "독후감", "소화본"), { recursive: true });
    writeFileSync(digestPath(home, "card"), "소화: 어제\n내용\n");
    expect(() => buildRequest({ home, kind: "card", model: "argon", laneDir: lane, tasks: [task] })).toThrow(Refusal);
  });
});
