import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { bestPassage, briefQuery, citations, loadNotes, rank, recall, recallFor, terms } from "../src/dok-recall.ts";
import { loadNameHashes } from "../src/ready-reply.ts";
import { buildRequest, readRange } from "../src/writer-request.ts";
import { fakeNames, hashFiles } from "./name-hashes.ts";

/** Made-up names none of the fixtures hold, for the tests that are not about names. */
const NONE = fakeNames()!;

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

test("Korean words are matched with their particle stripped and by their two-letter pieces", () => {
  expect(terms("독후감을 카드뉴스는")).toEqual(["카드뉴스", "카드", "드뉴", "뉴스"]);
  expect(terms("the deployment 2026")).toEqual(["deploy"]);
});

test("notes: copies and backups are left out, the index is not a note", () => {
  const root = tree();
  const paths = loadNotes(root).map((n) => relative(root, n.path));
  // copy/ is not a backup name; it goes because its text is the shorter cardnews path's.
  expect(paths).toEqual(["cardnews-1112/독후감_카드뉴스.md", "fax-1110/독후감_팩스.md", "video-1111/독후감.md"]);
});

test("of files with the same text the shortest path stays, then the first by name, in any write order", () => {
  const rels = ["zz/독후감.md", "aa-longer/독후감.md", "b1/독후감.md", "a1/독후감.md", "a1/deep/독후감.md"];
  for (const order of [rels, [...rels].reverse(), [rels[2]!, rels[0]!, rels[4]!, rels[1]!, rels[3]!]]) {
    const root = mkdtempSync(join(tmpdir(), "dok-dup-"));
    for (const rel of order) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), `# 독후감 — 같은 글\n\n${filler("같은", 2).join("\n")}\n`);
    }
    // zz, b1 and a1 are the shortest; a1 is first by name. Without it, b1; a1/deep is longer than both.
    expect(loadNotes(root).map((n) => relative(root, n.path))).toEqual(["a1/독후감.md"]);
    rmSync(join(root, "a1", "독후감.md"));
    expect(loadNotes(root).map((n) => relative(root, n.path))).toEqual(["b1/독후감.md"]);
  }
});

test("the brief's topic ranks first, and the passage is the section that shares its words", () => {
  const root = tree();
  const notes = loadNotes(root);
  const query = "카드뉴스 문구를 법률가 말로 다시 쓴다";
  const ranked = rank(query, notes);
  expect(ranked[0]!.note.path).toEndWith("cardnews-1112/독후감_카드뉴스.md");
  const { kept } = recall(query, ranked, 1, 2000, NONE);
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
  const roomy = recall(query, ranked, 3, 100_000, NONE);
  expect(roomy.kept.map((p) => p.path)).toEqual(ranked.map((s) => s.note.path));
  expect(roomy.over).toEqual([]);
  const tight = recall(query, ranked, 2, 100_000, NONE);
  expect(tight.kept.map((p) => p.path)).toEqual(ranked.slice(0, 2).map((s) => s.note.path));
  expect(tight.over.map((p) => p.path)).toEqual([ranked[2]!.note.path]);
  for (const p of recall(query, ranked, 3, 300, NONE).kept) expect(p.chars).toBeLessThanOrEqual(100);
});

