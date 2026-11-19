import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

test("single-dash text works with an old sender without probing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ready-single-dash-"));
  const sender = join(dir, "send.sh");
  writeFileSync(
    sender,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\n[ "$1" != "--supports" ] || exit 64\necho 'SENT 42'\n`,
    { mode: 0o755 },
  );
  const { home, env, tool } = hookHome(sender);
  writeFileSync(join(home, "results", "k1", "결과.md"), "# 결과\n\n-x 결과\n");
  expect(Bun.spawnSync(["bun", tool, "k1"], { env }).exitCode).toBe(0);
  expect(readFileSync(join(dir, "args"), "utf8")).toBe("-x 결과\n");
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
