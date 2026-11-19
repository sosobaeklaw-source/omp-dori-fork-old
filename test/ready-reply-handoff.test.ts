import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
