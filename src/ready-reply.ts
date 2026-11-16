/**
 * What a lane's READY posts back to the owner's own Discord message, decided from files only (no network).
 *
 * A lane gets a reply when all of these hold:
 *   - its brief names a message id that the inbound log (`<stateDir>/inbound.log`, lines
 *     `INBOUND discord <channel> <id> from=owner …`) records as the owner's. Ids under the brief's `## STOP WHEN`
 *     block are skipped: every parukuri brief cites the same standing order there, which is not this lane's message.
 *   - its results folder `<home>/results/<key>/` has `결과.md`; the reply text is that file's first prose paragraph
 *     (not a heading, table, list or quote, and not the one quoting the original message back).
 *   - the lane is not a case lane: neither the brief nor any file (name or text) in the results folder points into case
 *     folders, holds a registration number or a client name from the name list (`caseNames`). When the name list
 *     cannot be read or the folder cannot be read whole, the lane counts as a case lane (fail closed): inbox-only.
 * The picture is `비교_390.png` (the phone-width cut) when present, else `비교.png`, else none.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Case and private folders, the same set `private-read-deny.sb` keeps away from non-subscription models. */
const CASE_PATH =
  /LegalData|sanjai-agent(?:-wt\/[^/\s]+)?\/(?:cases|private|library\/sources\/private)(?:\/|\b)|\.omp-dori\/quarantine/;
/** Resident (7th digit 1-4) and foreigner (5-8) registration numbers, hyphen optional, led by a real YYMMDD date. */
const RRN = /(?<!\d)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])-?[1-8]\d{6}(?!\d)/;
const MSG_ID = /\b1[0-9]{17,19}\b/g;
const MAX_TEXT = 1900;

export type Owner = { readonly id: string; readonly channel: string };
export type Plan =
  | { readonly post: true; readonly owner: Owner; readonly text: string; readonly image?: string }
  | { readonly post: false; readonly why: string };

/** The owner messages in the inbound log, id -> channel. */
export function ownerMessages(inboundLog: string): Map<string, string> {
  const owners = new Map<string, string>();
  if (!existsSync(inboundLog)) return owners;
  for (const line of readFileSync(inboundLog, "utf8").split("\n")) {
    const m = /^INBOUND discord (\d+) (\d+) from=owner /.exec(line);
    if (m?.[1] && m[2]) owners.set(m[2], m[1]);
  }
  return owners;
}

