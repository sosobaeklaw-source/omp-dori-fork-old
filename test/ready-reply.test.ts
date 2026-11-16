import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  firstParagraph,
  loadNameHashes,
  NAME_HASH_SCHEME,
  type NameHashes,
  nameHash,
  ocrPicture,
  ownerMessages,
  planReply,
} from "../src/ready-reply.ts";
import { FAKE_SALT, fakeNames, hashFiles, OWNER_MSG, ROOM } from "./name-hashes.ts";

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
const NAMES = fakeNames();
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** planReply on a test lane; `caseNames` is an explicit argument (the fail-closed test passes undefined). */
const plan = (
  b: string,
  l: { dir: string; owners: Map<string, string> },
  names: NameHashes | undefined = NAMES,
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

  test("without readable client-name hashes and salt no lane posts (fail closed)", () => {
    const l = lane(RESULT);
    const noList = { brief: brief(OWNER_MSG), resultsDir: l.dir, owners: l.owners, readPicture: () => "" };
    expect(planReply({ ...noList, caseNames: undefined })).toEqual({
      post: false,
      why: "no readable client-name hashes and salt, so the reply cannot be checked",
    });
    const f = hashFiles();
    expect(loadNameHashes(f.hashes, f.saltFile)?.hashes.size).toBe(2);
    // No salt file, no hash file.
    expect(loadNameHashes(f.hashes, join(tmpdir(), "no-such-salt"))).toBeUndefined();
    expect(loadNameHashes(join(tmpdir(), "no-such-hashes.json"), f.saltFile)).toBeUndefined();
    // A salt file others can read, or an empty one.
    chmodSync(f.saltFile, 0o644);
    expect(loadNameHashes(f.hashes, f.saltFile)).toBeUndefined();
    chmodSync(f.saltFile, 0o600);
    writeFileSync(f.saltFile, " \n");
    expect(loadNameHashes(f.hashes, f.saltFile)).toBeUndefined();
    writeFileSync(f.saltFile, FAKE_SALT);
    // A broken hash file, another scheme, no or a wrong check, an empty list, or a malformed entry.
    const scheme = NAME_HASH_SCHEME;
    const check = nameHash(FAKE_SALT, scheme);
    const h = nameHash(FAKE_SALT, "가나다");
    for (const bad of [
      "{not json",
      JSON.stringify(["가나다"]),
      JSON.stringify({ scheme: "sha256:v0", check, lengths: [3], hashes: [h] }),
      JSON.stringify({ scheme, lengths: [3], hashes: [h] }),
      JSON.stringify({ scheme, check: h, lengths: [3], hashes: [h] }),
      JSON.stringify({ scheme, check, lengths: [3], hashes: [] }),
      JSON.stringify({ scheme, check, lengths: [], hashes: [h] }),
      JSON.stringify({ scheme, check, lengths: [3], hashes: [h, "가나다"] }),
    ]) {
      writeFileSync(f.hashes, bad);
      expect(loadNameHashes(f.hashes, f.saltFile)).toBeUndefined();
    }
  });

  test("a name is caught by its salted hash, and a salt that is not the file's own is refused", () => {
    const l = lane(RESULT, ["비교.png"]);
    for (const ocr of ["성명가나다", "가 나 다 님", "가\u200b나다", "ＡＢ가나다"]) {
      expect(plan(brief(OWNER_MSG), l, NAMES, () => ocr).post).toBe(false);
    }
    // The same file read under another salt (salt rotated, or only one file copied) is refused, not silently empty.
    const f = hashFiles();
    writeFileSync(f.saltFile, "another-fake-salt");
    expect(loadNameHashes(f.hashes, f.saltFile)).toBeUndefined();
    const wrongSalt = { brief: brief(OWNER_MSG), resultsDir: l.dir, owners: l.owners, readPicture: () => "" };
    expect(planReply({ ...wrongSalt, caseNames: loadNameHashes(f.hashes, f.saltFile) }).post).toBe(false);
    // Names of several lengths, including a Latin one compared in lower case.
    const mixed = hashFiles(["가나", "라마바사", "abc"]);
    const names = loadNameHashes(mixed.hashes, mixed.saltFile);
    for (const ocr of ["담당 가 나", "라마바사 건", "x ABC y"]) {
      expect(plan(brief(OWNER_MSG), l, names, () => ocr).post).toBe(false);
    }
    expect(plan(brief(OWNER_MSG), l, names, () => "가다 라마바 ab").post).toBe(true);
  });

  test("the hash is HMAC-SHA256 of the squeezed name, the vector scripts/export_client_name_hashes.py pins", () => {
    expect(nameHash(FAKE_SALT, "가나다")).toBe("8c258ccd2dfa83393d2597cdf70eeff7c337d3705db6f0f4213175ed5252306c");
    // The file's `check`: the salt's hash of the scheme string.
    expect(nameHash(FAKE_SALT, NAME_HASH_SCHEME)).toBe(
      "3bea87113a07d73ed4274b34a60e61b79c186cd2de9c5636391705cea626e09f",
    );
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
