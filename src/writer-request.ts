/**
 * The one path from case notes and the owner's own rejection words to a writing model's request body.
 *
 * Every body starts, verbatim and never summarized, with:
 *   1. the case-note passages (독후감) for the kind, each range under its `path:START-END` label;
 *   2. the owner's rejection entries of that kind, copied from the ledger;
 *   3. every ledger entry in a repeat chain (an entry marked `반복 <id>` and the entry it repeats), with the
 *      before/after sentences recorded when it was fixed.
 * The lane's task text follows. The body is saved as `<lane dir>/requests/NN_<model>[_label].txt` and the number of
 * case lines that went in is written next to it as `NN_<model>[_label].count`.
 *
 * Words outside the body (figure text, table cells, cover strip, alt, captions) go the same way: the lane lists them
 * in one word sheet (`[key]` then what the slot says in the law's terms and its article, the sentence left out),
 * builds the request with `--sheet`, and `fill` copies the writer's answer back per key for the renderer
 * (src/writer-sheet.ts). Nobody retypes a figure's words between the writer and the picture.
 *
 * A ledger `후` sentence that is not in that entry's own 원문 was written by the lead, not the owner, so it goes into
 * the body as `후(리드 제안):`; the writer does not take it as the owner's fix. The ledger file is left as written.
 *
 * Data lives in the harness home, not here: `<home>/반복지적.md` (the ledger) and `<home>/writer-cases/<kind>.txt`
 * (one `path:START-END` per line). Only argon and hydrogen write; carbon is the red team.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Refusal } from "./refusal.ts";
import { markLeadAfter, readSheet, SHEET_ASK } from "./writer-sheet.ts";

export const KINDS = ["seo", "card", "video", "legal"] as const;
export type Kind = (typeof KINDS)[number];
const WRITERS = ["argon", "hydrogen"] as const;
export type Writer = (typeof WRITERS)[number];

export const ledgerPath = (home: string): string => join(home, "반복지적.md");
export const casesPath = (home: string, kind: Kind): string => join(home, "writer-cases", `${kind}.txt`);

export interface Entry {
  readonly msg: string;
  readonly kinds: readonly string[];
  readonly repeats: string | undefined;
  /** The entry exactly as the ledger has it, heading included. */
  readonly block: string;
}

const HEAD = /^## (.+?) · ([a-z]+(?:,[a-z]+)*) · msg (\S+) · post (.+?)(?: · 반복 (\S+))?$/;
const HEAD_SHAPE = "## DATE · KIND[,KIND] · msg ID · post POST[ · 반복 ID]";

export function kindOf(kind: string | undefined): Kind {
  const k = KINDS.find((x) => x === kind);
  if (!k) throw new Refusal(`--kind must be one of ${KINDS.join(", ")}`);
  return k;
}

export function writerOf(model: string | undefined): Writer {
  if (model === "carbon")
    throw new Refusal(
      "carbon is the red team: it reports findings and never writes a sentence; writers are argon and hydrogen",
    );
  const w = WRITERS.find((x) => x === model);
  if (!w) throw new Refusal(`--model must be argon or hydrogen${model ? `, not ${model}` : ""}`);
  return w;
}

export function parseLedger(text: string): Entry[] {
  const entries: Entry[] = [];
  let open: { msg: string; kinds: string[]; repeats: string | undefined; lines: string[] } | undefined;
  const close = () => {
    if (open) entries.push({ ...open, block: open.lines.join("\n").trimEnd() });
  };
  text.split("\n").forEach((line, i) => {
    if (!line.startsWith("## ")) {
      open?.lines.push(line);
      return;
    }
    const m = HEAD.exec(line);
    if (!m) throw new Refusal(`ledger line ${i + 1} is not "${HEAD_SHAPE}": ${line}`);
    close();
    open = { msg: m[3]!, kinds: m[2]!.split(","), repeats: m[5], lines: [line] };
  });
  close();
  return entries;
}

const readLedger = (home: string): Entry[] =>
  existsSync(ledgerPath(home)) ? parseLedger(readFileSync(ledgerPath(home), "utf8")) : [];

/** Entries in a repeat chain (marked 반복, or repeated by one), and the other entries of `kind` (or `all`). */
export function selectEntries(entries: readonly Entry[], kind: Kind): { reject: Entry[]; repeat: Entry[] } {
  const chained = new Set(entries.flatMap((e) => (e.repeats ? [e.msg, e.repeats] : [])));
  const repeat = entries.filter((e) => chained.has(e.msg));
  const reject = entries.filter((e) => !chained.has(e.msg) && (e.kinds.includes(kind) || e.kinds.includes("all")));
  return { reject, repeat };
}

