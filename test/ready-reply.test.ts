import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstParagraph, loadCaseNames, ocrPicture, ownerMessages, planReply } from "../src/ready-reply.ts";

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
  for (const p of pictures) writeFileSync(join(dir, p), PNG);
  return { dir, owners: ownerMessages(log) };
}

const brief = (top: string) => `# 레인\n\npublic: true\n\n${top}\n\n## STOP WHEN\n원문 ${STANDING} 파쿠리 네 칸.\n`;
const RESULT = `# 결과\n\n회장님 원문(${OWNER_MSG}): "…"\n\n| 칸 | 경로 |\n|---|---|\n\n쇼츠 자막을 박실로식으로 바꿨다.\n둘째 줄.\n\n다음 단락.\n`;
/** A made-up client-name list (no real names). */
const NAMES = ["가나다", "라마바"];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** planReply on a test lane; `caseNames` is an explicit argument (the fail-closed test passes undefined). */
const plan = (
  b: string,
  l: { dir: string; owners: Map<string, string> },
  names: readonly string[] | undefined = NAMES,
  read: (path: string) => string | undefined = () => "",
) => planReply({ brief: b, resultsDir: l.dir, owners: l.owners, caseNames: names, readPicture: read });

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

  test("a brief not marked public: true stays inbox-only, whatever the lane holds", () => {
    const l = lane(RESULT, ["비교.png"]);
    const unmarked = `# 레인\n\n회장님 원글 ${OWNER_MSG}\n\n## STOP WHEN\npublic: true\n`;
    for (const b of [unmarked, unmarked.replace("# 레인", "# 레인\npublic: false"), `# public: true ${OWNER_MSG}\n`]) {
      expect(plan(b, l)).toEqual({ post: false, why: "the brief is not marked public: true" });
    }
  });

  test("public: true in the middle of the brief, not its header, does not mark the lane public", () => {
    const l = lane(RESULT, ["비교.png"]);
    const body = [
      "# 레인",
      "",
      `회장님 원글 ${OWNER_MSG}`,
      "",
      "## 목표",
      "사건 일.",
      "",
      "```",
      "public: true",
      "```",
    ];
    expect(plan(`${body.join("\n")}\n\npublic: true\n\n## STOP WHEN\n`, l)).toEqual({
      post: false,
      why: "the brief is not marked public: true",
    });
    expect(plan(`public: true\n원글: ${OWNER_MSG}\n\n${body.slice(0, 6).join("\n")}\n`, l).post).toBe(true);
  });

  test("a public lane whose reply text or picture holds a name or number stays inbox-only", () => {
    const l = lane(RESULT, ["비교.png"]);
    // What OCR makes of a form cut: the label glued to the name, or the name spaced out.
    for (const ocr of ["성명가나다 사업장 소백건설", "재해자 라 마 바", "800101-1 234567"]) {
      expect(plan(brief(OWNER_MSG), l, NAMES, () => ocr).post).toBe(false);
    }
    expect(plan(brief(OWNER_MSG), l, NAMES, () => undefined).post).toBe(false);
    expect(plan(brief(OWNER_MSG), lane("# r\n\n의뢰인가나다 재해경위서를 고쳤다.\n")).post).toBe(false);
    expect(plan(brief(OWNER_MSG), lane("# r\n\n~/sanjai-agent/cases/2026/x.pdf 를 읽었다.\n")).post).toBe(false);
    expect(plan(brief(OWNER_MSG), l, NAMES, () => "자막 전후 비교").post).toBe(true);
  });

  test("a registration number next to another number still blocks, in the text or the picture", () => {
    for (const body of ["2026 800101-1234567 이다.", "800101-1234567 2026년 접수"]) {
      expect(plan(brief(OWNER_MSG), lane(`# r\n\n${body}\n`)).post).toBe(false);
    }
    const l = lane(RESULT, ["비교.png"]);
    for (const ocr of ["접수번호 2026\n800101-1234567\n성명", "생년월일 1980.01.01 800101-1234567"]) {
      expect(plan(brief(OWNER_MSG), l, NAMES, () => ocr).post).toBe(false);
    }
  });

  test("a registration number split by any one non-digit still blocks", () => {
    const l = lane(RESULT, ["비교.png"]);
    for (const ocr of ["800101.1234567", "800101/1234567", "800101_1234567", "800101~1234567", "800101 . 1234567"]) {
      expect(plan(brief(OWNER_MSG), l, NAMES, () => ocr).post).toBe(false);
    }
  });

  test("without a readable client-name list no lane posts (fail closed)", () => {
    const l = lane(RESULT);
    const noList = { brief: brief(OWNER_MSG), resultsDir: l.dir, owners: l.owners, readPicture: () => "" };
    expect(planReply({ ...noList, caseNames: undefined })).toEqual({
      post: false,
      why: "no readable client-name list, so the reply cannot be checked",
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
  expect(firstParagraph("# r\n\n```\ncode1\n\ncode2\n```\n\n본문.")).toBe("본문.");
  expect(firstParagraph("# r\n\n<!-- a\n\nb -->\n\n본문.")).toBe("본문.");
  expect(firstParagraph("# t\n\n폴더는 /r/k/ 이다.\n\n앞말.\n\n## 한 줄\n\n핵심.\n\n## 다음\n\n뒷말.", ["/r/k"])).toBe(
    "핵심.",
  );
  expect(firstParagraph("# t\n\n폴더는 /r/k/ 이다.\n\n진짜 첫 단락.", ["/r/k"])).toBe("진짜 첫 단락.");
  expect(firstParagraph("# only\n\n| a |")).toBeUndefined();
  const long = firstParagraph("가".repeat(3000)) ?? "";
  expect(long.length).toBeLessThanOrEqual(2000);
  expect(long.endsWith("(결과.md에 이어짐)")).toBe(true);
});

test("a summary heading inside a code fence never picks the reply", () => {
  expect(firstParagraph("# r\n\n```\n## 요약\n\nsecret code line\n```\n\n바뀐 것.")).toBe("바뀐 것.");
  expect(firstParagraph("# r\n\n<!--\n## 결론\n\n숨긴 말\n-->\n\n바뀐 것.")).toBe("바뀐 것.");
});

test("OCR without the Korean data counts as unreadable, so the picture blocks", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-nokor-"));
  const fake = join(dir, "tesseract");
  // What tesseract does with `kor` missing: exit 0, English-only text, and this line on stderr.
  const stderr = "Error opening data file kor.traineddata\\nFailed loading language 'kor'";
  writeFileSync(fake, `#!/bin/sh\necho "AVY 7ELTCt hello"\nprintf '${stderr}\\n' >&2\nexit 0\n`, { mode: 0o755 });
  const before = process.env["DORI_TESSERACT"];
  process.env["DORI_TESSERACT"] = fake;
  try {
    expect(ocrPicture(join(dir, "비교.png"))).toBeUndefined();
    expect(plan(brief(OWNER_MSG), lane(RESULT, ["비교.png"]), NAMES, ocrPicture).post).toBe(false);
  } finally {
    if (before === undefined) delete process.env["DORI_TESSERACT"];
    else process.env["DORI_TESSERACT"] = before;
  }
});

/** A DORI_HOME with one lane k1 that is ready to reply, and the env to run the hook against it (no live home leaks in). */
function hookHome(sender: string) {
  const home = mkdtempSync(join(tmpdir(), "ready-hook-"));
  for (const d of ["briefs", "state", "results/k1"]) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, "briefs", "k1.md"), `# k1 (회장님 ${OWNER_MSG})\npublic: true\n\n## STOP WHEN\n`);
  writeFileSync(join(home, "results", "k1", "결과.md"), "# r\n\n바뀐 것.\n");
  writeFileSync(join(home, "state", "inbound.log"), `INBOUND discord ${ROOM} ${OWNER_MSG} from=owner ref=- "x"\n`);
  writeFileSync(join(home, "case-names.json"), JSON.stringify(NAMES));
  const { DORI_STATE_DIR: _s, DORI_CONFIG: _c, DORI_LANE: _l, ...rest } = process.env;
  const env = { ...rest, DORI_HOME: home, DORI_SEND_FILE: sender, DORI_CASE_NAMES: join(home, "case-names.json") };
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
  expect(run().exitCode).toBe(0);
  expect(readFileSync(join(dir, "posts"), "utf8")).toBe("x\n");
  expect(log()).toContain(`SKIP k1: already replied to ${OWNER_MSG}`);
});
