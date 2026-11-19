import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "examples", "sobaek", "dori-send-file.sh");
const sha = (body: string) => createHash("sha256").update(body).digest("hex");
const bashq = (path: string) => Bun.spawnSync(["bash", "-c", 'printf %q "$0"', path]).stdout.toString();

/**
 * A DORI_HOME with a token and a fake curl that never reaches Discord: it counts the posts in `<dir>/posts`, keeps the
 * payload in `<dir>/payload`, each upload's bytes in `<dir>/up<N>`, and answers like Discord with id 777.
 */
function rig() {
  const dir = mkdtempSync(join(tmpdir(), "send-passed-"));
  mkdirSync(join(dir, "home"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "home", "discord-token"), "not-a-real-token");
  const curl = String.raw`#!/bin/sh
echo x >> "$RIG/posts"
for a in "$@"; do
  case "$a" in
    payload_json=*) cat "$(printf '%s' "$a" | sed -e 's/^payload_json=<//' -e 's/;.*//')" > "$RIG/payload" ;;
    files*) cat "$(printf '%s' "$a" | sed -e 's/^[^@]*@//' -e 's/;.*//')" > "$RIG/up$(printf '%s' "$a" | sed -e 's/^files\[\([0-9]*\)\].*/\1/')" ;;
  esac
done
echo '{"id":"777"}'
`;
  writeFileSync(join(dir, "bin", "curl"), curl, { mode: 0o755 });
  return dir;
}

function piece(dir: string, name: string, body: string): string {
  const path = join(dir, "piece", name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

/** A desk round folder as review.py writes it: verdict first, then a `<path> <sha256>` line per file, then the model. */
function round(dir: string, name: string, verdict: string, files: Record<string, string>): string {
  const folder = join(dir, "review", name);
  mkdirSync(folder, { recursive: true });
  const listed = Object.entries(files).map(([path, body]) => `${path} ${sha(body)}\n`);
  writeFileSync(join(folder, "verdict.txt"), `${verdict}\n${listed.join("")}검수 모델: fake/model\n`);
  return folder;
}

function run(dir: string, args: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync(["bash", SCRIPT, ...args], {
    env: {
      ...process.env,
      PATH: `${join(dir, "bin")}:${process.env["PATH"]}`,
      DORI_HOME: join(dir, "home"),
      RIG: dir,
      ...env,
    },
  });
  const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : undefined);
  return {
    code: r.exitCode,
    out: r.stdout.toString(),
    err: r.stderr.toString(),
    posts: (read("posts") ?? "").split("\n").length - 1,
    payload: read("payload") ? JSON.parse(read("payload") as string) : undefined,
    upload: (n: number) => read(`up${n}`),
    log: read("home/state/send-without-desk-review.log"),
  };
}

test("a file name with a newline cannot forge an extra line in the unreviewed log", () => {
  const dir = rig();
  const shot = piece(dir, "줄바꿈\n파일.png", "화면");
  const r = run(dir, ["--send-without-desk-review", "화면입니다", shot]);
  expect([r.code, r.out.trim()]).toEqual([0, "SENT 777"]);
  expect([r.log?.split("\n").length, r.log?.endsWith(` channel=1571013138764140544 reply=- ${bashq(shot)}\n`)]).toEqual(
    [2, true],
  );
});

test("the two flags together, or --passed with no folder, stop before anything is posted", () => {
  const dir = rig();
  const card = piece(dir, "01.png", "그림");
  const folder = round(dir, "r2", "나가도 됩니다", { [card]: "그림" });
  const both = run(dir, ["--passed", folder, "--send-without-desk-review", "글", card]);
  expect([both.code, both.posts, both.err.trim()]).toEqual([
    64,
    0,
    "REFUSED --passed and --send-without-desk-review exclude each other",
  ]);
  const none = run(dir, ["--passed"]);
  expect([none.code, none.posts, none.err.trim()]).toEqual([64, 0, "REFUSED --passed needs one review round folder"]);
});

test("a successful file send cannot be repeated for the same order and bytes", () => {
  const dir = rig();
  const card = piece(dir, "card.png", "그림");
  const folder = round(dir, "r1", "나가도 됩니다", { [card]: "그림" });
  const first = run(dir, ["--passed", folder, "결과", card], { REPLY_TO: "12345" });
  const second = run(dir, ["--passed", folder, "결과", card], { REPLY_TO: "12345" });
  expect([first.code, second.code, second.posts]).toEqual([0, 65, 1]);
  expect(second.err).toContain("already sent");
});

test("an unreviewed attachment can be resent with corrected text", () => {
  const dir = rig();
  const card = piece(dir, "screen.png", "화면");
  const first = run(dir, ["--send-without-desk-review", "처음", card], { REPLY_TO: "12345" });
  const second = run(dir, ["--send-without-desk-review", "수정", card], { REPLY_TO: "12345" });
  expect([first.code, second.code, second.posts]).toEqual([0, 0, 2]);
  expect(second.payload.content).toContain("수정");
});

test("a failed send is not recorded and can be retried", () => {
  const dir = rig();
  const card = piece(dir, "card.png", "그림");
  const folder = round(dir, "r1", "나가도 됩니다", { [card]: "그림" });
  writeFileSync(join(dir, "bin", "curl"), '#!/bin/sh\necho \'{"code":500,"message":"failed"}\'\n', {
    mode: 0o755,
  });
  const failed = run(dir, ["--passed", folder, "결과", card], { REPLY_TO: "12345" });
  writeFileSync(join(dir, "bin", "curl"), '#!/bin/sh\necho \'{"id":"777"}\'\n', { mode: 0o755 });
  const retry = run(dir, ["--passed", folder, "결과", card], { REPLY_TO: "12345" });
  expect([failed.code, retry.code, retry.out.trim()]).toEqual([1, 0, "SENT 777"]);
});

test("simultaneous sends of the same order and file post only once", async () => {
  const dir = rig();
  const card = piece(dir, "card.png", "그림");
  const folder = round(dir, "r1", "나가도 됩니다", { [card]: "그림" });
  const fifo = join(dir, "gate");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  writeFileSync(
    join(dir, "bin", "curl"),
    `#!/bin/sh\necho x >> "$RIG/posts"\nread x < "$RIG/gate"\necho '{"id":"777"}'\n`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${join(dir, "bin")}:${process.env["PATH"]}`,
    DORI_HOME: join(dir, "home"),
    RIG: dir,
    REPLY_TO: "12345",
  };
  const args = ["bash", SCRIPT, "--passed", folder, "결과", card];
  const one = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
  const two = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
  const gate = Bun.spawn(["sh", "-c", 'printf "go\\n" > "$1"', "sh", fifo], { env });
  const timer = setTimeout(() => {
    one.kill();
    two.kill();
    gate.kill();
  }, 10000);
  try {
    const codes = await Promise.all([one.exited, two.exited, gate.exited]);
    expect(codes.slice(0, 2).sort()).toEqual([0, 65]);
    expect(readFileSync(join(dir, "posts"), "utf8")).toBe("x\n");
  } finally {
    clearTimeout(timer);
  }
}, 15000);
