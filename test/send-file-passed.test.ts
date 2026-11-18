import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

test("files that are the passed copy go up byte for byte, the text unmarked, as a reply when asked", () => {
  const dir = rig();
  const card = piece(dir, "card 01.png", "그림 바이트");
  const caption = piece(dir, "캡션.txt", "캡션 글");
  const folder = round(dir, "r3", "나가도 됩니다", { [card]: "그림 바이트", [caption]: "캡션 글" });
  const r = run(dir, ["--passed", folder, "결과입니다", card, caption], { REPLY_TO: "1572100000000000001" });
  expect([r.code, r.out.trim(), r.posts]).toEqual([0, "SENT 777", 1]);
  expect([r.upload(0), r.upload(1)]).toEqual(["그림 바이트", "캡션 글"]);
  expect(r.payload.content).toBe("결과입니다");
  expect(r.payload.message_reference.message_id).toBe("1572100000000000001");
  expect(r.log).toBeUndefined();
});

test("a file changed after the pass is refused by name, and the passed file beside it is not sent either", () => {
  const dir = rig();
  const kept = piece(dir, "01.png", "그림");
  const edited = piece(dir, "캡션.txt", "통과한 캡션");
  const folder = round(dir, "r9", "나가도 됩니다", { [kept]: "그림", [edited]: "통과한 캡션" });
  writeFileSync(edited, "통과 뒤에 고친 캡션");
  const r = run(dir, ["--passed", folder, "결과입니다", kept, edited]);
  expect(r.code).toBe(65);
  expect(r.err.trim().split("\n")).toEqual([
    `REFUSED ${edited} is not the passed copy: its sha256 is not listed in ${folder}/verdict.txt`,
  ]);
  expect([r.out, r.posts, r.payload]).toEqual(["", 0, undefined]);
});

test("a block verdict refuses the files even when their hashes are listed", () => {
  const dir = rig();
  const card = piece(dir, "01.png", "그림");
  const folder = round(dir, "r10", "아직 안 됩니다: 6장 표가 겹칩니다", { [card]: "그림" });
  const r = run(dir, ["--passed", folder, "결과입니다", card]);
  expect(r.code).toBe(65);
  expect(r.err).toContain(
    `REFUSED ${card} is not the passed copy: ${folder}/verdict.txt does not say 나가도 됩니다 on its first line`,
  );
  expect([r.posts, r.payload]).toEqual([0, undefined]);
});

test("files announced before any verdict are refused: a round folder without verdict.txt, or no folder named", () => {
  const dir = rig();
  const card = piece(dir, "01.png", "그림");
  const empty = join(dir, "review", "r1");
  mkdirSync(empty, { recursive: true });
  const early = run(dir, ["--passed", empty, "끝냈습니다", card]);
  expect([early.code, early.posts]).toEqual([65, 0]);
  expect(early.err).toContain(`REFUSED ${card} is not the passed copy: ${empty}/verdict.txt cannot be read`);
  const bare = run(dir, ["끝냈습니다", card]);
  expect([bare.code, bare.posts]).toEqual([65, 0]);
  expect(bare.err).toContain(`REFUSED ${card} is not the passed copy: no --passed review round folder was named`);
});

test("a result with no files is posted as before, with or without the flags, and is not marked or logged", () => {
  const dir = rig();
  const plain = run(dir, ["글만 보냅니다"]);
  expect([plain.code, plain.out.trim(), plain.posts, plain.payload.content]).toEqual([
    0,
    "SENT 777",
    1,
    "글만 보냅니다",
  ]);
  const flagged = run(dir, ["--send-without-desk-review", "글만 보냅니다"]);
  expect([flagged.code, flagged.payload.content, flagged.log]).toEqual([0, "글만 보냅니다", undefined]);
});

test("the explicit unreviewed path sends the file, says so in the posted text and logs it with the message id", () => {
  const dir = rig();
  const shot = piece(dir, "캡처 1.png", "화면");
  const r = run(dir, ["--send-without-desk-review", "달라고 하신 화면입니다", shot], {
    REPLY_TO: "1572100000000000002",
  });
  expect([r.code, r.out.trim(), r.upload(0)]).toEqual([0, "SENT 777", "화면"]);
  expect(r.payload.content).toBe("달라고 하신 화면입니다\n\n(첨부한 파일은 교열 데스크를 거치지 않았습니다)");
  expect(r.log?.endsWith(` channel=1571013138764140544 reply=1572100000000000002 ${bashq(shot)}\n`)).toBe(true);
  expect(r.log?.split("\n")).toHaveLength(2);
});

