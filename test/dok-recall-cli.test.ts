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
    Bun.spawnSync(["bun", tool, brief, "--root", root, "--allow", "fax-1110"], {
      env: {
        ...rest,
        DORI_HOME: home,
        DORI_NAME_HASHES: hashes,
        DORI_NAME_HASH_SALT_FILE: saltFile,
      },
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

test("dok_recall reads only the allowed top folders under the root", () => {
  const home = mkdtempSync(join(tmpdir(), "dok-allow-"));
  const root = join(home, "results");
  const note = (rel: string, topic: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), `# 독후감 — ${topic}\n\n## ${topic} 지시\n${topic} 이야기를 적은 줄이다.\n`);
  };
  note("fax-1110/독후감_팩스.md", "팩스 보내기");
  note("case-9999/독후감_팩스.md", "팩스 보내기");
  const brief = join(home, "brief.md");
  writeFileSync(brief, "# 팩스 보내기\n");
  const tool = join(import.meta.dir, "..", "tools", "dok_recall.ts");
  const { DORI_STATE_DIR: _s, DORI_CONFIG: _c, DORI_LANE: _l, ...rest } = process.env;
  const f = hashFiles();
  const p = Bun.spawnSync(["bun", tool, brief, "--root", root, "--allow", "fax-1110"], {
    env: {
      ...rest,
      DORI_HOME: home,
      DORI_NAME_HASHES: f.hashes,
      DORI_NAME_HASH_SALT_FILE: f.saltFile,
    },
  });
  expect(p.exitCode).toBe(0);
  expect(p.stdout.toString()).toContain("fax-1110/독후감_팩스.md:");
  expect(p.stdout.toString()).not.toContain("case-9999");
});

test("dok_recall recalls nothing and prints one line when the allowlist cannot be read", () => {
  const home = mkdtempSync(join(tmpdir(), "dok-nolist-"));
  const root = join(home, "results");
  mkdirSync(join(root, "fax-1110"), { recursive: true });
  writeFileSync(join(root, "fax-1110", "독후감.md"), `# 독후감 — 팩스\n\n## 팩스 보내기\n팩스 이야기를 적은 줄이다.\n`);
  const brief = join(home, "brief.md");
  writeFileSync(brief, "# 팩스 보내기\n");
  const tool = join(import.meta.dir, "..", "tools", "dok_recall.ts");
  const {
    DORI_STATE_DIR: _s,
    DORI_CONFIG: _c,
    DORI_LANE: _l,
    DORI_STUDY_DIRS: _d,
    DORI_SANJAI_PYTHON: _p,
    DORI_ONTO_HOST: _h,
    ...rest
  } = process.env;
  const f = hashFiles();
  // Both allowlist sources are made unreadable: the venv python is a missing file and the host cannot resolve.
  const p = Bun.spawnSync(["bun", tool, brief, "--root", root], {
    env: {
      ...rest,
      DORI_HOME: home,
      DORI_NAME_HASHES: f.hashes,
      DORI_NAME_HASH_SALT_FILE: f.saltFile,
      DORI_SANJAI_PYTHON: join(home, "no-python"),
      DORI_ONTO_HOST: "dok-recall-test.invalid..host",
    },
  });
  expect(p.stdout.toString()).toBe("");
  expect(p.exitCode).not.toBe(0);
  const err = p.stderr.toString().trim();
  expect(err.split("\n")).toHaveLength(1);
  expect(err).toContain("nothing is recalled");
});
