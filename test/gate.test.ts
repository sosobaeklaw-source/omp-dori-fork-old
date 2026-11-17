import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { mergeGate, review } from "../src/gate.ts";
import type { World } from "./fake.ts";
import { setup } from "./harness-setup.ts";

describe("review + merge gate", () => {
  const head = "a".repeat(40);
  function gh(w: World, checks: unknown[]) {
    w.gh = (argv) => {
      if (argv[1] === "view") return { code: 0, stdout: JSON.stringify({ headRefOid: head }) };
      if (argv[1] === "checks") return { code: 0, stdout: JSON.stringify(checks) };
      if (argv[1] === "merge") return { code: 0, stdout: "" };
      return { code: 1, stdout: "" };
    };
  }

  test("merge is refused without a receipt, with an empty check list, with red checks; allowed at CLEAR + green", async () => {
    const { w, d } = setup();
    gh(w, []);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("no review receipt");
    w.reviewer = () => ({ code: 0, stdout: "HIGH src/a.ts:3 ...\nVERDICT: BLOCK" });
    expect((await review(d, "o/r#7")).verdict).toBe("BLOCK");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("is BLOCK");
    w.reviewer = () => ({ code: 0, stdout: "no findings\nVERDICT: CLEAR" });
    await review(d, "o/r#7", "some/model");
    expect(d.store.receipt("o/r#7", head)!.model).toBe("some/model");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("never green");
    gh(w, [
      { name: "test", bucket: "fail" },
      { name: "lint", bucket: "pass" },
    ]);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("test=fail");
    gh(w, [{ name: "test", bucket: "skipping" }]);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("every check was skipped");
    gh(w, [
      { name: "test", bucket: "pass" },
      { name: "docs", bucket: "skipping" },
    ]);
    expect(await mergeGate(d, "o/r#7")).toBe(`MERGED o/r#7 head=${head}`);
    expect(w.calls.at(-1)!.argv).toContain("--match-head-commit");
    expect(
      w.usage.filter((e) => e.name === "dori.merge_decided").map((e) => (e as { outcome: string }).outcome),
    ).toEqual(["no_receipt", "review_block", "no_checks", "checks_red", "checks_all_skipped", "merged"]);
    expect(w.usage.filter((e) => e.name === "dori.review_completed")).toHaveLength(2);
  });

  test("the receipt keeps the whole summary, and a PR view behind the pushed head follows refs/pull/<n>/head, never a branch name", async () => {
    const { w, d } = setup();
    const pushed = "b".repeat(40);
    const decoy = "c".repeat(40);
    w.gh = (argv) =>
      argv[1] === "view"
        ? { code: 0, stdout: JSON.stringify({ headRefOid: head, headRefName: "main" }) }
        : { code: 1, stdout: "" };
    const long = `${"x".repeat(5000)}\nVERDICT: CLEAR`;
    w.reviewer = (argv) => {
      if (argv[0] !== "ls-remote") return { code: 0, stdout: long };
      const ref = argv.at(-1);
      if (ref === "refs/pull/10/head") return { code: 0, stdout: `${pushed}\trefs/pull/10/head\n` };
      return { code: 0, stdout: `${decoy}\t${ref}\n` };
    };
    expect(await review(d, "o/r#10")).toEqual({ verdict: "CLEAR", sha: pushed });
    expect(d.store.receipt("o/r#10", head)).toBeUndefined();
    expect(d.store.receipt("o/r#10", pushed)!.summary).toBe(long);
    expect(readdirSync(join(d.store.root, "receipts")).filter((n) => n.endsWith(".full.txt"))).toEqual([]);
    const asked = w.calls.filter((c) => c.argv[0] === "ls-remote").map((c) => c.argv);
    expect(asked).toEqual([["ls-remote", "https://github.com/o/r.git", "refs/pull/10/head"]]);
  });

  test("a summary over 64 KB keeps its tail and the verdict in the receipt, says so, and the whole output sits beside it", async () => {
    const { w, d } = setup();
    gh(w, []);
    const huge = `HEAD-MARK\n${"y".repeat(70_000)}\nVERDICT: BLOCK`;
    w.reviewer = (argv) => (argv[0] === "ls-remote" ? { code: 1, stdout: "" } : { code: 0, stdout: huge });
    expect(await review(d, "o/r#12")).toEqual({ verdict: "BLOCK", sha: head });
    const summary = d.store.receipt("o/r#12", head)!.summary;
    const whole = join(d.store.root, "receipts", `o__r_12@${head}.full.txt`);
    expect(summary.length).toBeLessThan(65_536 + 300);
    expect(summary).toStartWith(
      `[output cut to its last 65536 of ${huge.length} characters; the whole output is in ${whole}]\n`,
    );
    expect(summary).toEndWith("\nVERDICT: BLOCK");
    expect(summary).not.toContain("HEAD-MARK");
    expect(readFileSync(whole, "utf8")).toBe(huge);
    expect(statSync(whole).mode & 0o777).toBe(0o600);
  });

  test("an ls-remote that fails leaves the PR view's head", async () => {
    const { w, d } = setup();
    gh(w, []);
    w.reviewer = (argv) =>
      argv[0] === "ls-remote" ? { code: 128, stdout: "" } : { code: 0, stdout: "VERDICT: CLEAR" };
    expect(await review(d, "o/r#11")).toEqual({ verdict: "CLEAR", sha: head });
  });

  test("exit 0 without a VERDICT line: bounded stdout tail kept privately, no receipt", async () => {
    const { w, d } = setup();
    gh(w, []);
    const lines = Array.from({ length: 205 }, (_, i) => `line-${i + 1}`);
    w.reviewer = () => ({ code: 0, stdout: lines.join("\n") });
    const failure: unknown = await review(d, "o/r#8").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(Error);
    const files = readdirSync(join(d.store.root, "receipts")).filter((n) => n.endsWith(".noverdict.txt"));
    expect(files).toHaveLength(1);
    const name = files[0];
    if (!name || !(failure instanceof Error)) throw new Error("missing diagnostic file or review error");
    expect(name).toStartWith(`o__r_8@${head}`);
    const diagnostic = join(d.store.root, "receipts", name);
    expect(failure.message).toContain("no VERDICT");
    expect(failure.message).toContain(diagnostic);
    expect(statSync(diagnostic).mode & 0o777).toBe(0o600);
    expect(readFileSync(diagnostic, "utf8").split("\n")).toEqual(lines.slice(5));
    expect(d.store.receipt("o/r#8", head)).toBeUndefined();
  });

  test("nonzero exit without a VERDICT line: stdout tail kept too, exit code in the error, no receipt", async () => {
    const { w, d } = setup();
    gh(w, []);
    w.reviewer = () => ({ code: 9, stdout: "partial reviewer output" });
    const failure: unknown = await review(d, "o/r#9").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(Error);
    const files = readdirSync(join(d.store.root, "receipts")).filter((n) => n.endsWith(".noverdict.txt"));
    expect(files).toHaveLength(1);
    const name = files[0];
    if (!name || !(failure instanceof Error)) throw new Error("missing diagnostic file or review error");
    const diagnostic = join(d.store.root, "receipts", name);
    expect(failure.message).toContain("reviewer exited 9");
    expect(failure.message).toContain(diagnostic);
    expect(readFileSync(diagnostic, "utf8")).toBe("partial reviewer output");
    expect(statSync(diagnostic).mode & 0o777).toBe(0o600);
    expect(d.store.receipt("o/r#9", head)).toBeUndefined();
  });
});