test("a weak tail is cut: under the floor or sharing too few words, and a reading-list section never counts", () => {
  const root = join(mkdtempSync(join(tmpdir(), "dok-floor-")), "results");
  const note = (rel: string, lines: string[]) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), `${lines.join("\n")}\n`);
  };
  note("noise-1111/독후감_난청.md", ["# 독후감 — 소음성 난청 청력 기준", "", ...filler("난청 청력", 4)]);
  note("incident-1109/독후감_경위서.md", ["# 독후감 — 재해경위서 틀", "", ...filler("경위서 난청", 4)]);
  note("read-1113/독후감_읽은것.md", [
    "# 독후감 — 소음성 난청 청력 자료",
    "",
    "## 읽은 것",
    "- `~/sobaegi-lead/results/noise-1111/독후감_난청.md` 소음성 난청 청력 기준을 정리한 글이다",
    "- `~/sobaegi-lead/results/noise-1111/지침_원문.pdf` 소음성 난청 청력 업무처리기준 원문이다",
  ]);
  // Topics of their own, so the query's words are held by under half the notes and count.
  for (const t of ["팩스", "영상", "카드뉴스", "휴업급여"])
    note(`${t}-1110/독후감.md`, [`# 독후감 — ${t}`, "", ...filler(t, 4)]);
  const query = "소음성 난청 청력 기준";
  const ranked = rank(query, loadNotes(root));
  const all = recall(query, ranked, 5, 100_000, NONE).kept.map((p) => relative(root, p.path));
  expect(all).toContain("incident-1109/독후감_경위서.md");
  expect(all).not.toContain("read-1113/독후감_읽은것.md");
  const strict = recall(query, ranked, 5, 100_000, NONE, { minHit: 3 }).kept.map((p) => relative(root, p.path));
  expect(strict).toEqual(["noise-1111/독후감_난청.md"]);
  const floored = recall(query, ranked, 5, 100_000, NONE, { floor: 0.99 }).kept;
  expect(floored.map((p) => relative(root, p.path))).toEqual(["noise-1111/독후감_난청.md"]);
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
  // The brief named another way (relative, with ..) is still itself.
  const cited = citations(home, join(home, "briefs", "..", "briefs", "me.md"));
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

test("a section whose one paragraph is longer than the budget still gives a range writer_request takes", () => {
  const root = join(mkdtempSync(join(tmpdir(), "dok-long-")), "results");
  mkdirSync(join(root, "hearing-1116"), { recursive: true });
  const long = "소음성 난청 장해등급은 귀마다 6분법 평균을 낸다. ".repeat(60);
  expect(long.length).toBeGreaterThan(1600);
  const lines = ["# 독후감 — 난청", "", "## 난청 등급 읽기", "", long, "", "## 끝", "짧다"];
  writeFileSync(join(root, "hearing-1116", "독후감.md"), `${lines.join("\n")}\n`);
  const [note] = loadNotes(root);
  const p = bestPassage(note!, "난청 등급", 300)!;
  expect([p.start, p.end]).toEqual([3, 5]);
  const home = mkdtempSync(join(tmpdir(), "dok-build-"));
  const task = join(home, "task.md");
  writeFileSync(task, "난청 글을 다시 쓴다\n");
  const lane = join(home, "lane");
  const built = buildRequest({
    home,
    kind: "seo",
    model: "argon",
    laneDir: lane,
    tasks: [task],
    cases: [`${p.path}:${p.start}-${p.end}`],
  });
  expect(built.dok).toBe(1);
});

test("an ontology alias finds the note written under the other name, and the request lists its atoms by line", () => {
  const root = join(mkdtempSync(join(tmpdir(), "dok-onto-")), "results");
  mkdirSync(join(root, "injury-1110"), { recursive: true });
  const note = join(root, "injury-1110", "독후감.md");
  const lines = ["# 독후감 — 상병 이름", "", "## 다발성골절 및 내부 장기손상", ...filler("장기손상", 2)];
  writeFileSync(note, `${lines.join("\n")}\n`);
  const concepts = [{ type: "상병", name: "T0291", terms: ["다발성골절 및 내부 장기손상"] }];
  const home = mkdtempSync(join(tmpdir(), "dok-onto-home-"));
  const opts = { root, concepts, limit: 5, maxChars: 5000 };
  expect(recallFor(home, "T0291 요양", NONE, { ...opts, concepts: [] }).specs).toEqual([]);
  const got = recallFor(home, "T0291 요양", NONE, opts);
  expect(got.onto).toEqual(["T0291→다발성골절 및 내부 장기손상"]);
  expect(got.specs).toHaveLength(1);
  const task = join(home, "task.md");
  writeFileSync(task, "T0291 요양 글을 쓴다\n");
  const built = buildRequest({
    home,
    kind: "seo",
    model: "argon",
    laneDir: join(home, "lane"),
    tasks: [task],
    recalled: got,
  });
  const count = readFileSync(built.path.replace(/\.txt$/, ".count"), "utf8").split("\n");
  expect(count[0]).toEndWith("recall=1 onto=1");
  expect(count).toContain("# 온톨로지: T0291→다발성골절 및 내부 장기손상");
  expect(count).toContain(`[${note}:4] ${lines[3]}`);
});

