import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lockDir } from "../src/lock-owner.ts";
import { ownPath, quotaPath } from "../src/agy-own.ts";
import { AgyStop, EXIT, GAP_MS, sendOnAgy, stopPath } from "../src/writer-agy.ts";
import { FORBIDDEN, LINKED, NOW, OTHER_MAIL, ok, SEAT_MAIL, setup } from "./agy-fake.ts";

describe("agy writer seat", () => {
  test("a plain answer is written; the request goes as a file with a short prompt; one agy-s4 line is logged", async () => {
    const { env, opts, calls, tsv, home } = setup([ok("본문입니다.")]);
    expect(await sendOnAgy(env, opts)).toBe(EXIT.ok);
    expect(readFileSync(opts.out, "utf8")).toBe("본문입니다.\n");
    expect(calls[0]!.request).toBe("본문 요청");
    expect(calls[0]!.args).toEqual(
      expect.arrayContaining(["-p", "--sandbox", "--mode", "plan", "--output-format", "json"]),
    );
    expect(calls[0]!.args[1]!.length).toBeLessThan(60);
    expect(tsv()).toHaveLength(1);
    expect(tsv()[0]!.split("\t").slice(1, 3).concat(tsv()[0]!.split("\t")[5]!)).toEqual(["agy-s4", "new", "답 6자"]);
    expect(existsSync(lockDir(home, "agy-s4"))).toBe(false);
  });

  test("the next call waits until 60 s after the previous one ended", async () => {
    const { env, opts, calls, advance } = setup([ok("하나"), ok("둘")]);
    await sendOnAgy(env, opts);
    advance(5_000);
    await sendOnAgy(env, opts);
    expect(calls[1]!.at - (calls[0]!.at + 30_000)).toBeGreaterThanOrEqual(GAP_MS);
  });

  test("a file-linked answer is dropped and asked exactly once more", async () => {
    const { env, opts, calls, tsv } = setup([LINKED, ok("본문")]);
    expect(await sendOnAgy(env, opts)).toBe(EXIT.ok);
    expect(calls).toHaveLength(2);
    expect(readFileSync(opts.out, "utf8")).toBe("본문\n");
    expect(tsv().map((l) => l.split("\t")[2])).toEqual(["new", "retry"]);
    expect(tsv()[0]).toContain("파일 링크, 버림");
  });

  test("two file-linked answers end with no answer and no third call", async () => {
    const { env, opts, calls } = setup([LINKED, LINKED, ok("셋째")]);
    expect(await sendOnAgy(env, opts)).toBe(EXIT.linked);
    expect(calls).toHaveLength(2);
    expect(existsSync(opts.out)).toBe(false);
  });

  test("a 403 stops the seat: no retry, and every later send is refused without calling agy", async () => {
    const { env, opts, calls, home, tsv } = setup([FORBIDDEN, ok("다음")]);
    await expect(sendOnAgy(env, opts)).rejects.toMatchObject({ code: EXIT.forbidden });
    expect(existsSync(stopPath(home))).toBe(true);
    expect(tsv()[0]).toContain("403 정지");
    await expect(sendOnAgy(env, opts)).rejects.toMatchObject({ code: EXIT.stopped });
    expect(calls).toHaveLength(1);
  });

  test("no daily count of our own: call 21 of a KST day still goes out", async () => {
    const answers = Array.from({ length: 21 }, () => ok("본문"));
    const { env, opts, calls } = setup(answers);
    for (let i = 0; i < 21; i++) expect(await sendOnAgy(env, opts)).toBe(EXIT.ok);
    expect(calls).toHaveLength(21);
  });

  test("Google's quota error ends the send with exit 26 and its message logged; no retry, no stop file", async () => {
    const quota = {
      code: 1,
      stdout: JSON.stringify({
        status: "ERROR",
        response: "",
        error: "RESOURCE_EXHAUSTED (code 429): Quota exceeded. Your quota will reset after 3h12m.",
      }),
      stderr: "",
    };
    const { env, opts, calls, home, tsv } = setup([quota, ok("다음")]);
    const err = await sendOnAgy(env, opts).catch((e: AgyStop) => e);
    expect(err).toBeInstanceOf(AgyStop);
    expect((err as AgyStop).code).toBe(EXIT.quota);
    expect((err as AgyStop).message).toContain(quotaPath(home));
    expect(calls).toHaveLength(1);
    expect(existsSync(stopPath(home))).toBe(false);
    expect(tsv()[0]).toContain("구글 한도");
    const [line] = readFileSync(quotaPath(home), "utf8").trim().split("\n");
    expect(line!.split("\t").slice(1)).toEqual([
      "t",
      "RESOURCE_EXHAUSTED (code 429): Quota exceeded. Your quota will reset after 3h12m.",
    ]);
    expect(line!.split("\t")[0]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  });

  test("another account logged into agy stops the seat before any call", async () => {
    const { env, opts, calls, home } = setup([ok("본문")], OTHER_MAIL);
    await expect(sendOnAgy(env, opts)).rejects.toMatchObject({ code: EXIT.account });
    expect(calls).toHaveLength(0);
    expect(existsSync(stopPath(home))).toBe(true);
  });

  test("a call agy's logs did not record stops the seat; no retry, no later call", async () => {
    const { env, opts, calls, home, tsv } = setup([LINKED, ok("다음")]);
    env.runLog = () => undefined;
    await expect(sendOnAgy(env, opts)).rejects.toMatchObject({ code: EXIT.unlogged });
    expect(calls).toHaveLength(1);
    expect(tsv()).toHaveLength(1);
    await expect(sendOnAgy(env, opts)).rejects.toMatchObject({ code: EXIT.stopped });
    expect(existsSync(stopPath(home))).toBe(true);
  });

  test("with agy's logs reading nothing, the seat's own last call still holds the gap", async () => {
    const { env, opts, calls, home } = setup([ok("본문")]);
    env.usage = () => ({ lastEndAt: 0, running: false, forbidden: false });
    writeFileSync(ownPath(home), JSON.stringify({ lastAt: NOW - 10_000 }));
    expect(await sendOnAgy(env, opts)).toBe(EXIT.ok);
    expect(calls[0]!.at).toBeGreaterThanOrEqual(NOW - 10_000 + GAP_MS);
    expect(calls).toHaveLength(1);
  });

  test("a held lock makes the send wait instead of running a second agy at once", async () => {
    const { env, opts, calls, home } = setup([ok("본문")]);
    mkdirSync(lockDir(home, "agy-s4"));
    writeFileSync(join(lockDir(home, "agy-s4"), "owner"), `other 2026-11-16 19:00:00 pid=${process.pid}\n`);
    let slept = 0;
    const p = sendOnAgy(
      {
        ...env,
        sleep: async (ms) => {
          slept += ms;
          if (slept >= 40_000) Bun.spawnSync(["rm", "-rf", lockDir(home, "agy-s4")]);
          await env.sleep(ms);
        },
      },
      opts,
    );
    expect(await p).toBe(EXIT.ok);
    expect(slept).toBeGreaterThanOrEqual(40_000);
    expect(calls).toHaveLength(1);
  });

  test("a lane waiting on the lock sends nothing when the holder got a 403 and stopped the seat", async () => {
    const { env, opts, calls, home } = setup([ok("본문")]);
    mkdirSync(lockDir(home, "agy-s4"));
    writeFileSync(join(lockDir(home, "agy-s4"), "owner"), `other 2026-11-16 19:00:00 pid=${process.pid}\n`);
    const waiting = {
      ...env,
      sleep: async (ms: number) => {
        // The holder's call ends in a 403: it writes the stop file, then lets the lock go.
        writeFileSync(stopPath(home), '{"why":"403"}\n');
        Bun.spawnSync(["rm", "-rf", lockDir(home, "agy-s4")]);
        await env.sleep(ms);
      },
    };
    await expect(sendOnAgy(waiting, opts)).rejects.toMatchObject({ code: EXIT.stopped });
    expect(calls).toHaveLength(0);
  });

  test("agy signed in as another account after the call stops the seat", async () => {
    let account = SEAT_MAIL;
    const { env, opts, home } = setup([ok("본문"), ok("다음")]);
    const env2 = { ...env, account: () => account };
    const run = env.run;
    env2.run = async (...args) => {
      const r = await run(...args);
      account = OTHER_MAIL;
      return r;
    };
    await expect(sendOnAgy(env2, opts)).rejects.toMatchObject({ code: EXIT.account });
    expect(existsSync(stopPath(home))).toBe(true);
  });

  test("runs other lanes made outside this seat count toward the gap", async () => {
    const recent = setup([ok("본문")], undefined, { lastEndAt: NOW - 10_000, running: false, forbidden: false });
    expect(await sendOnAgy(recent.env, recent.opts)).toBe(EXIT.ok);
    expect(recent.calls[0]!.at).toBeGreaterThanOrEqual(NOW - 10_000 + GAP_MS);
  });

  test("an agy -p running outside this lock makes the send wait until it is gone", async () => {
    const { env, opts, calls, others } = setup([ok("본문")]);
    others.running = true;
    let slept = 0;
    const p = sendOnAgy(
      {
        ...env,
        sleep: async (ms) => {
          slept += ms;
          if (slept >= 40_000 && others.running) {
            others.running = false;
            others.lastEndAt = env.now() + ms;
          }
          await env.sleep(ms);
        },
      },
      opts,
    );
    expect(await p).toBe(EXIT.ok);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.at).toBeGreaterThanOrEqual(NOW + 40_000 + GAP_MS);
  });

  test("a 403 another lane got on s4 outside this seat stops the seat before any call", async () => {
    const { env, opts, calls, home } = setup([ok("본문")], undefined, {
      lastEndAt: 0,
      running: false,
      forbidden: true,
    });
    await expect(sendOnAgy(env, opts)).rejects.toMatchObject({ code: EXIT.forbidden });
    expect(calls).toHaveLength(0);
    expect(existsSync(stopPath(home))).toBe(true);
  });

  test("a 403 printed as plain text, not JSON, still stops the seat", async () => {
    const plain = { code: 1, stdout: "PERMISSION_DENIED (code 403): This service has been disabled", stderr: "" };
    const { env, opts, calls, home } = setup([plain, ok("다음")]);
    await expect(sendOnAgy(env, opts)).rejects.toMatchObject({ code: EXIT.forbidden });
    expect(calls).toHaveLength(1);
    expect(existsSync(stopPath(home))).toBe(true);
  });

  test("another account with no state folder yet still stops the seat with an ESCALATE, not a crash", async () => {
    const { env, opts, home } = setup([ok("본문")], OTHER_MAIL);
    rmSync(join(home, "state"), { recursive: true });
    await expect(sendOnAgy(env, opts)).rejects.toMatchObject({ code: EXIT.account });
    expect(existsSync(stopPath(home))).toBe(true);
  });
});
