import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { ledgerPath, pairEntry } from "../src/writer-ledger.ts";
import { LEDGER, setup } from "./writer-request-setup.ts";

describe("writer ledger", () => {
  test("pair puts 전/후 under the entry's 원문 line once, leaves the rest as it was, and refuses a second time", () => {
    const { home } = setup();
    pairEntry({ home, msg: "101", before: "b1", after: "a1" });
    expect(readFileSync(ledgerPath(home), "utf8")).toBe(
      LEDGER.replace('원문: "seo only rejection"\n', '원문: "seo only rejection"\n전: "b1"\n후: "a1"\n'),
    );
    expect(() => pairEntry({ home, msg: "101", before: "x", after: "y" })).toThrow("already has");
    expect(() => pairEntry({ home, msg: "107", before: "x", after: "y" })).toThrow("already has");
    expect(() => pairEntry({ home, msg: "999", before: "x", after: "y" })).toThrow("not in the ledger");
  });

  test("pair goes after the last line of a 원문 that runs over several lines, not inside it", () => {
    const { home } = setup();
    const many = '\n## 2026-01-03 09:00 · card · msg 108 · post -\n원문: "first line\n\nsecond line\nlast line"\n';
    writeFileSync(ledgerPath(home), LEDGER + many);
    pairEntry({ home, msg: "108", before: "b", after: "a" });
    expect(readFileSync(ledgerPath(home), "utf8")).toBe(
      `${LEDGER}\n## 2026-01-03 09:00 · card · msg 108 · post -\n원문: "first line\n\nsecond line\nlast line"\n전: "b"\n후: "a"\n`,
    );
  });

  test("a 원문 line starting with 전: is the owner's words, and a value that opens a new entry is refused untouched", () => {
    const { home } = setup();
    const quoted = '\n## 2026-01-03 09:00 · card · msg 109 · post -\n원문: "고쳐라\n전: "이렇게 쓰지 마""\n';
    writeFileSync(ledgerPath(home), LEDGER + quoted);
    pairEntry({ home, msg: "109", before: "b", after: "a" });
    expect(readFileSync(ledgerPath(home), "utf8")).toEndWith(
      '원문: "고쳐라\n전: "이렇게 쓰지 마""\n전: "b"\n후: "a"\n',
    );
    const was = readFileSync(ledgerPath(home), "utf8");
    expect(() =>
      pairEntry({ home, msg: "101", before: "b", after: 'a"\n\n## 2026-01-04 09:00 · seo · msg 9 · post -' }),
    ).toThrow("must not start a new ledger entry");
    expect(readFileSync(ledgerPath(home), "utf8")).toBe(was);
  });
});
