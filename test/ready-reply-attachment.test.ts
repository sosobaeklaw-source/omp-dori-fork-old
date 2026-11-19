import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookHome } from "./ready-reply-hook-fixture.ts";

test("ordinary text uses an old sender without probing or an option terminator", () => {
  const dir = mkdtempSync(join(tmpdir(), "ready-old-text-"));
  const sender = join(dir, "send.sh");
  writeFileSync(
    sender,
    `#!/bin/sh\nprintf '%s\\n' "$@" >> "${dir}/args"\n[ "$1" != "--supports" ] || exit 64\necho 'SENT 42'\n`,
    { mode: 0o755 },
  );
  const { env, tool } = hookHome(sender);
  expect(Bun.spawnSync(["bun", tool, "k1"], { env }).exitCode).toBe(0);
  expect(readFileSync(join(dir, "args"), "utf8")).toBe("바뀐 것.\n");
});

test("option-like result text is passed after the option terminator", () => {
  const dir = mkdtempSync(join(tmpdir(), "ready-dashes-"));
  const sender = join(dir, "send.sh");
  writeFileSync(
    sender,
    `#!/bin/sh\n[ "$1" = "--supports" ] && { echo "SUPPORTED $2"; exit 0; }\nprintf '%s\\n' "$@" > "${dir}/args"\necho 'SENT 42'\n`,
    { mode: 0o755 },
  );
  const { home, env, tool } = hookHome(sender);
  writeFileSync(join(home, "results", "k1", "결과.md"), "# 결과\n\n--x 결과\n");
  expect(Bun.spawnSync(["bun", tool, "k1"], { env }).exitCode).toBe(0);
  expect(readFileSync(join(dir, "args"), "utf8")).toBe("--\n--x 결과\n");
});

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
  const lead = join(dir, "lead.sh");
  writeFileSync(lead, "#!/bin/sh\ncat >/dev/null\necho DELIVERED\n", { mode: 0o755 });
  const run = Bun.spawnSync([process.execPath, tool, "k1"], {
    env: { ...env, DORI_TO_MACMINI: lead, PATH: `${join(dir, "bin")}:/usr/bin:/bin` },
  });
  expect(run.exitCode).toBe(0);
  expect(readFileSync(join(home, "state", "ready-reply.log"), "utf8")).toContain("HANDED k1");
  expect(existsSync(join(dir, "posted"))).toBe(false);
});

test("a manifest naming another lane's file is handed to the lead without posting", () => {
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
  const lead = join(dir, "lead.sh");
  writeFileSync(lead, "#!/bin/sh\ncat >/dev/null\necho DELIVERED\n", { mode: 0o755 });
  const run = Bun.spawnSync(["bun", tool, "k1"], {
    env: { ...env, DORI_TO_MACMINI: lead, DORI_PASSED: dir, DORI_ATTACHMENT: outside },
  });
  expect(run.exitCode).toBe(0);
  expect(readFileSync(join(home, "state", "ready-reply.log"), "utf8")).toContain("HANDED k1");
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
  const lead = join(dir, "lead.sh");
  writeFileSync(lead, "#!/bin/sh\ncat >/dev/null\necho DELIVERED\n", { mode: 0o755 });
  const run = Bun.spawnSync([process.execPath, tool, "k1"], {
    env: { ...env, DORI_TO_MACMINI: lead, PATH: `${join(dir, "bin")}:/usr/bin:/bin` },
  });
  expect(run.exitCode).toBe(0);
  expect(readFileSync(join(home, "state", "ready-reply.log"), "utf8")).toContain("HANDED k1");
  expect(existsSync(join(dir, "posted"))).toBe(false);
  expect(readFileSync(join(home, "state", "ready-reply.log"), "utf8")).not.toContain("REPLIED");
});
