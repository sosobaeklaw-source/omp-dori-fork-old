/** The agy seat's own records, kept in the dori home beside the call log. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A time as KST `YYYY-MM-DD HH:MM:SS`, the form the call log uses. */
export const kst = (ms: number): string => new Date(ms + 9 * 3600e3).toISOString().replace("T", " ").slice(0, 19);

/**
 * Until when Google's quota holds the seat: a 429 sets it from the reset time Google named ("reset after 3h12m",
 * "retry after 45s", `"retryDelay": "45s"`), or {@link QUOTA_HOLD_MS} when it named none, and no lane calls before it.
 */
export const QUOTA_HOLD_MS = 5 * 3600e3;
export const quotaUntilPath = (home: string): string => join(home, "state", "agy-s4.quota-until");
export function quotaResetMs(message: string): number {
  const delay = /retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)s/i.exec(message)?.[1];
  if (delay) return Math.ceil(Number(delay) * 1000);
  const named = /(?:reset|retry)\s+(?:after|in)\s+((?:\d+\s*[hms]\s*)+)/i.exec(message)?.[1] ?? "";
  const unit: Record<string, number> = { h: 3600e3, m: 60e3, s: 1e3 };
  let ms = 0;
  for (const [, n, u] of named.matchAll(/(\d+)\s*([hms])/gi)) ms += Number(n) * unit[u!.toLowerCase()]!;
  return ms || QUOTA_HOLD_MS;
}
export function readQuotaUntil(home: string): number {
  if (!existsSync(quotaUntilPath(home))) return 0;
  return (JSON.parse(readFileSync(quotaUntilPath(home), "utf8")) as { until?: number }).until ?? 0;
}
export function holdForQuota(home: string, until: number): void {
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(quotaUntilPath(home), `${JSON.stringify({ until: Math.max(until, readQuotaUntil(home)) })}\n`);
}

export const quotaPath = (home: string): string => join(home, "state", "agy-s4.quota.log");
/** Google's quota message, verbatim (its reset time included), one line per hit. */
export function logQuota(home: string, lane: string, at: number, message: string): void {
  mkdirSync(join(home, "state"), { recursive: true });
  appendFileSync(quotaPath(home), `${kst(at)}\t${lane}\t${message.replace(/\s+/g, " ").trim().slice(0, 600)}\n`);
}

const CALLS_HEAD = "시각\t계정\t종류\t모델\t모드 표지\t결과\t종료\t걸린 초\n";
/** One row of the call log the web runner also writes; seconds rounded, tabs and newlines flattened. */
export function appendCall(path: string, row: readonly (string | number)[]): void {
  const cell = (s: string | number): string =>
    (typeof s === "number" && !Number.isInteger(s) ? s.toFixed(0) : String(s)).replace(/[\t\n\r]+/g, " ").trim();
  mkdirSync(join(path, ".."), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, CALLS_HEAD);
  appendFileSync(path, `${row.map(cell).join("\t")}\n`);
}