/** `path:START-END`, 1-based and inclusive: the label and those lines verbatim. */
export function readRange(spec: string): Range {
  const m = /^(.+):(\d+)-(\d+)$/.exec(spec.trim());
  const start = Number(m?.[2]);
  const end = Number(m?.[3]);
  if (!m || start < 1 || end < start) throw new Refusal(`expected PATH:START-END (1-based, inclusive), got ${spec}`);
  const path = m[1]!.startsWith("~/") ? join(homedir(), m[1]!.slice(2)) : m[1]!;
  if (!existsSync(path)) throw new Refusal(`no case-note file ${m[1]}`);
  const all = readFileSync(path, "utf8").split("\n");
  if (end > all.length) throw new Refusal(`${m[1]}: asked for lines ${start}-${end}, file has ${all.length}`);
  return { label: `${m[1]}:${start}-${end}`, lines: all.slice(start - 1, end) };
}

export interface Range {
  readonly label: string;
  readonly lines: readonly string[];
}

/** A case line: at least 15 characters once trimmed, and neither a heading nor a table rule. */
const isCase = (s: string): boolean => s.length >= 15 && !s.startsWith("#") && !/^[|\-: ]+$/.test(s);

export const caseLines = (r: Range): string[] => r.lines.map((l) => l.trim()).filter(isCase);

/**
 * The case lines of `ranges` as atoms, each under `path:LINE`, once per line however many ranges hold it. This list
 * goes into the count file, and the delivery review (sanjai-agent scripts/delivery_review) shows for each atom the
 * body sentence that carries it, or 미반영.
 */
export function atomsOf(ranges: readonly Range[]): { at: string; text: string }[] {
  const seen = new Set<string>();
  const out: { at: string; text: string }[] = [];
  for (const r of ranges) {
    const m = /^(.+):(\d+)-\d+$/.exec(r.label)!;
    r.lines.forEach((line, i) => {
      const at = `${m[1]}:${Number(m[2]) + i}`;
      const text = line.trim();
      if (!isCase(text) || seen.has(at)) return;
      seen.add(at);
      out.push({ at, text });
    });
  }
  return out;
}

/** Everything above this line is case material; the case lines are looked for only there. */
export const END = "=== The task ===";

/** Per range: how many of its case lines the request holds above END, of how many. No END line means none. */
export function countCases(request: string, ranges: readonly Range[]): { label: string; hit: number; total: number }[] {
  const at = request.indexOf(`\n${END}\n`);
  const block = at < 0 ? "" : request.slice(0, at);
  return ranges.map((r) => {
    const cases = caseLines(r);
    return { label: r.label, hit: cases.filter((c) => block.includes(c)).length, total: cases.length };
  });
}

export const kindRanges = (home: string, kind: Kind, extra: readonly string[] = []): Range[] =>
  [...caseSpecs(home, kind), ...extra].map(readRange);