test("a later round that blocked the same bytes refuses the earlier pass; the newest passing round still goes", () => {
  const dir = rig();
  const card = piece(dir, "01.png", "그림");
  const r1 = round(dir, "r1", "나가도 됩니다", { [card]: "그림" });
  const r2 = round(dir, "r2", "아직 안 됩니다: 6장 표가 겹칩니다", { [card]: "그림" });
  const stale = run(dir, ["--passed", r1, "결과입니다", card]);
  expect(stale.code).toBe(65);
  expect(stale.err.trim().split("\n")).toEqual([
    `REFUSED ${card} is not the passed copy: 더 최신 교열 라운드 r2 가 이 판을 나가지 못하게 했습니다(${r2}/verdict.txt)`,
  ]);
  expect([stale.out, stale.posts, stale.payload]).toEqual(["", 0, undefined]);
  const r3 = round(dir, "r3", "나가도 됩니다", { [card]: "그림" });
  const fresh = run(dir, ["--passed", r3, "결과입니다", card]);
  expect([fresh.code, fresh.out.trim(), fresh.posts]).toEqual([0, "SENT 777", 1]);
  const behind = run(dir, ["--passed", r1, "결과입니다", card]);
  expect(behind.code).toBe(65);
  expect(behind.err).toContain("더 최신 교열 라운드 r3 의 판정이 있으니 그 라운드를 --passed 로 지정해야 합니다");
});

test("a file the model did not read is refused by its hash, sent as the 나갈판 copy from outside the piece folder", () => {
  const dir = rig();
  const card = piece(dir, "글/카드.html", "글 바이트");
  const attach = piece(dir, "글/첨부 1.pdf", "첨부 바이트");
  const folder = join(dir, "review", "r1");
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "verdict.txt"),
    `나가도 됩니다\n${card} ${sha("글 바이트")}\n${attach} ${sha("첨부 바이트")}\n읽지 않고 함께 나가는 파일(검수 모델이 내용을 읽지 못함): 첨부 1.pdf\n사이트 자원(복사 안 함, 발행 사이트에서 불러옴): https://lawsobaek.com/a.css\n검수 모델: fake/model\n`,
  );
  const deskCard = join(folder, "나갈판", "카드.html");
  const deskAttach = join(folder, "나갈판", "첨부 1.pdf");
  mkdirSync(join(folder, "나갈판"), { recursive: true });
  copyFileSync(card, deskCard);
  copyFileSync(attach, deskAttach);
  const refused = run(dir, ["--passed", folder, "결과입니다", deskAttach]);
  expect([refused.code, refused.posts, refused.payload]).toEqual([65, 0, undefined]);
  expect(refused.err.trim()).toBe(
    `REFUSED ${deskAttach} is not the passed copy: 검수 모델이 읽지 않은 파일이라 --send-without-desk-review 로만 보낼 수 있습니다`,
  );
  const ok = run(dir, ["--passed", folder, "결과입니다", deskCard]);
  expect([ok.code, ok.out.trim(), ok.posts, ok.upload(0)]).toEqual([0, "SENT 777", 1, "글 바이트"]);
  const unreviewed = run(dir, ["--send-without-desk-review", "첨부입니다", deskAttach]);
  expect([unreviewed.code, unreviewed.posts, unreviewed.upload(0)]).toEqual([0, 2, "첨부 바이트"]);
});

test("a newer round about a different deliverable does not block; one about the same deliverable still does", () => {
  const dir = rig();
  // card52h shape: r3 passed the card, png3 later only 01.png; hearing shape: html4 passed, r10 only merged.md.
  const card = piece(dir, "카드문구.txt", "카드 문구");
  const render = piece(dir, "01.png", "렌더");
  const r3 = round(dir, "r3", "나가도 됩니다", { [card]: "카드 문구" });
  round(dir, "png3", "아직 안 됩니다: 표가 겹칩니다", { [render]: "렌더" });
  const ok = run(dir, ["--passed", r3, "결과입니다", card]);
  expect([ok.code, ok.out.trim(), ok.posts]).toEqual([0, "SENT 777", 1]);
  const hearing = piece(dir, "hearing.html", "청문회 글");
  const merged = piece(dir, "merged.md", "합친 글");
  const html4 = round(dir, "html4", "나가도 됩니다", { [hearing]: "청문회 글" });
  round(dir, "r10", "아직 안 됩니다: 줄이 길다", { [merged]: "합친 글" });
  const ok2 = run(dir, ["--passed", html4, "결과입니다", hearing]);
  expect([ok2.code, ok2.out.trim(), ok2.posts]).toEqual([0, "SENT 777", 2]);
  round(dir, "r5", "아직 안 됩니다: 문구 이상", { [card]: "카드 문구" });
  const blocked = run(dir, ["--passed", r3, "결과입니다", card]);
  expect(blocked.code).toBe(65);
  expect(blocked.err).toContain("더 최신 교열 라운드 r5 가 이 판을 나가지 못하게 했습니다");
});

test("an unread path matches only on a path boundary, so a.pdf does not swallow data.pdf", () => {
  const dir = rig();
  const data = piece(dir, "첨부/data.pdf", "자료");
  const folder = join(dir, "review", "r1");
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "verdict.txt"),
    `나가도 됩니다\n${data} ${sha("자료")}\n읽지 않고 함께 나가는 파일(검수 모델이 내용을 읽지 못함): a.pdf\n검수 모델: fake/model\n`,
  );
  const r = run(dir, ["--passed", folder, "결과입니다", data]);
  expect([r.code, r.out.trim(), r.posts]).toEqual([0, "SENT 777", 1]);
});

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
