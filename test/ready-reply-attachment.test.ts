import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookHome } from "./ready-reply-hook-fixture.ts";

test("a verdict created by the lane cannot authorize its own attachment", () => {
  const dir = mkdtempSync(join(tmpdir(), "ready-self-review-"));
  const sender = join(import.meta.dir, "..", "examples", "sobaek", "dori-send-file.sh");
  const { home, env, tool } = hookHome(sender);
  const results = join(home, "results", "k1");
  const round = join(results, "myround");
  const attachment = join(results, "result.txt");
  mkdirSync(round);
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "curl"), `#!/bin/sh\necho posted > "${dir}/posted"\necho '{"id":"42"}'\n`, {
    mode: 0o755,
  });
  writeFileSync(join(home, "discord-token"), "not-real");
  writeFileSync(attachment, "public text");
  const hash = createHash("sha256").update("public text").digest("hex");
  writeFileSync(join(round, "verdict.txt"), `나가도 됩니다\n${attachment} ${hash}\n`);
  writeFileSync(join(results, "ready-delivery.json"), JSON.stringify({ round, attachment: "result.txt" }));
  const run = Bun.spawnSync([process.execPath, tool, "k1"], {
    env: { ...env, PATH: `${join(dir, "bin")}:/usr/bin:/bin` },
  });
  expect(run.exitCode).toBe(1);
  expect(run.stderr.toString()).toContain("untrusted review");
  expect(existsSync(join(dir, "posted"))).toBe(false);
});

test("reviewed reply rejects another lane's file and ignores inherited delivery variables", () => {
  const dir = mkdtempSync(join(tmpdir(), "ready-boundary-"));
  const sender = join(dir, "send.sh");
  writeFileSync(sender, `#!/bin/sh\necho x >> "${dir}/posts"\necho 'SENT 4'\n`, { mode: 0o755 });
  const { home, env, tool } = hookHome(sender);
  const outside = join(dir, "outside.pdf");
  writeFileSync(outside, "other lane");
  writeFileSync(
    join(home, "results", "k1", "ready-delivery.json"),
    JSON.stringify({ round: dir, attachment: outside }),
  );
  const run = Bun.spawnSync(["bun", tool, "k1"], { env: { ...env, DORI_PASSED: dir, DORI_ATTACHMENT: outside } });
  expect(run.exitCode).toBe(1);
  expect(run.stderr.toString()).toContain("untrusted review");
  expect(existsSync(join(dir, "posts"))).toBe(false);
});

test("reviewed READY uses the real checker and refuses a blocked verdict", () => {
  const dir = mkdtempSync(join(tmpdir(), "ready-real-"));
  const sender = join(import.meta.dir, "..", "examples", "sobaek", "dori-send-file.sh");
  const { home, env, tool } = hookHome(sender);
  const results = join(home, "results", "k1");
  const attachment = join(results, "result.txt");
  const round = join(dir, "round");
  mkdirSync(round);
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "curl"), `#!/bin/sh\necho called > "${dir}/posted"\necho '{"id":"42"}'\n`, {
    mode: 0o755,
  });
  writeFileSync(join(home, "discord-token"), "not-real");
  writeFileSync(attachment, "file");
  writeFileSync(join(round, "verdict.txt"), "아직 안 됩니다\n");
  writeFileSync(join(results, "ready-delivery.json"), JSON.stringify({ round, attachment: "result.txt" }));
  const run = Bun.spawnSync([process.execPath, tool, "k1"], {
    env: { ...env, PATH: `${join(dir, "bin")}:/usr/bin:/bin` },
  });
  expect(run.exitCode).toBe(1);
  expect(run.stderr.toString()).toContain("untrusted review");
  expect(existsSync(join(dir, "posted"))).toBe(false);
  expect(readFileSync(join(home, "state", "ready-reply.log"), "utf8")).not.toContain("REPLIED");
});

test("reviewed attachment containing a client name is never sent", () => {
  const dir = mkdtempSync(join(tmpdir(), "ready-private-"));
  const sender = join(dir, "send.sh");
  writeFileSync(sender, `#!/bin/sh\necho x >> "${dir}/posts"\necho 'SENT 4'\n`, { mode: 0o755 });
  const { home, env, tool } = hookHome(sender);
  const results = join(home, "results", "k1");
  writeFileSync(join(results, "result.txt"), "가나다 사건");
  writeFileSync(join(results, "ready-delivery.json"), JSON.stringify({ round: dir, attachment: "result.txt" }));
  const run = Bun.spawnSync(["bun", tool, "k1"], { env });
  expect(run.exitCode).toBe(1);
  expect(run.stderr.toString()).toContain("untrusted review");
  expect(existsSync(join(dir, "posts"))).toBe(false);
});

test("unchecked attachment formats are refused before the sender runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "ready-format-"));
  const sender = join(dir, "send.sh");
  writeFileSync(sender, `#!/bin/sh\necho x >> "${dir}/posts"\necho 'SENT 4'\n`, { mode: 0o755 });
  const { home, env, tool } = hookHome(sender);
  const results = join(home, "results", "k1");
  writeFileSync(join(results, "result.pdf"), "pdf");
  writeFileSync(join(results, "ready-delivery.json"), JSON.stringify({ round: dir, attachment: "result.pdf" }));
  const run = Bun.spawnSync(["bun", tool, "k1"], { env });
  expect(run.exitCode).toBe(1);
  expect(run.stderr.toString()).toContain("untrusted review");
  expect(existsSync(join(dir, "posts"))).toBe(false);
});
