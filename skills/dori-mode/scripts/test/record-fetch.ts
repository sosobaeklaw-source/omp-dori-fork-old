import { appendFileSync } from "node:fs";

// Preloaded into a CLI process by send-cli.test.ts and slack-cli.test.ts: every request is appended to
// $DORI_TEST_FETCH_LOG and answered the way Telegram answers a successful call, or with the body that
// $DORI_TEST_FETCH_REPLIES (a JSON object keyed by the URL's last path segment) gives, so no request leaves the machine.
const log = process.env["DORI_TEST_FETCH_LOG"] ?? "";
const replies = JSON.parse(process.env["DORI_TEST_FETCH_REPLIES"] ?? "{}") as Record<string, unknown>;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  appendFileSync(
    log,
    `${JSON.stringify({ url: String(input), body: typeof init?.body === "string" ? JSON.parse(init.body) : null })}\n`,
  );
  const reply = replies[String(input).split("/").at(-1) ?? ""] ?? { ok: true, result: { message_id: 99 } };
  return new Response(JSON.stringify(reply), { status: 200 });
}) as typeof fetch;
