import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashFiles, OWNER_MSG, ROOM } from "./name-hashes.ts";

/** A DORI_HOME with one lane k1 that is ready to reply, and the env to run the hook against it (no live home leaks in). */
function hookHome(sender: string) {
  const home = mkdtempSync(join(tmpdir(), "ready-hook-"));
  for (const d of ["briefs", "state", "results/k1"]) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, "briefs", "k1.md"), `# k1 (회장님 ${OWNER_MSG})\npublic: true\n\n## STOP WHEN\n`);
  writeFileSync(join(home, "results", "k1", "결과.md"), "# r\n\n바뀐 것.\n");
  writeFileSync(join(home, "state", "inbound.log"), `INBOUND discord ${ROOM} ${OWNER_MSG} from=owner ref=- "x"\n`);
  const f = hashFiles();
  const { DORI_STATE_DIR: _s, DORI_CONFIG: _c, DORI_LANE: _l, ...rest } = process.env;
  const env = {
    ...rest,
    DORI_HOME: home,
    DORI_SEND_FILE: sender,
    DORI_NAME_HASHES: f.hashes,
    DORI_NAME_HASH_SALT_FILE: f.saltFile,
  };
  return { home, env, tool: join(import.meta.dir, "..", "tools", "ready_reply.ts") };
}

test("the onReady hook argv (KEY --detach) returns at once and the detached copy posts the reply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ready-sender-"));
  const sent = join(dir, "sent.txt");
  const sender = join(dir, "send.sh");
  writeFileSync(
    sender,
    `#!/bin/sh\necho "$REPLY_TO $DISCORD_CHANNEL $1" > "${sent}.tmp"\nmv "${sent}.tmp" "${sent}"\necho "SENT 1"\n`,
    {
      mode: 0o755,
    },
  );
  const { env, tool } = hookHome(sender);
  const parent = Bun.spawnSync(["bun", tool, "k1", "--detach"], { env });
  expect(parent.exitCode).toBe(0);
  // The detached copy is another process: wait for its write itself, not a guessed duration.
  const { promise, resolve } = Promise.withResolvers<void>();
  const watcher = watch(dir, () => existsSync(sent) && resolve());
  if (existsSync(sent)) resolve();
  await promise;
  watcher.close();
  expect(readFileSync(sent, "utf8").trim()).toBe(`${OWNER_MSG} ${ROOM} 바뀐 것.`);
});

test("a sender that does not exist is a recorded failure, with what became of telling the lead", () => {
  const missing = join(tmpdir(), "no-such-dir", "dori-send-file.sh");
  const { home, env, tool } = hookHome(missing);
  const run = Bun.spawnSync(["bun", tool, "k1"], { env });
  expect(run.exitCode).toBe(1);
  const log = readFileSync(join(home, "state", "ready-reply.log"), "utf8");
  expect(log).toContain(`FAIL k1 ${OWNER_MSG}: cannot run ${missing}`);
  expect(log).toContain("(lead: not told, no lead session registered");
});

test("a reply that went up is a success even when the lead cannot be told, and a lane is answered once", () => {
  const dir = mkdtempSync(join(tmpdir(), "ready-once-"));
  const sender = join(dir, "send.sh");
  writeFileSync(sender, `#!/bin/sh\necho x >> "${dir}/posts"\necho "SENT 42"\n`, { mode: 0o755 });
  const { home, env, tool } = hookHome(sender);
  const run = () => Bun.spawnSync(["bun", tool, "k1"], { env });
  expect(run().exitCode).toBe(0);
  const log = () => readFileSync(join(home, "state", "ready-reply.log"), "utf8");
  expect(log()).toContain(`REPLIED k1 ${OWNER_MSG} 42`);
  expect(log()).not.toContain("FAIL");
  const sentLines = readFileSync(join(home, "state", "discord-sent.log"), "utf8")
    .trim()
    .split("\n");
  expect(sentLines).toHaveLength(1);
  expect(sentLines[0]).toBe(`42\tk1\tall\treply=${OWNER_MSG}\tcloses=${OWNER_MSG}`);
  expect(run().exitCode).toBe(0);
  expect(readFileSync(join(dir, "posts"), "utf8")).toBe("x\n");
  expect(log()).toContain(`SKIP k1: already replied to ${OWNER_MSG}`);
});

test("without the salt file at its default place no lane is answered (fail closed)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ready-nosalt-"));
  const sender = join(dir, "send.sh");
  writeFileSync(sender, `#!/bin/sh\necho x >> "${dir}/posts"\necho "SENT 7"\n`, { mode: 0o755 });
  const { home, env, tool } = hookHome(sender);
  const { DORI_NAME_HASH_SALT_FILE: _salt, ...noSaltEnv } = env;
  const run = Bun.spawnSync(["bun", tool, "k1"], { env: noSaltEnv });
  expect(run.exitCode).toBe(0);
  expect(run.stdout.toString()).toContain("SKIP k1: no readable client-name hashes and salt");
  expect(existsSync(join(dir, "posts"))).toBe(false);
  // The hash file alone, without its salt, is not enough either.
  rmSync(env.DORI_NAME_HASHES);
  expect(Bun.spawnSync(["bun", tool, "k1"], { env: noSaltEnv }).stdout.toString()).toContain("SKIP k1:");
  expect(readFileSync(join(home, "state", "ready-reply.log"), "utf8")).not.toContain("REPLIED");
});

test("a lane not marked public is handed to the lead with its job, results folder and owner message, not posted", () => {
  const dir = mkdtempSync(join(tmpdir(), "ready-tolead-"));
  const poster = join(dir, "send.sh");
  writeFileSync(poster, `#!/bin/sh\necho x >> "${dir}/posts"\necho "SENT 9"\n`, { mode: 0o755 });
  const lead = join(dir, "to-macmini.sh");
  writeFileSync(lead, `#!/bin/sh\n{ echo "$@"; cat; } > "${dir}/lead"\necho "DELIVERED lead file x 10 bytes"\n`, {
    mode: 0o755,
  });
  const { home, env, tool } = hookHome(poster);
  writeFileSync(join(home, "briefs", "k1.md"), `# k1 (회장님 ${OWNER_MSG})\n\n## STOP WHEN\n`);
  const run = Bun.spawnSync(["bun", tool, "k1"], { env: { ...env, DORI_TO_MACMINI: lead } });
  expect(run.exitCode).toBe(0);
  expect(existsSync(join(dir, "posts"))).toBe(false);
  expect(readFileSync(join(dir, "lead"), "utf8")).toBe(
    `--order ${OWNER_MSG} 리드 검수 대기 READY k1\njob: k1\n결과: ${join(home, "results", "k1")}\n원 글번호: ${OWNER_MSG}\n`,
  );
  expect(readFileSync(join(home, "state", "ready-reply.log"), "utf8")).toContain(`HANDED k1 ${OWNER_MSG}:`);
});
