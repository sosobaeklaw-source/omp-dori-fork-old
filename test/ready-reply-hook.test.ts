import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
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

test("a picture goes up through the explicit unreviewed path with the text beside it; without a picture the sender gets the text alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "ready-picture-"));
  const sender = join(dir, "send.sh");
  writeFileSync(
    sender,
    `#!/bin/sh
[ "$1" = "--supports" ] && { echo "SUPPORTED $2"; exit 0; }
printf '%s\\n' "$@" > "${dir}/argv"
echo "SENT 9"
`,
    { mode: 0o755 },
  );
  const tesseract = join(dir, "tesseract.sh");
  writeFileSync(tesseract, "#!/bin/sh\necho 자막 전후 비교\n", { mode: 0o755 });
  const { home, env, tool } = hookHome(sender);
  const picture = join(home, "results", "k1", "비교.png");
  writeFileSync(picture, "png");
  const run = Bun.spawnSync(["bun", tool, "k1"], { env: { ...env, DORI_TESSERACT: tesseract } });
  expect(run.exitCode).toBe(0);
  expect(readFileSync(join(dir, "argv"), "utf8").split("\n")).toEqual([
    "--send-without-desk-review",
    "바뀐 것.",
    picture,
    "",
  ]);
  rmSync(picture);
  rmSync(join(home, "state", "ready-reply.log"));
  expect(Bun.spawnSync(["bun", tool, "k1"], { env }).exitCode).toBe(0);
  expect(readFileSync(join(dir, "argv"), "utf8").split("\n")).toEqual(["바뀐 것.", ""]);
});

test("the capability probe runs from an empty folder, so a file named passed in the working dir can never be posted", () => {
  const dir = mkdtempSync(join(tmpdir(), "ready-probe-cwd-"));
  const work = join(dir, "work");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "passed"), "절대 나가면 안 되는 파일");
  const calls = join(dir, "calls");
  const sender = join(dir, "send.sh");
  // An old-style sender: it reads --supports as the text and the next argument as a file to attach, from its cwd.
  writeFileSync(
    sender,
    `#!/bin/sh
printf '%s\\n' "$(pwd)" "$*" >> "${calls}"
echo "REFUSED no --passed review round folder was named" >&2
exit 65
`,
    { mode: 0o755 },
  );
  const tesseract = join(dir, "tesseract.sh");
  writeFileSync(tesseract, "#!/bin/sh\necho 자막 전후 비교\n", { mode: 0o755 });
  const { home, env, tool } = hookHome(sender);
  writeFileSync(join(home, "results", "k1", "비교.png"), "png");
  const run = Bun.spawnSync(["bun", tool, "k1"], { env: { ...env, DORI_TESSERACT: tesseract }, cwd: work });
  expect(run.exitCode).toBe(1);
  expect(run.stderr.toString()).toContain("examples/sobaek/dori-send-file.sh");
  const [probePwd, probeArgs] = readFileSync(calls, "utf8").split("\n");
  expect(probeArgs).toBe("--supports passed"); // the only call the old sender ever saw
  expect(probePwd && probePwd !== realpathSync(work)).toBe(true); // a fresh folder, not the working dir
  expect(probePwd ? readdirSync(probePwd) : ["not empty"]).toEqual([]); // empty: nothing an old sender could attach
  expect(existsSync(join(work, "passed"))).toBe(true); // never read, never posted
  expect(readFileSync(join(home, "state", "ready-reply.log"), "utf8")).toContain(`FAIL k1 ${OWNER_MSG}:`);
});

