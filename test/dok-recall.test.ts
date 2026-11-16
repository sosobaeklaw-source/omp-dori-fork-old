import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { citations, loadNotes, rank, recall, terms } from "../src/dok-recall.ts";
import { readRange } from "../src/writer-request.ts";

const filler = (topic: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${topic} 이야기를 ${i}번째로 적은 줄이다. 다른 일과 겹치지 않는 내용이다.`);

/** A results tree: three topics, a backup copy, an exact copy, and an index that must not count as a note. */
function tree(): string {
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
  note("video-1111/독후감.md", ["# 독후감 — 영상 컷", "", ...filler("영상", 5)]);
  note("fax-1110/독후감_팩스.md", ["# 독후감 — 팩스 보내기", "", ...filler("팩스", 5)]);
  note("독후감_색인.md", ["# 색인", "cardnews-1112 video-1111 fax-1110"]);
  return root;
}

test("Korean words are matched with their particle stripped and by their two-letter pieces", () => {
  expect(terms("독후감을 카드뉴스는")).toEqual(["카드뉴스", "카드", "드뉴", "뉴스"]);
  expect(terms("the deployment 2026")).toEqual(["deploy"]);
});

test("notes: copies and backups are left out, the index is not a note", () => {
  const paths = loadNotes(tree()).map((n) => n.path.split("/").slice(-2).join("/"));
  expect(paths.sort()).toEqual(["cardnews-1112/독후감_카드뉴스.md", "fax-1110/독후감_팩스.md", "video-1111/독후감.md"]);
});

test("the brief's topic ranks first, and the passage is the section that shares its words", () => {
  const root = tree();
  const notes = loadNotes(root);
  const query = "카드뉴스 문구를 법률가 말로 다시 쓴다";
  const ranked = rank(query, notes);
  expect(ranked[0]!.note.path).toEndWith("cardnews-1112/독후감_카드뉴스.md");
  const { kept } = recall(query, ranked, 1, 2000);
  expect(kept).toHaveLength(1);
  expect(kept[0]!.start).toBe(7);
  expect(readRange(`${kept[0]!.path}:${kept[0]!.start}-${kept[0]!.end}`).lines[0]).toBe(
    "## 카드뉴스 문구는 법률가 말로",
  );
});

test("the budget keeps notes in rank order and names the next ones as over budget", () => {
  const notes = loadNotes(tree());
  const query = "카드뉴스 영상 팩스";
  const ranked = rank(query, notes);
  expect(ranked).toHaveLength(3);
  const roomy = recall(query, ranked, 3, 100_000);
  expect(roomy.kept.map((p) => p.path)).toEqual(ranked.map((s) => s.note.path));
  expect(roomy.over).toEqual([]);
  const tight = recall(query, ranked, 2, 100_000);
  expect(tight.kept.map((p) => p.path)).toEqual(ranked.slice(0, 2).map((s) => s.note.path));
  expect(tight.over.map((p) => p.path)).toEqual([ranked[2]!.note.path]);
  for (const p of recall(query, ranked, 3, 300).kept) expect(p.chars).toBeLessThanOrEqual(100);
});

test("a note other briefs and writer-cases cite ranks higher; the brief being recalled for is not counted", () => {
  const root = tree();
  const notes = loadNotes(root);
  const home = mkdtempSync(join(tmpdir(), "dok-home-"));
  mkdirSync(join(home, "briefs"));
  mkdirSync(join(home, "writer-cases"));
  const fax = join(root, "fax-1110/독후감_팩스.md");
  writeFileSync(join(home, "writer-cases", "seo.txt"), `${fax}:1-2\n`);
  writeFileSync(join(home, "briefs", "old.md"), `읽을 것: ${fax} 와 ${fax}\n`);
  const self = join(home, "briefs", "me.md");
  writeFileSync(self, `읽을 것: ${join(root, "video-1111/독후감.md")}\n`);
  const cited = citations(home, self);
  const sum = (dir: string) => notes.find((n) => n.path.includes(dir))!.sum;
  expect(cited.get(sum("fax-1110"))).toBe(2);
  expect(cited.has(sum("video-1111"))).toBe(false);
  const query = "영상 팩스";
  const plain = rank(query, notes);
  const lifted = rank(query, notes, cited);
  const scoreOf = (list: typeof plain) => list.find((s) => s.note.sum === sum("fax-1110"))!.score;
  expect(scoreOf(lifted)).toBeCloseTo(scoreOf(plain) * (1 + Math.log(3)));
  expect(lifted[0]!.note.sum).toBe(sum("fax-1110"));
});
