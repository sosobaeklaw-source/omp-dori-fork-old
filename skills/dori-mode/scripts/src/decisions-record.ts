/** The decisions.jsonl record format: one event per line, each validated alone and then folded in order. */
export type Decision = {
  readonly id: string;
  readonly question: string;
  readonly source: string;
  readonly askedAt: string;
  readonly lane?: string;
  readonly thread?: string;
  /** Numbered 1..n in this order; an answer names an option by its number. */
  readonly options: readonly string[];
  readonly recommend?: number;
  readonly worklog?: string;
  /** Where the question was posted; a reply to exactly this message is the owner's answer. */
  readonly message?: string;
  readonly answeredAt?: string;
  readonly answer?: string;
  readonly option?: number;
  readonly answerSource?: string;
  readonly withdrawnAt?: string;
  readonly reason?: string;
};
export type DecisionAsk = {
  readonly question: string;
  readonly source: string;
  readonly lane?: string;
  readonly thread?: string;
  readonly options?: readonly string[];
  readonly recommend?: number;
  readonly worklog?: string;
  readonly message?: string;
};
/** `n` is the writing event's own random nonce: a writer finds its own event in the readback by it, never by content. */
type Stamp = { readonly id: string; readonly at: string; readonly n: string };
export type Event =
  | (Stamp & { readonly op: "ask" } & DecisionAsk)
  | (Stamp & { readonly op: "posted"; readonly message: string })
  | (Stamp & { readonly op: "answer"; readonly answer: string; readonly source: string; readonly option?: number })
  | (Stamp & { readonly op: "withdraw"; readonly reason: string });
/** problems are damage; warnings are the normal results of racing writers that are still worth naming. */
export type DecisionRead = { readonly items: Decision[]; readonly problems: string[]; readonly warnings: string[] };
export class DecisionError extends Error {}

export const MAX_OPTIONS = 9;
const ID = /^[0-9a-f]{8}$/;
// C0 and C1 controls (C1 holds U+0085 NEL and the CSI \x9b), DEL, and the Unicode line and paragraph separators.
const singleLine = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= max &&
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern deliberately matches control characters to reject or strip them
  !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value);
const isoTime = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export const inRange = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max;

const SHAPES = {
  ask: { need: { question: 1000, source: 400 }, may: { lane: 200, thread: 400, worklog: 8, message: 400 } },
  posted: { need: { message: 400 }, may: {} },
  answer: { need: { answer: 1000, source: 400 }, may: {} },
  withdraw: { need: { reason: 1000 }, may: {} },
} as const satisfies Record<Event["op"], { need: Record<string, number>; may: Record<string, number> }>;
const NUMBERS: Readonly<Record<string, readonly string[]>> = { ask: ["options", "recommend"], answer: ["option"] };

export const parseEvent = (value: unknown): Event => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new DecisionError("decision record must be a JSON object");
  const record = value as Record<string, unknown>;
  if (typeof record["id"] !== "string" || !ID.test(record["id"]))
    throw new DecisionError('decision field "id" must be 8 lowercase hex digits');
  if (!isoTime(record["at"]))
    throw new DecisionError('decision field "at" must be an ISO time as toISOString writes it');
  if (typeof record["n"] !== "string" || !ID.test(record["n"]))
    throw new DecisionError('decision field "n" must be 8 lowercase hex digits');
  const op = record["op"];
  if (typeof op !== "string" || !Object.hasOwn(SHAPES, op))
    throw new DecisionError('decision field "op" must be ask, posted, answer or withdraw');
  const shape: { need: Record<string, number>; may: Record<string, number> } = SHAPES[op as Event["op"]];
  const known = ["op", "id", "at", "n", ...Object.keys(shape.need), ...Object.keys(shape.may), ...(NUMBERS[op] ?? [])];
  const unknown = Object.keys(record).find((name) => !known.includes(name));
  if (unknown !== undefined) throw new DecisionError(`unknown decision field "${unknown}"`);
  for (const [name, max] of Object.entries({ ...shape.need, ...shape.may })) {
    if ((name in shape.need || record[name] !== undefined) && !singleLine(record[name], max))
      throw new DecisionError(`decision field "${name}" must be one nonempty line of at most ${max} characters`);
  }
  // References are printed as space-separated fields (boot's DECIDE line) and compared exactly by `match`.
  for (const name of ["lane", "thread", "message"])
    if (typeof record[name] === "string" && /\s/.test(record[name]))
      throw new DecisionError(`decision field "${name}" must be one reference without spaces`);
  if (record["worklog"] !== undefined && !ID.test(String(record["worklog"])))
    throw new DecisionError('decision field "worklog" must be 8 lowercase hex digits');
  const options = record["options"];
  if (
    options !== undefined &&
    (!Array.isArray(options) || !inRange(options.length, MAX_OPTIONS) || !options.every((o) => singleLine(o, 200)))
  )
    throw new DecisionError(`decision field "options" must hold 1 to ${MAX_OPTIONS} nonempty lines of 200 characters`);
  const count = Array.isArray(options) ? options.length : 0;
  if (record["recommend"] !== undefined && !inRange(record["recommend"], count))
    throw new DecisionError(
      count ? `the recommendation must be an option number from 1 to ${count}` : "a recommendation needs options",
    );
  if (record["option"] !== undefined && !inRange(record["option"], MAX_OPTIONS))
    throw new DecisionError(`decision field "option" must be an option number from 1 to ${MAX_OPTIONS}`);
  return record as Event;
};

// Every record is JSON.stringify of an event built op first, so it starts with this.
const RECORD_START = '{"op":"';
/** A line that does not parse but begins like a record is a write cut off halfway: harmless, and skipped quietly. */
export const isTorn = (line: string): boolean => line.startsWith(RECORD_START) || RECORD_START.startsWith(line);

export const settled = (d: Decision): "answered" | "withdrawn" | undefined =>
  d.answeredAt !== undefined ? "answered" : d.withdrawnAt !== undefined ? "withdrawn" : undefined;
