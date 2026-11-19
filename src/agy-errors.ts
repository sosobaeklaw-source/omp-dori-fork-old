/**
 * A previous account was suspended with a 403 after tool-like use. The seat serializes calls and keeps a 60-second
 * gap, checks the configured account before and after each call, stops on 403, and retries a file-linked answer once.
 * Quota holds and account checks are re-read before each call; changing these protections risks another suspension.
 * The request goes in a fresh folder and every call is logged. See writer-agy.ts for the implementation.
 */
/** What one `agy` call printed, and how the Antigravity seat (src/writer-agy.ts) reads it. */
export type AgyRun = { code: number; stdout: string; stderr: string };

/** A file link in the answer: `agy` wrote (or meant to write) an artifact instead of answering in the text. */
export const linksFile = (text: string): boolean =>
  /\]\(file:\/\/|implementation_plan\.md|\.gemini\/antigravity-cli\/brain\//.test(text);
/** What agy said besides the answer: the JSON error, the CLI's stderr and stdout that is not JSON. */
export const errorText = (r: AgyRun, error: string): string =>
  `${error}\n${r.stderr}\n${r.stdout.trimStart().startsWith("{") ? "" : r.stdout}`;
/** The 403 the suspended account got; a tool's bare PERMISSION_DENIED in plan mode is not it. */
export const isForbidden = (r: AgyRun, error: string): boolean =>
  /"error_code"\s*:\s*403|code 403|violation of Terms of Service/.test(errorText(r, error));
/** Google's own quota error: the only limit on how often the seat calls. */
export const isQuota = (r: AgyRun, error: string): boolean =>
  /"error_code"\s*:\s*429|code 429|\b429 Too Many Requests|RESOURCE_EXHAUSTED|quota exceeded/i.test(
    errorText(r, error),
  );
