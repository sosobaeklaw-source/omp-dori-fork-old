import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashFiles } from "./name-hashes.ts";

test("dok_recall prints nothing and exits non-zero when the name hashes or salt cannot be read", () => {
  const home = mkdtempSync(join(tmpdir(), "dok-cli-"));
  const root = join(home, "results");
  mkdirSync(join(root, "fax-1110"), { recursive: true });
  const lines = Array.from({ length: 3 }, (_, i) => `팩스 이야기를 ${i}번째로 적은 줄이다.`);
  writeFileSync(join(root, "fax-1110", "독후감.md"), `# 독후감 — 팩스\n\n## 팩스 보내기\n${lines.join("\n")}\n`);
  const brief = join(home, "brief.md");
  writeFileSync(brief, "# 팩스 보내기\n");
  const tool = join(import.meta.dir, "..", "tools", "dok_recall.ts");
  const { DORI_STATE_DIR: _s, DORI_CONFIG: _c, DORI_LANE: _l, ...rest } = process.env;
  const run = (hashes: string, saltFile: string) =>
    Bun.spawnSync(["bun", tool, brief, "--root", root], {
      env: { ...rest, DORI_HOME: home, DORI_NAME_HASHES: hashes, DORI_NAME_HASH_SALT_FILE: saltFile },
    });
  const f = hashFiles();
  // With both files readable the note prints, so the empty runs below are the name check failing closed.
  const ok = run(f.hashes, f.saltFile);
  expect(ok.exitCode).toBe(0);
  expect(ok.stdout.toString()).toContain("fax-1110/독후감.md:");
  const other = hashFiles(["가나다"], "another-salt");
  for (const [hashes, salt] of [
    [join(home, "no-hashes.json"), f.saltFile],
    [f.hashes, join(home, "no-salt")],
    [f.hashes, other.saltFile],
  ]) {
    const r = run(hashes!, salt!);
    expect(r.stdout.toString()).toBe("");
    expect(r.exitCode).not.toBe(0);
  }
});
