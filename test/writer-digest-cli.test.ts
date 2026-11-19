import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ledgerPath } from "../src/writer-ledger.ts";
import { digestPath } from "../src/writer-request.ts";
import { LEDGER, setup } from "./writer-request-setup.ts";

/** The tool as the lead runs it: the receipt line it prints, the file it writes and its exit code. */
function tool(home: string, ...args: string[]) {
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "../tools/writer_request.ts"), ...args], {
    env: { ...process.env, DORI_HOME: home, DORI_NOTES_ROOT: join(home, "no-notes") },
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const DIGEST_HEAD = "=== 0. 지금의 이해 (소화본), verbatim. ===";

describe("writer_request as run: the digest body and the change receipts", () => {
  test("build accepts incident as a request kind", () => {
    const { home, lane, task } = setup();
    const built = tool(home, "build", "--kind", "incident", "--model", "hydrogen", "--lane-dir", lane, "--task", task);
    expect(built.code).toBe(0);
    expect(existsSync(join(lane, "requests", "01_hydrogen.txt"))).toBe(true);
  });

  test("build opens the written file with that kind's digest whole and never another kind's, and says which file it wrote", () => {
    const { home, lane, task } = setup();
    mkdirSync(join(home, "독후감", "소화본"), { recursive: true });
    const card = "소화: 2026-11-17 13:00\n카드 제목은 주어를 먼저 둔다.\n";
    writeFileSync(digestPath(home, "card"), card);
    writeFileSync(digestPath(home, "seo"), "소화: 2026-11-17 14:00\n검색 글 제목은 처분 이름으로 시작한다.\n");
    const args = (kind: string) => ["build", "--kind", kind, "--model", "argon", "--lane-dir", lane, "--task", task];

    const built = tool(home, ...args("card"));
    const cardBody = join(lane, "requests", "01_argon.txt");
    expect(built.code).toBe(0);
    expect(built.out).toStartWith(`BUILT ${cardBody} `);
    expect(readFileSync(cardBody, "utf8")).toStartWith(`${DIGEST_HEAD}\n\n${card}`);
    expect(readFileSync(cardBody, "utf8")).not.toContain("검색 글 제목");
    expect(readFileSync(join(lane, "requests", "01_argon.count"), "utf8").split("\n")[0]).toEndWith(
      " digest=2026-11-17 13:00",
    );

    expect(tool(home, ...args("video")).code).toBe(0);
    const videoBody = readFileSync(join(lane, "requests", "02_argon.txt"), "utf8");
    expect(videoBody).not.toContain(DIGEST_HEAD);
    expect(videoBody).not.toContain("카드 제목은");
    expect(videoBody).not.toContain("검색 글 제목");
    expect(readFileSync(join(lane, "requests", "02_argon.count"), "utf8").split("\n")[0]).not.toContain("digest=");
  });

  test("a digest without its 소화 date line stops the build with the file named and no request written", () => {
    const { home, lane, task } = setup();
    mkdirSync(join(home, "독후감", "소화본"), { recursive: true });
    writeFileSync(digestPath(home, "card"), "카드는 이렇게 쓴다.\n");
    const built = tool(home, "build", "--kind", "card", "--model", "argon", "--lane-dir", lane, "--task", task);
    expect(built.code).toBe(1);
    expect(built.err).toContain(digestPath(home, "card"));
    expect(built.out).toBe("");
    expect(existsSync(join(lane, "requests"))).toBe(false);
  });

  test("pair prints the entry it changed and writes 전 then 후 under it; a second pair or an unknown msg exits 1 with the ledger as it was", () => {
    const { home } = setup();
    const done = tool(home, "pair", "--msg", "101", "--before", "b1", "--after", "a1");
    expect(done).toMatchObject({ code: 0, out: "PAIRED ## 2026-01-01 09:00 · seo · msg 101 · post 7\n" });
    const paired = LEDGER.replace('원문: "seo only rejection"\n', '원문: "seo only rejection"\n전: "b1"\n후: "a1"\n');
    expect(readFileSync(ledgerPath(home), "utf8")).toBe(paired);

    for (const [msg, why] of [
      ["101", "already has"],
      ["999", "not in the ledger"],
    ] as const) {
      const again = tool(home, "pair", "--msg", msg, "--before", "x", "--after", "y");
      expect(again.code).toBe(1);
      expect(again.err).toContain(why);
      expect(again.out).toBe("");
      expect(readFileSync(ledgerPath(home), "utf8")).toBe(paired);
    }
  });
});
