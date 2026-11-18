import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { quotaPath } from "../src/agy-own.ts";
import { AgyStop, EXIT, sendOnAgy, stopPath } from "../src/writer-agy.ts";
import { FORBIDDEN, LINKED, OTHER_MAIL, ok, setup } from "./agy-fake.ts";

describe("agy writer seat", () => {
  test("a plain answer is written; the request goes as a file with a short prompt; one agy-s4 line is logged", async () => {
    const { env, opts, calls, tsv } = setup([ok("본문입니다.")]);
    expect(await sendOnAgy(env, opts)).toBe(EXIT.ok);
    expect(readFileSync(opts.out, "utf8")).toBe("본문입니다.\n");
    expect(calls[0]!.request).toBe("본문 요청");
    expect(calls[0]!.args).toEqual(
      expect.arrayContaining(["-p", "--sandbox", "--mode", "plan", "--output-format", "json"]),
    );
    expect(calls[0]!.args[1]!.length).toBeLessThan(60);
    expect(tsv()).toHaveLength(1);
    expect(tsv()[0]!.split("\t").slice(1, 3).concat(tsv()[0]!.split("\t")[5]!)).toEqual(["agy-s4", "new", "답 6자"]);
  });

  test("two sends on one home both enter agy together, even with a recent last run and the old lock files left behind", async () => {
    const { home, env, opts, calls } = setup([ok("하나"), ok("둘")]);
    writeFileSync(join(home, "state", "agy-s4.lock"), `${process.pid} ${Date.now()}\n`);
    writeFileSync(join(home, "state", "agy-s4.json"), JSON.stringify({ lastEndAt: Date.now() }));
    let entered = 0;
    const gate = Promise.withResolvers<void>();
    const real = env.run;
    env.run = async (args, cwd) => {
      if (++entered === 2) gate.resolve();
      await gate.promise;
      return real(args, cwd);
    };
    const b = { ...opts, lane: "b", out: join(home, "b.txt"), meta: join(home, "b.meta.json") };
    const [ra, rb] = await Promise.all([sendOnAgy(env, opts), sendOnAgy(env, b)]);
    expect([ra, rb]).toEqual([EXIT.ok, EXIT.ok]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.at).toBe(calls[1]!.at);
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

  test("a 403 another lane got on s4 outside this seat stops the seat before any call", async () => {
    const { env, opts, calls, home } = setup([ok("본문")], undefined, { forbidden: true });
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

  test("agy signed in as another account after the call stops the seat", async () => {
    let account = "seat@example.com";
    const { env, opts, home } = setup([ok("본문"), ok("다음")]);
    env.account = () => account;
    const real = env.run;
    env.run = async (args, cwd) => {
      const r = await real(args, cwd);
      account = OTHER_MAIL;
      return r;
    };
    await expect(sendOnAgy(env, opts)).rejects.toMatchObject({ code: EXIT.account });
    expect(existsSync(stopPath(home))).toBe(true);
  });
});
