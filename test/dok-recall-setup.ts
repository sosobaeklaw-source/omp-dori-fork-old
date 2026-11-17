/** Case-note (독후감) fixtures for the dok-recall tests. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeNames } from "./name-hashes.ts";

/** Made-up names none of the fixtures hold, for the tests that are not about names. */
export const NONE = fakeNames()!;

export const filler = (topic: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${topic} 이야기를 ${i}번째로 적은 줄이다. 다른 일과 겹치지 않는 내용이다.`);

/** A results tree: three topics, a backup copy, an exact copy, and an index that must not count as a note. */
export function tree(): string {
  const root = join(mkdtempSync(join(tmpdir(), "dok-recall-")), "sobaegi-lead", "results");
  const note = (rel: string, lines: string[]) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), `${lines.join("\n")}\n`);
  };
  const card = [
    "# 독후감 — 카드뉴스 문구",
    "",
    ...filler("카드", 3),
    "",
    "## 카드뉴스 문구는 법률가 말로",
    "",
    ...filler("문구", 4),
  ];
  note("cardnews-1112/독후감_카드뉴스.md", card);
  note("cardnews-1112/copy/독후감_카드뉴스.md", card);
  note("cardnews-1112/_bak/독후감.md", ["# 독후감 — 카드뉴스 옛판", ...filler("카드뉴스", 3)]);
  // Drafts, by file or folder name, each with its own text so only the name can leave it out.
  for (const [i, rel] of [
    "x/독후감_검수전.md",
    "x/독후감_초안.md",
    "x/수정전_독후감.md",
    "r34/_교정전_보존/독후감.md",
    "y/집필요청/독후감.md",
    "y/한도종료_독후감.md",
    "z/_읽기자료/독후감.md",
    "wck-recall-1109/독후감_5차전_백업.md",
    "readable-1110/독후감_opus_요청1.md",
    "r109/109차_독후감_11-12절_카본보정후보.md",
    "r111/carbon/독후감_3_실행stdout.md",
    "pd/독후감_최종집필_지시.md",
    "incident-multi-1115/pack/독후감_직업력표.md",
    "legal-lexicon-r84/__none__/독후감.md",
    "design-thinking-1112/research/local/books/독후감_학습하는법.md",
  ].entries())
    note(rel, [`# 독후감 — 카드뉴스 초안 ${i}`, ...filler(`초안${i}`, 3)]);
  note("video-1111/독후감.md", ["# 독후감 — 영상 컷", "", ...filler("영상", 5)]);
  note("fax-1110/독후감_팩스.md", ["# 독후감 — 팩스 보내기", "", ...filler("팩스", 5)]);
  note("독후감_색인.md", ["# 색인", "cardnews-1112 video-1111 fax-1110"]);
  return root;
}
