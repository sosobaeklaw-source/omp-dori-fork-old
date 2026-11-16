import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstParagraph, loadCaseNames, ownerMessages, planReply } from "../src/ready-reply.ts";

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
/** A made-up client-name list (no real names). */
const NAMES = ["가나다", "라마바"];
/** planReply on a test lane; `caseNames` is an explicit argument (the fail-closed test passes undefined). */
const plan = (
  b: string,
  l: { dir: string; owners: Map<string, string> },
  ...names: [readonly string[] | undefined] | []
) => planReply({ brief: b, resultsDir: l.dir, owners: l.owners, caseNames: names.length ? names[0] : NAMES });

describe("planReply", () => {
  test("an owner message in the brief gets the first prose paragraph and the phone-width picture", () => {
    const l = lane(RESULT, ["비교.png", "비교_390.png"]);
    expect(plan(brief(`회장님 원글 ${OWNER_MSG}`), l)).toEqual({
      post: true,
      owner: { id: OWNER_MSG, channel: ROOM },
      text: "쇼츠 자막을 박실로식으로 바꿨다.\n둘째 줄.",
      image: join(l.dir, "비교_390.png"),
    });
  });

  test("비교.png is the fallback picture, and no picture still posts the text", () => {
    const withWide = lane(RESULT, ["비교.png"]);
    expect(plan(brief(OWNER_MSG), withWide)).toMatchObject({ image: join(withWide.dir, "비교.png") });
    const noPicture = plan(brief(OWNER_MSG), lane(RESULT));
    expect(noPicture.post && noPicture.image).toBeUndefined();
  });

  test("the standing order under STOP WHEN and ids nobody owner-posted are not a lane's own message", () => {
    expect(plan(brief(`채널 ${ROOM}, 남의 글 1571000000000000001`), lane(RESULT))).toEqual({
      post: false,
      why: "the brief names no owner message",
    });
  });

  test("a lane without 결과.md stays inbox-only", () => {
    expect(plan(brief(OWNER_MSG), lane()).post).toBe(false);
  });

  test("a case lane stays inbox-only: case folders, registration numbers or client names anywhere in the folder", () => {
    const l = lane(RESULT);
    expect(plan(brief(`${OWNER_MSG} ~/sanjai-agent/cases/2026/x.pdf`), l)).toEqual({
      post: false,
      why: "case lane: brief points into case folders",
    });
    expect(plan(brief(`${OWNER_MSG} ~/sanjai-agent-wt/a-1116/library/sources/private/y`), l).post).toBe(false);
    for (const number of ["800101-1234567", "8001015234567"]) {
      expect(plan(brief(OWNER_MSG), lane(`${RESULT}\n번호 ${number}\n`))).toEqual({
        post: false,
        why: "case lane: 결과.md holds a registration number",
      });
    }
    const nameElsewhere = lane(RESULT);
    mkdirSync(join(nameElsewhere.dir, "work"));
    writeFileSync(join(nameElsewhere.dir, "work", "facts.md"), "진술: 가나다 씨가 말했다.");
    expect(plan(brief(OWNER_MSG), nameElsewhere)).toEqual({
      post: false,
      why: `case lane: ${join("work", "facts.md")} holds a client name`,
    });
    // A name counts as a word of its own (bare, or with a particle or title glued on), not embedded in a longer word.
    expect(plan(brief(OWNER_MSG), lane(`${RESULT}\n아가나다 표, 가나다라마 칸.\n`)).post).toBe(true);
    for (const named of [
      "의뢰인 라마바에게 물었다.",
      "성명: 가나다",
      "라마바님께 전화",
      "세 가나다 본 것",
      "라마바 요건",
    ]) {
      expect(plan(brief(OWNER_MSG), lane(`${RESULT}\n${named}\n`)).post).toBe(false);
    }
    expect(plan(brief(OWNER_MSG), lane(`${RESULT}\n시각 1794536700000\n`)).post).toBe(true);
  });

  test("a client name standing bare, in a file name or in any file, keeps the lane inbox-only", () => {
    // The reviewer's case: the office names files YYMMDD_실명_서류명 and writes facts with the bare name.
    const l = lane("# 결과\n\n## 한 줄\n\n재해경위서를 직원 원본 틀에 넣었다.\n", ["비교.png"]);
    writeFileSync(join(l.dir, "261113_가나다_재해경위서.md"), "");
    expect(plan(brief(OWNER_MSG), l)).toEqual({
      post: false,
      why: "case lane: 261113_가나다_재해경위서.md holds a client name",
    });
    const facts = lane(RESULT);
    writeFileSync(join(facts.dir, "사실표.md"), "가나다는 2019년 입사했다. 가나다의 주소는 서울.");
    expect(plan(brief(OWNER_MSG), facts)).toEqual({ post: false, why: "case lane: 사실표.md holds a client name" });
    expect(plan(brief(OWNER_MSG), lane(`# 결과\n\n라마바 재해경위서를 직원 원본 틀에 넣었다.\n`)).post).toBe(false);
  });

  test("a document the check cannot read as text keeps the lane inbox-only", () => {
    for (const doc of ["261113_재해경위서.hwpx", "a.hwp", "b.pdf", "c.docx", "d.xlsx"]) {
      const l = lane(RESULT);
      writeFileSync(join(l.dir, doc), "x");
      expect(plan(brief(OWNER_MSG), l)).toEqual({
        post: false,
        why: `case lane: ${doc} is a document the check cannot read`,
      });
    }
  });

  test("without a readable client-name list no lane posts (fail closed)", () => {
    expect(plan(brief(OWNER_MSG), lane(RESULT), undefined)).toEqual({
      post: false,
      why: "case lane: no readable client-name list, so the lane cannot be judged",
    });
    expect(loadCaseNames(join(tmpdir(), "no-such-names.json"))).toBeUndefined();
    const file = join(mkdtempSync(join(tmpdir(), "names-")), "n.json");
    writeFileSync(file, "{not json");
    expect(loadCaseNames(file)).toBeUndefined();
    writeFileSync(file, JSON.stringify(["가나다", "x"]));
    expect(loadCaseNames(file)).toEqual(["가나다"]);
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

/** A DORI_HOME with one lane k1 that is ready to reply, and the env to run the hook against it (no live home leaks in). */
function hookHome(sender: string) {
  const home = mkdtempSync(join(tmpdir(), "ready-hook-"));
  for (const d of ["briefs", "state", "results/k1"]) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, "briefs", "k1.md"), `# k1 (회장님 ${OWNER_MSG})\n\n## STOP WHEN\n`);
  writeFileSync(join(home, "results", "k1", "결과.md"), "# r\n\n바뀐 것.\n");
  writeFileSync(join(home, "state", "inbound.log"), `INBOUND discord ${ROOM} ${OWNER_MSG} from=owner ref=- "x"\n`);
  writeFileSync(join(home, "case-names.json"), JSON.stringify(NAMES));
  const { DORI_STATE_DIR: _s, DORI_CONFIG: _c, ...rest } = process.env;
  const env = { ...rest, DORI_HOME: home, DORI_SEND_FILE: sender, DORI_CASE_NAMES: join(home, "case-names.json") };
  return { home, env, tool: join(import.meta.dir, "..", "tools", "ready_reply.ts") };
}

test("the onReady hook argv (KEY --detach) returns at once and the detached copy posts the reply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ready-sender-"));
  const sent = join(dir, "sent.txt");
  const sender = join(dir, "send.sh");
  writeFileSync(sender, `#!/bin/sh\necho "$REPLY_TO $DISCORD_CHANNEL $1" > "${sent}"\necho "SENT 1"\n`, {
    mode: 0o755,
  });
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