test("an old-style sender that does not know the flag is named for replacement, and never receives the flag as text", () => {
  const dir = mkdtempSync(join(tmpdir(), "ready-oldsender-"));
  const calls = join(dir, "calls");
  const sender = join(dir, "send.sh");
  // The hand-installed copy this finding is about: no --supports, so like the old sender it reads the flag as the text.
  writeFileSync(
    sender,
    `#!/bin/sh
printf '%s\\n' "$*" >> "${calls}"
echo "REFUSED no --passed review round folder was named" >&2
exit 65
`,
    { mode: 0o755 },
  );
  const tesseract = join(dir, "tesseract.sh");
  writeFileSync(tesseract, "#!/bin/sh\necho 자막 전후 비교\n", { mode: 0o755 });
  const { home, env, tool } = hookHome(sender);
  writeFileSync(join(home, "results", "k1", "비교.png"), "png");
  const run = Bun.spawnSync(["bun", tool, "k1"], { env: { ...env, DORI_TESSERACT: tesseract } });
  expect(run.exitCode).toBe(1);
  expect(run.stderr.toString()).toContain("examples/sobaek/dori-send-file.sh");
  expect(readFileSync(join(home, "state", "ready-reply.log"), "utf8")).toContain(`FAIL k1 ${OWNER_MSG}:`);
  expect(readFileSync(calls, "utf8").split("\n")).toEqual(["--supports passed", ""]);
});

/** A to-macmini stand-in that records its argv and stdin, and the home whose k1 brief is not public. */
function handHome(script: string) {
  const dir = mkdtempSync(join(tmpdir(), "ready-tolead-"));
  const poster = join(dir, "send.sh");
  writeFileSync(poster, `#!/bin/sh\necho x >> "${dir}/posts"\necho "SENT 9"\n`, { mode: 0o755 });
  const lead = join(dir, "to-macmini.sh");
  writeFileSync(lead, script.replaceAll("$DIR", dir), { mode: 0o755 });
  const h = hookHome(poster);
  writeFileSync(join(h.home, "briefs", "k1.md"), `# k1\n회장님 원문(${OWNER_MSG})\n인용 1571000000000000001\n`);
  const log = () => readFileSync(join(h.home, "state", "ready-reply.log"), "utf8");
  return { ...h, dir, log, env: { ...h.env, DORI_TO_MACMINI: lead } };
}

test("a lane not marked public hands its 결과.md and header order to the lead, posts nothing, passes no --order", () => {
  const h = handHome(`#!/bin/sh\n{ echo "$@"; cat; } > "$DIR/lead"\necho "DELIVERED lead file x 10 bytes"\n`);
  const run = Bun.spawnSync(["bun", h.tool, "k1"], { env: h.env });
  expect(run.exitCode).toBe(0);
  expect(existsSync(join(h.dir, "posts"))).toBe(false);
  expect(readFileSync(join(h.dir, "lead"), "utf8")).toBe(
    `리드 검수 대기 READY k1\njob: k1\n원 글번호: ${OWNER_MSG}\n결과 폴더(맥북): ${join(h.home, "results", "k1")}\n\n# r\n\n바뀐 것.\n\n`,
  );
  expect(h.log()).toContain(`HANDED k1 ${OWNER_MSG}:`);
});

test("a hand-off that fails is a recorded failure the lead is told about; --dry-run hands nothing", () => {
  const h = handHome(`#!/bin/sh\ncat > /dev/null\necho "NOT_DELIVERED lead file x"\nexit 2\n`);
  expect(Bun.spawnSync(["bun", h.tool, "k1", "--dry-run"], { env: h.env }).exitCode).toBe(0);
  expect(existsSync(join(h.home, "state", "ready-reply.log"))).toBe(false);
  expect(Bun.spawnSync(["bun", h.tool, "k1"], { env: h.env }).exitCode).toBe(1);
  expect(h.log()).toContain(`FAIL k1 ${OWNER_MSG}: not handed to the lead: NOT_DELIVERED lead file x (lead: not told,`);
  const missing = { ...h.env, DORI_TO_MACMINI: join(h.dir, "nope.sh") };
  expect(Bun.spawnSync(["bun", h.tool, "k1"], { env: missing }).exitCode).toBe(1);
  expect(h.log()).toContain(`not handed to the lead: cannot run ${join(h.dir, "nope.sh")}`);
});
