import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstParagraph, ownerMessages, planReply } from "../src/ready-reply.ts";

const ROOM = "1571013138764140544";
const OWNER_MSG = "1571675313379737672";
const STANDING = "1571465000311070781";

function lane(result?: string, pictures: readonly string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "ready-reply-"));
  const log = join(root, "inbound.log");
  writeFileSync(
    log,
    [
      `INBOUND discord ${ROOM} ${OWNER_MSG} from=owner ref=- "박실로 …"`,
      `INBOUND_ATTACHMENT discord ${ROOM} ${OWNER_MSG} {"filename":"a.jpg"}`,
      `INBOUND discord ${ROOM} ${STANDING} from=owner ref=- "파쿠리 …"`,
      `INBOUND discord ${ROOM} 1571000000000000001 from=someone ref=- "x"`,
    ].join("\n"),
  );
  const dir = join(root, "results");
  mkdirSync(dir);
  if (result !== undefined) writeFileSync(join(dir, "결과.md"), result);
  for (const p of pictures) writeFileSync(join(dir, p), "png");
  return { dir, owners: ownerMessages(log) };
}

const brief = (top: string) => `# 레인\n\n${top}\n\n## STOP WHEN\n원문 ${STANDING} 파쿠리 네 칸.\n`;
const RESULT = `# 결과\n\n회장님 원문(${OWNER_MSG}): "…"\n\n| 칸 | 경로 |\n|---|---|\n\n쇼츠 자막을 박실로식으로 바꿨다.\n둘째 줄.\n\n다음 단락.\n`;

describe("planReply", () => {
  test("an owner message in the brief gets the first prose paragraph and the phone-width picture", () => {
    const { dir, owners } = lane(RESULT, ["비교.png", "비교_390.png"]);
    expect(planReply({ brief: brief(`회장님 원글 ${OWNER_MSG}`), resultsDir: dir, owners })).toEqual({
      post: true,
      owner: { id: OWNER_MSG, channel: ROOM },
      text: "쇼츠 자막을 박실로식으로 바꿨다.\n둘째 줄.",
      image: join(dir, "비교_390.png"),
    });
  });

  test("비교.png is the fallback picture, and no picture still posts the text", () => {
    const withWide = lane(RESULT, ["비교.png"]);
    const plain = lane(RESULT);
    const b = brief(OWNER_MSG);
    expect(planReply({ brief: b, resultsDir: withWide.dir, owners: withWide.owners })).toMatchObject({
      image: join(withWide.dir, "비교.png"),
    });
    const noPicture = planReply({ brief: b, resultsDir: plain.dir, owners: plain.owners });
    expect(noPicture.post && noPicture.image).toBeUndefined();
  });

  test("the standing order under STOP WHEN and ids nobody owner-posted are not a lane's own message", () => {
    const { dir, owners } = lane(RESULT);
    const plan = planReply({ brief: brief(`채널 ${ROOM}, 남의 글 1571000000000000001`), resultsDir: dir, owners });
    expect(plan).toEqual({ post: false, why: "the brief names no owner message" });
  });

  test("a lane without 결과.md stays inbox-only", () => {
    const { dir, owners } = lane();
    expect(planReply({ brief: brief(OWNER_MSG), resultsDir: dir, owners }).post).toBe(false);
  });

  test("a case lane stays inbox-only: case folders in the brief or result, or a resident number", () => {
    const { dir, owners } = lane(RESULT);
    const fromBrief = planReply({
      brief: brief(`${OWNER_MSG} ~/sanjai-agent/cases/2026/x.pdf`),
      resultsDir: dir,
      owners,
    });
    expect(fromBrief).toEqual({ post: false, why: "case lane: brief points into case folders" });
    const worktree = brief(`${OWNER_MSG} ~/sanjai-agent-wt/a-1116/library/sources/private/y`);
    expect(planReply({ brief: worktree, resultsDir: dir, owners }).post).toBe(false);
    const rrn = lane(`${RESULT}\n주민번호 800101-1234567\n`);
    expect(planReply({ brief: brief(OWNER_MSG), resultsDir: rrn.dir, owners: rrn.owners })).toEqual({
      post: false,
      why: "case lane: 결과.md holds a resident registration number",
    });
  });
});

test("firstParagraph prefers the summary section, skips headings, tables, lists, quotes and meta lines, and cuts", () => {
  expect(firstParagraph("# h\n\n- a\n\n> q\n\n1. x\n\n본문")).toBe("본문");
  expect(firstParagraph("# t\n\n폴더는 /r/k/ 이다.\n\n앞말.\n\n## 한 줄\n\n핵심.\n\n## 다음\n\n뒷말.", ["/r/k"])).toBe(
    "핵심.",
  );
  expect(firstParagraph("# t\n\n폴더는 /r/k/ 이다.\n\n진짜 첫 단락.", ["/r/k"])).toBe("진짜 첫 단락.");
  expect(firstParagraph("# only\n\n| a |")).toBeUndefined();
  const long = firstParagraph("가".repeat(3000)) ?? "";
  expect(long.length).toBeLessThanOrEqual(2000);
  expect(long.endsWith("(결과.md에 이어짐)")).toBe(true);
});

test("the onReady hook argv (KEY --detach) returns at once and the detached copy posts the reply", async () => {
  const home = mkdtempSync(join(tmpdir(), "ready-hook-"));
  for (const d of ["briefs", "state", "results/k1"]) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, "briefs", "k1.md"), `# k1 (회장님 ${OWNER_MSG})\n\n## STOP WHEN\n`);
  writeFileSync(join(home, "results", "k1", "결과.md"), "# r\n\n바뀐 것.\n");
  writeFileSync(join(home, "state", "inbound.log"), `INBOUND discord ${ROOM} ${OWNER_MSG} from=owner ref=- "x"\n`);
  const sent = join(home, "sent.txt");
  const sender = join(home, "send.sh");
  writeFileSync(sender, `#!/bin/sh\necho "$REPLY_TO $DISCORD_CHANNEL $1" > "${sent}"\necho "SENT 1"\n`, {
    mode: 0o755,
  });
  const tool = join(import.meta.dir, "..", "tools", "ready_reply.ts");
  const env = { ...process.env, DORI_HOME: home, DORI_SEND_FILE: sender };
  const parent = Bun.spawnSync(["bun", tool, "k1", "--detach"], { env });
  expect(parent.exitCode).toBe(0);
  for (let i = 0; i < 100 && !existsSync(sent); i++) await Bun.sleep(50);
  expect(readFileSync(sent, "utf8").trim()).toBe(`${OWNER_MSG} ${ROOM} 바뀐 것.`);
});
