/**
 * Word sheets and lead-proposal marking for src/writer-request.ts.
 *
 * A word sheet lists the words outside the body (figure text, table cells, cover strip): `[key]` lines, each followed
 * by what that slot says in the law's terms and its article, the sentence left out. `buildRequest --sheet` appends it
 * to the request, and `fillSheet` copies the writer's answer back per key for the renderer.
 */
import { existsSync, readFileSync } from "node:fs";
import { Refusal } from "./refusal.ts";

/**
 * `후: "A / B"` becomes `후(리드 제안): "A / B"` unless every `/`-separated part is in the entry's 원문: only the
 * owner's own words count as his fix, and a sentence the lead put there is a proposal.
 */
export function markLeadAfter(block: string): string {
  const owner = (/원문: "([\s\S]*)"\n전: /.exec(block) ?? /원문: "([\s\S]*)"\s*$/.exec(block))?.[1];
  return block.replace(/^후: "(.*)"$/m, (line, after: string) =>
    owner !== undefined && after.split(" / ").every((p) => owner.includes(p.trim()))
      ? line
      : `후(리드 제안): "${after}"`,
  );
}

/** Asked of the writer once, above the sheet's slots. */
export const SHEET_ASK =
  "아래 [ ] 칸마다, 그 아래 적힌 자리와 근거에 맞는 문장만 쓰세요. 답은 같은 [ ] 줄 아래에 그 칸의 문장만 둡니다.";

export interface Sheet {
  readonly text: string;
  /** Slot keys in sheet order. */
  readonly keys: readonly string[];
}

const SLOT = /^\[([^\]\s]+)\]\s*$/;

/**
 * A word sheet: `[key]` lines, each followed by what that slot says; keys are unique and at least one. `end` is the
 * request's task line, which the sheet must not hold.
 */
export function readSheet(path: string, end: string): Sheet {
  if (!existsSync(path)) throw new Refusal(`no word sheet ${path}`);
  const text = readFileSync(path, "utf8");
  if (text.split("\n").includes(end)) throw new Refusal(`${path} holds the line "${end}"`);
  const keys = text.split("\n").flatMap((l) => SLOT.exec(l.trim())?.[1] ?? []);
  if (keys.length === 0) throw new Refusal(`${path}: no [key] line`);
  const twice = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (twice.length > 0) throw new Refusal(`${path}: [${twice.join("], [")}] more than once`);
  return { text, keys };
}

/**
 * The writer's words per slot, in sheet order. Text under a `[key]` line up to the next one, trimmed; a `[key]` the
 * sheet does not have, a missing one or an empty one is refused, so a figure is never drawn from a partial answer.
 */
export function fillSheet(sheet: Sheet, answer: string): Record<string, string> {
  const got = new Map<string, string[]>();
  let open: string[] | undefined;
  for (const line of answer.split("\n")) {
    const key = SLOT.exec(line.trim())?.[1];
    if (key !== undefined) {
      if (!sheet.keys.includes(key)) throw new Refusal(`the answer has [${key}], which the sheet does not`);
      if (got.has(key)) throw new Refusal(`the answer has [${key}] more than once`);
      open = [];
      got.set(key, open);
    } else open?.push(line);
  }
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const k of sheet.keys) {
    const words = got.get(k)?.join("\n").trim();
    if (words) out[k] = words;
    else missing.push(k);
  }
  if (missing.length > 0) throw new Refusal(`the answer has no words for [${missing.join("], [")}]`);
  return out;
}
