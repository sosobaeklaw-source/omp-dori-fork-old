import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isForbidden } from "../src/agy-errors.ts";
import { EXIT, sendOnAgy, stopPath } from "../src/writer-agy.ts";
import { ok, setup } from "./agy-fake.ts";

const quota = (error: string) => ({
  code: 1,
  stdout: JSON.stringify({ status: "ERROR", response: "", error }),
  stderr: "",
});
const H = 3600_000;

describe("agy seat after Google's quota error", () => {
  test("no call until the reset time Google gave; the first send after it goes out", async () => {
    const { env, opts, calls, advance } = setup([
      quota("RESOURCE_EXHAUSTED (code 429): Quota exceeded. Your quota will reset after 3h12m."),
      ok("본문"),
    ]);
    await expect(sendOnAgy(env, opts)).rejects.toMatchObject({ code: EXIT.quota });
    advance(3 * H);
    await expect(sendOnAgy(env, opts)).rejects.toMatchObject({ code: EXIT.quota });
    expect(calls).toHaveLength(1);
    advance(13 * 60_000);
    expect(await sendOnAgy(env, opts)).toBe(EXIT.ok);
    expect(calls).toHaveLength(2);
  });

  test("a 429 with no reset time Google named still holds the seat for hours, not one gap", async () => {
    const { env, opts, calls, advance } = setup([quota("RESOURCE_EXHAUSTED (code 429)"), ok("본문")]);
    await expect(sendOnAgy(env, opts)).rejects.toMatchObject({ code: EXIT.quota });
    advance(2 * H);
    await expect(sendOnAgy(env, opts)).rejects.toMatchObject({ code: EXIT.quota });
    expect(calls).toHaveLength(1);
  });

  test("a lane sends nothing while another lane's 429 still holds the seat", async () => {
    const { env, opts, calls, home } = setup([ok("본문")]);
    writeFileSync(join(home, "state", "agy-s4.quota-until"), `${JSON.stringify({ until: env.now() + H })}\n`);
    await expect(sendOnAgy(env, opts)).rejects.toMatchObject({ code: EXIT.quota });
    expect(calls).toHaveLength(0);
  });

  test("a send that ends without an answer leaves no earlier answer in --out", async () => {
    const { env, opts } = setup([quota("RESOURCE_EXHAUSTED (code 429)")]);
    writeFileSync(opts.out, "지난번 답\n");
    await expect(sendOnAgy(env, opts)).rejects.toMatchObject({ code: EXIT.quota });
    expect(existsSync(opts.out)).toBe(false);
  });

  test("a tool's PERMISSION_DENIED without 403 is not the account 403 and does not stop the seat", async () => {
    const r = { code: 1, stdout: "", stderr: "tool write_file: PERMISSION_DENIED: sandbox blocks writes" };
    expect(isForbidden(r, "")).toBe(false);
    const { env, opts, home } = setup([r]);
    expect(await sendOnAgy(env, opts)).toBe(EXIT.empty);
    expect(existsSync(stopPath(home))).toBe(false);
    expect(readFileSync(join(home, "state", "gemini-calls.tsv"), "utf8")).not.toContain("403");
  });
});

test("the agy CLI refuses a --timeout that is not a positive whole number, before anything else", () => {
  const home = mkdtempSync("/tmp/dwa-cli-");
  mkdirSync(join(home, "state"));
  // The stop file keeps a wrong run of this test from ever reaching the real agy.
  writeFileSync(join(home, "state", "agy-stopped.json"), '{"why":"test"}\n');
  writeFileSync(join(home, "p.txt"), "본문 요청");
  const run = (timeout: string) =>
    Bun.spawnSync(
      [
        "bun",
        join(import.meta.dir, "../tools/writer_request.ts"),
        "agy",
        "--lane",
        "t",
        "--prompt",
        join(home, "p.txt"),
        "--out",
        join(home, "o.txt"),
        "--timeout",
        timeout,
      ],
      { env: { ...process.env, DORI_HOME: home } },
    );
  for (const bad of ["abc", "0", "-5", "1.5"]) {
    const p = run(bad);
    expect(p.exitCode).toBe(1);
    expect(p.stderr.toString()).toContain("--timeout");
  }
  expect(run("60").exitCode).toBe(EXIT.stopped);
});