const caseSpecs = (home: string, kind: Kind): string[] =>
  existsSync(casesPath(home, kind))
    ? readFileSync(casesPath(home, kind), "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
    : [];

const nextNumber = (dir: string): number =>
  Math.max(0, ...readdirSync(dir).map((f) => Number(/^(\d+)/.exec(f)?.[1] ?? 0))) + 1;

export interface BuildInput {
  readonly home: string;
  readonly kind: Kind;
  readonly model: Writer;
  readonly laneDir: string;
  readonly tasks: readonly string[];
  /** A word sheet: its slots go after the tasks, and the writer is asked to answer under the same `[key]` lines. */
  readonly sheet?: string | undefined;
  /** Extra `path:START-END` ranges for this topic, after the kind's own. */
  readonly cases?: readonly string[];
  readonly label?: string | undefined;
  /**
   * Passages recalled for this request's own text (dok-recall's `recallFor`), after the kind's and `cases`; one the
   * others already hold whole is dropped. `onto` names the ontology concepts that widened the query; `off` says why
   * nothing was recalled.
   */
  readonly recalled?: { readonly specs: readonly string[]; readonly onto: readonly string[]; readonly off?: string };
}

export interface Built {
  readonly path: string;
  readonly dok: number;
  readonly reject: number;
  readonly repeat: number;
}

export function buildRequest(input: BuildInput): Built {
  if (input.tasks.length === 0 && !input.sheet) throw new Refusal("give the lane's task text with --task FILE");
  for (const t of input.tasks) if (!existsSync(t)) throw new Refusal(`no task file ${t}`);
  const sheet = input.sheet === undefined ? undefined : readSheet(input.sheet, END);
  const fixed = kindRanges(input.home, input.kind, input.cases);
  const holds = (spec: string): boolean => {
    const m = /^(.+):(\d+)-(\d+)$/.exec(spec)!;
    return fixed.some((r) => {
      const f = /^(.+):(\d+)-(\d+)$/.exec(r.label)!;
      return f[1] === m[1] && Number(f[2]) <= Number(m[2]) && Number(f[3]) >= Number(m[3]);
    });
  };
  const recalled = (input.recalled?.specs ?? []).filter((s) => !holds(s)).map(readRange);
  const ranges = [...fixed, ...recalled];
  if (ranges.length === 0)
    throw new Refusal(
      `no case notes for ${input.kind}: add PATH:START-END lines to ${casesPath(input.home, input.kind)}`,
    );
  for (const r of ranges) {
    if (caseLines(r).length === 0) throw new Refusal(`${r.label} holds no case line`);
    if (r.lines.includes(END)) throw new Refusal(`${r.label} holds the line "${END}", which would end the case block`);
  }
  const { reject, repeat } = selectEntries(readLedger(input.home), input.kind);
  const body = [
    "=== 1. Case notes (독후감), verbatim. Each passage is under its source path:lines. ===",
    ...ranges.flatMap((r) => ["", `[${r.label}]`, ...r.lines]),
    "",
    `=== 2. The owner's own words when he sent ${input.kind} work back, verbatim. ===`,
    ...reject.flatMap((e) => ["", markLeadAfter(e.block)]),
    "",
    "=== 3. Said more than once: the owner's words and the sentences fixed then, verbatim. ===",
    ...repeat.flatMap((e) => ["", markLeadAfter(e.block)]),
    "",
    END,
    "",
    ...input.tasks.map((t) => readFileSync(t, "utf8").trimEnd()),
    ...(sheet ? ["", SHEET_ASK, "", sheet.text.trimEnd()] : []),
    "",
  ].join("\n");
  const dir = join(input.laneDir, "requests");
  mkdirSync(dir, { recursive: true });
  const stem = `${String(nextNumber(dir)).padStart(2, "0")}_${input.model}${input.label ? `_${input.label}` : ""}`;
  const path = join(dir, `${stem}.txt`);
  writeFileSync(path, body);
  const counts = countCases(body, ranges);
  const dok = counts.reduce((n, c) => n + c.hit, 0);
  const r = input.recalled;
  const head = `dok=${dok} reject=${reject.length} repeat=${repeat.length} recall=${r?.off ? "off" : recalled.length} onto=${r?.onto.length ?? 0}`;
  const lines = counts.map((c) => `${c.label} ${c.hit}/${c.total}`);
  const trace = [
    ...(r?.off ? [`# recall off: ${r.off}`] : []),
    ...(r?.onto.length ? [`# 온톨로지: ${r.onto.join(" | ")}`] : []),
    `# 원자 ${atomsOf(ranges).length}개 (독후감경로:줄)`,
    ...atomsOf(ranges).map((a) => `[${a.at}] ${a.text}`),
  ];
  writeFileSync(join(dir, `${stem}.count`), [head, ...lines, ...trace, ""].join("\n"));
  return { path, dok, reject: reject.length, repeat: repeat.length };
}

/** KST `YYYY-MM-DD HH:MM` of a Discord message id. */
const snowflakeDate = (id: string): string | undefined =>
  /^\d{17,20}$/.test(id)
    ? new Date(Number((BigInt(id) >> 22n) + 1420070400000n) + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ")
    : undefined;

export interface AddInput {
  readonly home: string;
  readonly kinds: string;
  readonly msg: string;
  readonly text: string;
  readonly post?: string | undefined;
  readonly repeats?: string | undefined;
  readonly before?: string | undefined;
  readonly after?: string | undefined;
  readonly date?: string | undefined;
}

/** Append one owner 지적 to the ledger, verbatim; `repeats` marks it 반복 of an earlier entry. */
export function addEntry(input: AddInput): string {
  for (const k of input.kinds.split(","))
    if (k !== "all" && !KINDS.some((x) => x === k)) throw new Refusal(`--kind must be ${KINDS.join(", ")} or all`);
  const entries = readLedger(input.home);
  if (entries.some((e) => e.msg === input.msg)) throw new Refusal(`msg ${input.msg} is already in the ledger`);
  if (input.repeats && !entries.some((e) => e.msg === input.repeats))
    throw new Refusal(`--repeat ${input.repeats} is not in the ledger`);
  if (!input.before !== !input.after) throw new Refusal("give --before and --after together");
  const date = input.date ?? snowflakeDate(input.msg);
  if (!date) throw new Refusal("--date is needed when --msg is not a Discord message id");
  const head = `## ${date} · ${input.kinds} · msg ${input.msg} · post ${input.post ?? "-"}`;
  const lines = [
    "",
    input.repeats ? `${head} · 반복 ${input.repeats}` : head,
    `원문: "${input.text}"`,
    ...(input.before ? [`전: "${input.before}"`, `후: "${input.after}"`] : []),
  ];
  parseLedger(lines.join("\n"));
  appendFileSync(ledgerPath(input.home), `${lines.join("\n")}\n`);
  return lines[1]!;
}