/** The first id in the brief (above `## STOP WHEN`) that the owner posted. */
export function ownerMessageOf(brief: string, owners: ReadonlyMap<string, string>): Owner | undefined {
  const aboveStopWhen = brief.split(/^## STOP WHEN/m)[0] ?? brief;
  for (const id of aboveStopWhen.match(MSG_ID) ?? []) {
    const channel = owners.get(id);
    if (channel) return { id, channel };
  }
  return undefined;
}

/**
 * The paragraph a result file leads with, cut to fit one Discord message: the first prose paragraph under a heading
 * named 한 줄, 요약 or 결론 when there is one, else the first prose paragraph. Paragraphs containing any of `skip`
 * (the original message id quoted back, the lane's own results path) say nothing to the owner and are passed over.
 */
export function firstParagraph(result: string, skip: readonly string[] = []): string | undefined {
  const summary = result.split(/^#{1,6} .*(?:한 줄|요약|결론).*$/m)[1];
  if (summary !== undefined) {
    const lead = firstParagraph(summary.split(/^#{1,6} /m)[0] ?? "", skip);
    if (lead) return lead;
  }
  for (const block of result.split(/\n\s*\n/)) {
    const text = block.trim();
    if (!text || /^(#|\||[-*>] |\d+\. |```|<!--)/.test(text)) continue;
    if (skip.some((s) => text.includes(s))) continue;
    return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}… (결과.md에 이어짐)` : text;
  }
  return undefined;
}

export function pictureOf(dir: string): string | undefined {
  for (const name of ["비교_390.png", "비교.png"]) if (existsSync(join(dir, name))) return join(dir, name);
  return undefined;
}

/** Text files in a results folder are read for case material; anything else (pictures) is not readable as text. */
const TEXT_FILE = /\.(?:md|txt|json|jsonl|html?|svg|csv|tsv|log|ya?ml)$/i;
const MAX_FILES = 500;
const MAX_BYTES = 20 * 1024 * 1024;

/** The client-name list: a JSON array of names, or one name per line. Undefined when it cannot be read. */
export function loadCaseNames(path: string | undefined): readonly string[] | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf8");
    // Anything that opens like JSON is read as JSON, so a broken JSON file fails closed instead of becoming one "name".
    const list: unknown = /^\s*[[{]/.test(raw) ? JSON.parse(raw) : raw.split("\n");
    if (!Array.isArray(list)) return undefined;
    const names = list.filter((n): n is string => typeof n === "string").map((n) => n.trim());
    const kept = names.filter((n) => n.length >= 2);
    // An empty list judges nothing: the same as no list.
    return kept.length ? kept : undefined;
  } catch {
    return undefined;
  }
}

/** Every text file under `dir` with its contents, or a reason the folder cannot be read whole. */
function folderText(dir: string): { files: { name: string; text: string }[] } | { why: string } {
  const files: { name: string; text: string }[] = [];
  let bytes = 0;
  try {
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      const path = join(entry.parentPath, entry.name);
      files.push({ name: relative(dir, path), text: "" });
      if (files.length > MAX_FILES) return { why: `more than ${MAX_FILES} files to check` };
      if (!entry.isFile() || !TEXT_FILE.test(entry.name)) continue;
      bytes += statSync(path).size;
      if (bytes > MAX_BYTES) return { why: "more text than can be checked" };
      files[files.length - 1] = { name: relative(dir, path), text: readFileSync(path, "utf8") };
    }
  } catch (error) {
    return { why: `cannot read the results folder (${String(error)})` };
  }
  return { files };
}

/** A title glued onto a name ("가나다님께"), or a particle ("가나다는", "가나다의"): the run is still that name. */
const TITLE_AFTER = /^(?:씨|님)[가-힣]{0,2}$/;
const PARTICLE = /^(?:은|는|이|가|을|를|의|과|와|도|만|에|에게|에서|께서|한테|하고|이고|이며|이다|으로|로)$/;
/** Documents the check cannot read as text (`hwp`, `hwpx`, `pdf`, office files): a case file may be inside. */
const DOC_FILE = /\.(?:hwpx?|pdf|docx?|xlsx?|pptx?)$/i;

/**
 * Whether a client name stands in `s` as a word of its own: a Hangul run (cut at `_`, `-`, `.`, spaces and the like,
 * so `261113_가나다_재해경위서` counts) that is the name, or the name with a particle or title glued on. A name
 * embedded in a longer word ("아가나다", "가나다라마") does not count. Bare words count even though the list, cut from
 * case file names, also holds ordinary words: a false match only keeps the lane inbox-only.
 */
function hasName(s: string, names: ReadonlySet<string>): boolean {
  for (const [run] of s.normalize("NFC").matchAll(/[가-힣]+/g)) {
    const name = [run, run.slice(0, 4), run.slice(0, 3), run.slice(0, 2)].find((n) => names.has(n));
    if (!name) continue;
    const glued = run.slice(name.length);
    if (!glued || PARTICLE.test(glued) || TITLE_AFTER.test(glued)) return true;
  }
  return false;
}

/**
 * Why this lane must stay inbox-only because of case material, or undefined when it may post. Fails closed: with no
 * readable client-name list, or a results folder that cannot be read whole, the lane is treated as a case lane.
 * Checked: the brief, and every file name and text file in the results folder, for case-folder paths, resident or
 * foreigner registration numbers (hyphen optional) and client names; a document it cannot read also blocks.
 */
export function caseReason(
  brief: string,
  resultsDir: string,
  names: readonly string[] | undefined,
): string | undefined {
  if (!names) return "no readable client-name list, so the lane cannot be judged";
  const folder = folderText(resultsDir);
  if ("why" in folder) return folder.why;
  const nameSet = new Set(names);
  for (const { name, text } of [{ name: "brief", text: brief }, ...folder.files]) {
    for (const s of [name, text]) {
      if (CASE_PATH.test(s)) return `${name} points into case folders`;
      if (RRN.test(s)) return `${name} holds a registration number`;
      if (hasName(s, nameSet)) return `${name} holds a client name`;
    }
    if (DOC_FILE.test(name)) return `${name} is a document the check cannot read`;
  }
  return undefined;
}

export function planReply(input: {
  readonly brief: string;
  readonly resultsDir: string;
  readonly owners: ReadonlyMap<string, string>;
  readonly caseNames: readonly string[] | undefined;
}): Plan {
  const owner = ownerMessageOf(input.brief, input.owners);
  if (!owner) return { post: false, why: "the brief names no owner message" };
  const resultFile = join(input.resultsDir, "결과.md");
  if (!existsSync(resultFile)) return { post: false, why: `no ${resultFile}` };
  const result = readFileSync(resultFile, "utf8");
  const blocked = caseReason(input.brief, input.resultsDir, input.caseNames);
  if (blocked) return { post: false, why: `case lane: ${blocked}` };
  const text = firstParagraph(result, [owner.id, input.resultsDir]);
  if (!text) return { post: false, why: "결과.md has no prose paragraph" };
  const image = pictureOf(input.resultsDir);
  return image ? { post: true, owner, text, image } : { post: true, owner, text };
}