test("a note with no case line gives no passage; two notes keep their shared words", () => {
  const root = join(mkdtempSync(join(tmpdir(), "dok-few-")), "results");
  mkdirSync(join(root, "a-1110"), { recursive: true });
  mkdirSync(join(root, "b-1110"), { recursive: true });
  writeFileSync(join(root, "a-1110", "독후감.md"), "# 독후감 — 팩스\n\n## 팩스\n짧다\n");
  writeFileSync(join(root, "b-1110", "독후감.md"), `# 독후감 — 팩스 보내기\n\n${filler("팩스", 2).join("\n")}\n`);
  const notes = loadNotes(root);
  const ranked = rank("팩스", notes);
  expect(ranked).toHaveLength(2);
  const { kept, over } = recall("팩스", ranked, 5, 5000, NONE);
  expect(kept.map((p) => p.path)).toEqual([join(root, "b-1110", "독후감.md")]);
  expect(over).toEqual([]);
});

test("the brief's words stop at the harness's standing sections", () => {
  for (const tail of ["Lane rules", "STOP WHEN (파쿠리)", "Lessons for omp-dori"])
    expect(briefQuery(`# 일\n난청 글\n## ${tail}\n팩스`)).toBe("# 일\n난청 글");
});

test("a passage holding a client name, registration number, phone number or case path is left out", () => {
  const root = join(mkdtempSync(join(tmpdir(), "dok-pii-")), "results");
  const note = (dir: string, line: string) => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "독후감.md"), `# 독후감 — 경력표\n\n${[...filler("경력표", 2), line].join("\n")}\n`);
  };
  note("name-1113", "내가 만든 홍 길 순 재해경위서 표는 원본을 빌린 것이다.");
  note("rrn-1113", "주민번호 900101-1234567 칸을 넓혔다.");
  note("phone-1113", "연락처 010-1234-5678 칸은 오른쪽에 둔다.");
  note("path-1113", "원본은 ~/LegalData/cases/x 에 있다.");
  note("clean-1113", "회장님 지시대로 2026년 11월 13일에 칸을 맞췄다.");
  // Each folder name is in one note only, so every note ranks (a word more than half the notes hold never counts).
  const query = "name rrn phone path clean";
  const ranked = rank(query, loadNotes(root));
  expect(ranked).toHaveLength(5);
  const f = hashFiles(["홍길순"]);
  const { kept, over } = recall(query, ranked, 10, 100_000, loadNameHashes(f.hashes, f.saltFile)!);
  expect([...kept, ...over].map((p) => relative(root, p.path))).toEqual(["clean-1113/독후감.md"]);
});

test("of two copies one line apart, the passage they share is given once", () => {
  const root = join(mkdtempSync(join(tmpdir(), "dok-dup-")), "results");
  const body = (first: string) =>
    `# 독후감 — 팩스\n\n## 처음\n${first}\n\n## 팩스 보내기\n${filler("팩스", 3).join("\n")}\n`;
  for (const [dir, first] of [
    ["a-1110", "처음 판에서 쓴 줄이다."],
    ["b-1110", "고친 판에서 쓴 줄이다."],
  ]) {
    mkdirSync(join(root, dir!), { recursive: true });
    writeFileSync(join(root, dir!, "독후감.md"), body(first!));
  }
  const ranked = rank("팩스 보내기", loadNotes(root));
  expect(ranked).toHaveLength(2);
  const { kept, over } = recall("팩스 보내기", ranked, 5, 5000, NONE);
  expect(kept).toHaveLength(1);
  expect(kept[0]!.start).toBe(6);
  expect(over).toEqual([]);
});
