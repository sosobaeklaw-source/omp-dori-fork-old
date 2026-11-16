/**
 * Every way case material could get past the READY-reply check. Each test is one path: before the fix the lane
 * posted, after it the lane stays inbox-only. The client names here are made up.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstParagraph, ocrPicture, ownerMessages, planReply } from "../src/ready-reply.ts";

const ROOM = "1571013138764140544";
const OWNER = "1571675313379737672";
const BRIEF = `# 레인 ${OWNER}\n\n## STOP WHEN\n`;
const RESULT = "# 결과\n\n## 한 줄\n\n자막을 바꿨다.\n";
const NAMES = ["가나다", "라마바"];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

type Lane = { root: string; dir: string; owners: Map<string, string> };
function lane(files: Record<string, string | Buffer> = {}): Lane {
  const root = mkdtempSync(join(tmpdir(), "guard-"));
  writeFileSync(join(root, "inbound.log"), `INBOUND discord ${ROOM} ${OWNER} from=owner ref=- "x"\n`);
  const dir = join(root, "results");
  mkdirSync(dir);
  writeFileSync(join(dir, "결과.md"), RESULT);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return { root, dir, owners: ownerMessages(join(root, "inbound.log")) };
}

const plan = (l: Lane, names: readonly string[] = NAMES, read: (p: string) => string | undefined = () => "전후 비교") =>
  planReply({ brief: BRIEF, resultsDir: l.dir, owners: l.owners, caseNames: names, readPicture: read });
const posts = (l: Lane, names?: readonly string[], read?: (p: string) => string | undefined) =>
  plan(l, names, read).post;

test("the clean lane still posts (control)", () => {
  expect(plan(lane({ "a.py": "print(1)", "비교.png": PNG }))).toMatchObject({ post: true, text: "자막을 바꿨다." });
});

describe("files the check could not read", () => {
  test("script and markup files are read for names and numbers (build.py, section0.xml, ts, sh)", () => {
    for (const f of ["build.py", "Contents/section0.xml", "a.ts", "run.sh", "x.css"]) {
      expect(posts(lane({ [f]: "# 가나다 800101-1234567" }))).toBe(false);
    }
  });

  test("a file of a type the check does not know blocks (no extension, zip, rtf, odt, eml, pyc, odd suffix)", () => {
    for (const f of ["README", "a.zip", "b.rtf", "c.odt", "d.eml", "e.pyc", "f.before_52h", "g.hwp"]) {
      expect(posts(lane({ [f]: "x" }))).toBe(false);
    }
  });

  test("binary bytes in a text-named file block (NUL, invalid UTF-8)", () => {
    expect(posts(lane({ "a.md": "가\u0000나다" }))).toBe(false);
    expect(posts(lane({ "b.txt": Buffer.from([0x61, 0xff, 0xfe, 0x62]) }))).toBe(false);
  });

  test("a picture name over bytes that are not a picture blocks", () => {
    expect(posts(lane({ "shot.png": "가나다 800101-1234567" }))).toBe(false);
  });

  test("a text file too large to read whole blocks", () => {
    expect(posts(lane({ "big.log": "a".repeat(6 * 1024 * 1024) }))).toBe(false);
  });

  test("a file that cannot be opened blocks", () => {
    const l = lane({ "secret.py": "가나다" });
    chmodSync(join(l.dir, "secret.py"), 0);
    expect(posts(l)).toBe(false);
  });

  test("a symbolic link blocks, to a file or to a folder", () => {
    const outside = lane({ "facts.md": "가나다 800101-1234567" });
    const toFile = lane();
    symlinkSync(join(outside.dir, "facts.md"), join(toFile.dir, "facts.md"));
    expect(posts(toFile)).toBe(false);
    const toDir = lane();
    symlinkSync(outside.dir, join(toDir.dir, "work"));
    expect(posts(toDir)).toBe(false);
  });

  test("a hidden file or folder blocks", () => {
    expect(posts(lane({ ".notes.md": "x" }))).toBe(false);
    expect(posts(lane({ ".cache/x.md": "x" }))).toBe(false);
  });

  test("a folder nested deeper than the check walks blocks", () => {
    expect(posts(lane({ "a/b/c/d/e/f/g/x.md": "x" }))).toBe(false);
    expect(posts(lane({ "a/b/c/x.md": "x" }))).toBe(true);
  });
});

describe("names and numbers the check did not recognise", () => {
  test("a registration number with spaces or another dash blocks", () => {
    for (const n of ["800101 - 1234567", "800101 1234567", "800101–1234567", "８００１０１-１２３４５６７"]) {
      expect(posts(lane({ "a.md": `번호 ${n}` }))).toBe(false);
    }
  });

  test("a name followed by any ending blocks", () => {
    for (const w of [
      "가나다에게는",
      "가나다로부터",
      "가나다와의",
      "가나다에게서",
      "가나다님께서는",
      "가나다씨에게는",
    ]) {
      expect(posts(lane({ "a.md": `${w} 말했다` }))).toBe(false);
    }
    for (const w of ["가나다였다", "가나다이라는", "가나다까지", "가나다께", "가나다라마"]) {
      expect(posts(lane({ "a.md": w }))).toBe(false);
    }
    expect(posts(lane({ "a.md": "아가나다 표" }))).toBe(true);
  });

  test("long and non-Hangul names block", () => {
    const names = [...NAMES, "알레한드로", "Nguyen Van A"];
    for (const w of ["알레한드로는", "알레한드로의 진술", "nguyen  van a 씨", "NGUYEN VAN A"]) {
      expect(posts(lane({ "a.md": w }), names)).toBe(false);
    }
  });

  test("an escaped or disguised name blocks (JSON, HTML, percent, zero-width, decomposed)", () => {
    for (const w of [
      '{"n":"\\uac00\\ub098\\ub2e4"}',
      "&#xAC00;&#xB098;&#xB2E4;",
      "&#44032;&#45208;&#45796;",
      "%EA%B0%80%EB%82%98%EB%8B%A4",
      "가\u200b나다",
      "가나다".normalize("NFD"),
    ]) {
      expect(posts(lane({ "a.json": w }))).toBe(false);
    }
  });
});

describe("what gets posted", () => {
  test("the posted picture is read: a name or number in it, or a picture that cannot be read, blocks", () => {
    const l = lane({ "비교.png": PNG });
    expect(posts(l, NAMES, () => "성명 가나다")).toBe(false);
    expect(posts(l, NAMES, () => "800101-1234567")).toBe(false);
    expect(posts(l, NAMES, () => undefined)).toBe(false);
    expect(plan(l)).toMatchObject({ post: true, image: join(l.dir, "비교.png") });
    process.env["DORI_TESSERACT"] = join(l.root, "no-such-ocr");
    try {
      expect(posts(l, NAMES, ocrPicture)).toBe(false);
    } finally {
      delete process.env["DORI_TESSERACT"];
    }
  });

  test("fenced code is never posted, even split by a blank line", () => {
    expect(firstParagraph("# r\n\n```\ncode1\n\ncode2\n```\n\n본문.")).toBe("본문.");
    expect(firstParagraph("# r\n\n<!-- a\n\nb -->\n\n본문.")).toBe("본문.");
  });
});

/** A home with lane k1 ready to reply and a sender that counts its posts. */
function hook() {
  const home = mkdtempSync(join(tmpdir(), "guard-hook-"));
  for (const d of ["briefs", "state", "results/k1"]) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, "briefs", "k1.md"), BRIEF);
  writeFileSync(join(home, "results", "k1", "결과.md"), RESULT);
  writeFileSync(join(home, "state", "inbound.log"), `INBOUND discord ${ROOM} ${OWNER} from=owner ref=- "x"\n`);
  writeFileSync(join(home, "names.json"), JSON.stringify(NAMES));
  const sender = join(home, "send.sh");
  writeFileSync(sender, `#!/bin/sh\necho x >> "${home}/posts"\necho "SENT 42"\n`, { mode: 0o755 });
  const { DORI_STATE_DIR: _s, DORI_CONFIG: _c, DORI_LANE: _l, ...rest } = process.env;
  const env = { ...rest, DORI_HOME: home, DORI_SEND_FILE: sender, DORI_CASE_NAMES: join(home, "names.json") };
  const run = () => Bun.spawnSync(["bun", join(import.meta.dir, "..", "tools", "ready_reply.ts"), "k1"], { env });
  return { home, run };
}

test("a reply that went up is a success even when the lead cannot be told, and a lane is answered once", () => {
  const { home, run } = hook();
  const first = run();
  expect(first.exitCode).toBe(0);
  const log = () => readFileSync(join(home, "state", "ready-reply.log"), "utf8");
  expect(log()).toContain(`REPLIED k1 ${OWNER} 42`);
  expect(log()).not.toContain("FAIL");
  expect(run().exitCode).toBe(0);
  expect(readFileSync(join(home, "posts"), "utf8")).toBe("x\n");
  expect(log()).toContain(`SKIP k1: already replied to ${OWNER}`);
});
