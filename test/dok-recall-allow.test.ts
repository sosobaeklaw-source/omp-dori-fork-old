import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { loadNotes, recallFor } from "../src/dok-recall.ts";
import { filler, NONE, tree } from "./dok-recall-setup.ts";

test("loadNotes with an allowlist reads only those top folders, and no folder at all without one", () => {
  const root = tree();
  expect(loadNotes(root, ["fax-1110"]).map((n) => relative(root, n.path))).toEqual(["fax-1110/독후감_팩스.md"]);
  expect(loadNotes(root, []).map((n) => relative(root, n.path))).toEqual([]);
});

test("recallFor with no allowlist at hand recalls nothing", () => {
  const root = join(mkdtempSync(join(tmpdir(), "dok-noallow-")), "results");
  mkdirSync(join(root, "injury-1110"), { recursive: true });
  writeFileSync(
    join(root, "injury-1110", "독후감.md"),
    `# 독후감 — 상병 이름\n\n## 다발성골절\n${filler("장기손상", 2).join("\n")}\n`,
  );
  const home = mkdtempSync(join(tmpdir(), "dok-noallow-home-"));
  const saved = { ...process.env };
  process.env["DORI_STUDY_DIRS"] = "";
  process.env["DORI_SANJAI_PYTHON"] = "/nonexistent/dok-recall-python";
  process.env["DORI_ONTO_HOST"] = "dok-recall-test.invalid..host";
  try {
    const got = recallFor(home, "장기손상 요양", NONE, {
      root,
      concepts: [],
      limit: 5,
      maxChars: 5000,
    });
    expect(got.specs).toEqual([]);
  } finally {
    for (const k of ["DORI_STUDY_DIRS", "DORI_SANJAI_PYTHON", "DORI_ONTO_HOST"])
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
  }
});
