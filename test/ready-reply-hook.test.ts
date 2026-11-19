import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
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
  expect(Bun.spawnSync(["mkfifo", sent]).exitCode).toBe(0);
  const sender = join(dir, "send.sh");
  writeFileSync(sender, `#!/bin/sh\necho "$REPLY_TO $DISCORD_CHANNEL $1" > "${sent}"\necho "SENT 1"\n`, {
    mode: 0o755,
  });
  const { env, tool } = hookHome(sender);
  const reader = Bun.spawn(["cat", sent], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => reader.kill(), 8000);
  try {
    const parent = Bun.spawn(["bun", tool, "k1", "--detach"], { env, stdout: "ignore", stderr: "ignore" });
    expect(await parent.exited).toBe(0);
    const output = await new Response(reader.stdout).text();
    expect(await reader.exited).toBe(0);
    expect(output.trim()).toBe(`${OWNER_MSG} ${ROOM} 바뀐 것.`);
  } finally {
    clearTimeout(timer);
  }
}, 10000);

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

test("the reply says 끝냈어 only for the attachment the desk passed", () => {
  const dir = mkdtempSync(join(tmpdir(), "ready-passed-"));
  const sender = join(dir, "send.sh");
  const body = [
    "#!/bin/sh",
    '[ "$1" = "--supports" ] && { echo "SUPPORTED $2"; exit 0; }',
    `printf '%s\\n' "$@" > "${dir}/argv"`,
    'echo "SENT 3"',
    "",
  ].join("\n");
  writeFileSync(sender, body, { mode: 0o755 });
  const { home, env, tool } = hookHome(sender);
  const attachment = join(home, "results", "k1", "결과.txt");
  writeFileSync(attachment, "<p>통과본</p>");
  const round = join(dir, "review", "r1");
  const refuse = [
    "#!/bin/sh",
    `printf '%s\\n' "$@" > "${dir}/argv"`,
    'echo "REFUSED not passed" >&2',
    "exit 65",
    "",
  ].join("\n");
  writeFileSync(sender, refuse, { mode: 0o755 });
  writeFileSync(join(home, "results", "k1", "ready-delivery.json"), JSON.stringify({ round, attachment: "결과.txt" }));
  const refused = Bun.spawnSync(["bun", tool, "k1"], { env });
  expect(refused.exitCode).toBe(1);
  expect(refused.stderr.toString()).toContain("검수 기능");
  expect(readFileSync(join(home, "state", "ready-reply.log"), "utf8")).not.toContain("REPLIED");
  rmSync(join(home, "state", "ready-reply.log"));
  writeFileSync(sender, body, { mode: 0o755 });
  const passed = Bun.spawnSync(["bun", tool, "k1"], {
    env,
  });
  expect(passed.exitCode).toBe(0);
  expect(readFileSync(join(dir, "argv"), "utf8")).toBe(
    `--passed\n${round}\n끝냈어\n\n바뀐 것.\n${realpathSync(attachment)}\n`,
  );
});

test("lane delivery manifest binds the reviewed file and keeps the result paragraph", () => {
  const dir = mkdtempSync(join(tmpdir(), "ready-manifest-"));
  const sender = join(dir, "send.sh");
  writeFileSync(
    sender,
    `#!/bin/sh
[ "$1" = "--supports" ] && { echo "SUPPORTED $2"; exit 0; }
printf '%s\n' "$@" > "${dir}/argv"
echo "SENT 3"
`,
    { mode: 0o755 },
  );
  const { home, env, tool } = hookHome(sender);
  const results = join(home, "results", "k1");
  const attachment = join(results, "결과.txt");
  const round = join(dir, "round");
  writeFileSync(attachment, "reviewed");
  writeFileSync(join(results, "ready-delivery.json"), JSON.stringify({ round, attachment: "결과.txt" }));
  const run = Bun.spawnSync(["bun", tool, "k1"], { env });
  expect(run.exitCode).toBe(0);
  expect(readFileSync(join(dir, "argv"), "utf8")).toBe(
    `--passed\n${round}\n끝냈어\n\n바뀐 것.\n${realpathSync(attachment)}\n`,
  );
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
  expect(run.stderr.toString()).toContain("attachment outside lane results");
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
  expect(run.stderr.toString()).toContain("does not say 나가도 됩니다");
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
  expect(run.stderr.toString()).toContain("client name");
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
  expect(run.stderr.toString()).toContain("attachment type cannot be checked");
  expect(existsSync(join(dir, "posts"))).toBe(false);
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
