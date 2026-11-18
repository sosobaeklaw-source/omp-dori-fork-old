/**
 * The owner's rejection ledger (`<home>/반복지적.md`): his words when he sent work back, verbatim, one `## ` entry
 * each, an entry marked `반복 <id>` when he said it again. `writer-request.ts` copies the entries into every request.
 */
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Refusal } from "./refusal.ts";

export const KINDS = ["seo", "card", "video", "legal"] as const;
export type Kind = (typeof KINDS)[number];

export const ledgerPath = (home: string): string => join(home, "반복지적.md");

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

export const readLedger = (home: string): Entry[] =>
  existsSync(ledgerPath(home)) ? parseLedger(readFileSync(ledgerPath(home), "utf8")) : [];

/** Entries in a repeat chain (marked 반복, or repeated by one), and the other entries of `kind` (or `all`). */
export function selectEntries(entries: readonly Entry[], kind: Kind): { reject: Entry[]; repeat: Entry[] } {
  const chained = new Set(entries.flatMap((e) => (e.repeats ? [e.msg, e.repeats] : [])));
  const repeat = entries.filter((e) => chained.has(e.msg));
  const reject = entries.filter((e) => !chained.has(e.msg) && (e.kinds.includes(kind) || e.kinds.includes("all")));
  return { reject, repeat };
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

/**
 * Put the sentences fixed for one entry, `전:` then `후:`, after the entry's last non-blank line (where `addEntry`
 * writes them), however many lines its 원문 runs over. The entry is found by its heading line. Every other byte of the
 * ledger stays as it was, and the new ledger must parse to the same entries before it replaces the old one. Refused
 * when the msg is not in the ledger or its text already ends with a 전/후 pair.
 */
export function pairEntry(input: { home: string; msg: string; before: string; after: string }): string {
  const text = readFileSync(ledgerPath(input.home), "utf8");
  const entries = parseLedger(text);
  const entry = entries.find((e) => e.msg === input.msg);
  if (!entry) throw new Refusal(`msg ${input.msg} is not in the ledger`);
  const lines = text.split("\n");
  const head = entry.block.split("\n")[0]!;
  const start = lines.indexOf(head);
  const next = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  let last = (next < 0 ? lines.length : next) - 1;
  while (lines[last]!.trim() === "") last--;
  if (/^전: ".*"$/.test(lines[last - 1] ?? "") && /^후: ".*"$/.test(lines[last]!) && last - 1 > start + 1)
    throw new Refusal(`msg ${input.msg} already has 전/후`);
  const out = [...lines.slice(0, last + 1), `전: "${input.before}"`, `후: "${input.after}"`, ...lines.slice(last + 1)];
  const after = parseLedger(out.join("\n"));
  if (after.length !== entries.length || after.some((e, i) => e.msg !== entries[i]!.msg))
    throw new Refusal("--before and --after must not start a new ledger entry");
  const tmp = `${ledgerPath(input.home)}.pair-${process.pid}`;
  writeFileSync(tmp, out.join("\n"));
  renameSync(tmp, ledgerPath(input.home));
  return head;
}
