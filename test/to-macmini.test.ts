import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "examples", "sobaek", "to-macmini.sh");

/** Runs to-macmini.sh with a fake ssh that keeps what it was sent under `<dir>/sent` (or fails). */
function run(args: string[], sshWorks = true) {
  const dir = mkdtempSync(join(tmpdir(), "to-macmini-"));
  const ssh = sshWorks
    ? `#!/bin/sh\ncat > "${dir}/sent"\nwc -c < "${dir}/sent"\n`
    : "#!/bin/sh\ncat >/dev/null\nexit 255\n";
  writeFileSync(join(dir, "ssh"), ssh, { mode: 0o755 });
  const env = { ...process.env, PATH: `${dir}:${process.env["PATH"]}`, DORI_HOME: dir };
  const r = Bun.spawnSync(["bash", SCRIPT, ...args], { env, stdin: Buffer.from("본문") });
  const log = readdirSync(dir).includes("state") ? readFileSync(join(dir, "state", "to-macmini.log"), "utf8") : "";
  const sent = readdirSync(dir).includes("sent") ? readFileSync(join(dir, "sent"), "utf8") : "";
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString(), log, sent };
}

test("--order puts the order id under the title and on the to-macmini.log line; without it the report is as before", () => {
  const order = run(["--order", "1572108521254944830", "재해경위서 결과"]);
  expect(order.code).toBe(0);
  expect(order.out).toStartWith("DELIVERED lead file ~/sobaegi-lead/inbox/ompdori/");
  expect(order.sent).toBe("# 재해경위서 결과\n\n지시: 1572108521254944830\n\n본문\n");
  expect(order.log).toMatch(/^\S+Z order=1572108521254944830 DELIVERED ~\/sobaegi-lead\/inbox\/ompdori\/\S+\.md\n$/);
  const plain = run(["제목"]);
  expect([plain.code, plain.sent]).toEqual([0, "# 제목\n\n본문\n"]);
  expect(plain.log).toMatch(/ order=- DELIVERED /);
  const lost = run(["--order", "1572108521254944830", "제목"], false);
  expect(lost.code).toBe(2);
  expect(lost.log).toMatch(/ order=1572108521254944830 NOT_DELIVERED /);
});

test("--order takes only a Discord message id of 16 to 22 digits and sends nothing for anything else", () => {
  for (const bad of [
    "abc",
    "1",
    "12",
    "123456789012345",
    "12345678901234567890123",
    "0123456789012345678",
    "1572108521254944830x",
    "",
  ]) {
    const refused = run(["--order", bad, "제목"]);
    expect([bad, refused.code, refused.sent, refused.log]).toEqual([bad, 64, "", ""]);
    expect(refused.err).toContain("--order must be a Discord message id (16 to 22 digits)");
  }
  for (const good of ["1234567890123456", "1572108521254944830", "1234567890123456789012"]) {
    const sent = run(["--order", good, "제목"]);
    expect([good, sent.code]).toEqual([good, 0]);
    expect(sent.log).toMatch(new RegExp(` order=${good} DELIVERED `));
  }
});
