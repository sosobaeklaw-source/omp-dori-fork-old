import { expect, test } from "bun:test";
import { allowedSource } from "../src/onto-concepts.ts";

test("allowedSource follows sanjai-agent's is_allowed_source rule", () => {
  const allow = ["book-reading", "seo-9-1111"];
  expect(allowedSource("/Users/x/sobaegi-lead/results/book-reading/a/독서메모.md", allow)).toBe(true);
  expect(allowedSource("/Users/x/sobaegi-lead/results/seo-9-1111/deep/nested/독후감.md", allow)).toBe(true);
  expect(allowedSource("/Users/x/sobaegi-lead/results/case-9999/독후감.md", allow)).toBe(false);
  // The top folder alone decides: a case folder nested inside an allowed one stays allowed, as upstream does.
  expect(allowedSource("/Users/x/sobaegi-lead/results/book-reading/cases/x.md", allow)).toBe(true);
  // Outside the results tree (a statute file, a test tmpdir) is allowed as it is; results itself with no top folder is not.
  expect(allowedSource("/tmp/법령원문.txt", allow)).toBe(false);
  expect(allowedSource("/Users/x/sobaegi-lead/results", allow)).toBe(false);
  // Only the results tree named that way counts; a different tree with the folder name is not the results tree.
  expect(allowedSource("/Users/x/case-9999/results/book-reading/x.md", allow)).toBe(false);
});
