import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { USAGE } from "../src/cli-args.ts";
import { renderPrompt } from "../src/cli-up.ts";
import { prompt } from "../src/harness.ts";
import { World } from "./fake.ts";

const MARK = "HARNESS-CMD";
// `dori up` renders the first two with `renderPrompt`; the others are filled per lane or per nudge.
const RENDERED_BY_UP = ["lead.md", "duty.md"];
const FILLED = ["lane-footer.md", "nudge.md", "nudge-waiting.md"];

const harnessCommands = (): Set<string> => new Set([...USAGE.matchAll(/^\s+dori harness (\S+)/gm)].map((m) => m[1]!));

const rendered = (name: string): string => {
  if (!RENDERED_BY_UP.includes(name)) return prompt(name, { dori: MARK, key: "k" });
  const d = { ...new World().deps(), doriCmd: MARK };
  return readFileSync(renderPrompt(d, name), "utf8");
};

describe("the commands a prompt gives to `{{dori}}`", () => {
  test("every one is a command of the harness CLI that `{{dori}}` renders to", () => {
    const known = harnessCommands();
    expect(known.has("status")).toBe(true);
    for (const name of [...RENDERED_BY_UP, ...FILLED]) {
      const used = [...rendered(name).matchAll(new RegExp(`${MARK} ([a-z][a-z-]*)`, "g"))].map((m) => m[1]!);
      expect(used.length).toBeGreaterThan(0);
      expect(used.filter((cmd) => !known.has(cmd)).map((cmd) => `${name}: ${cmd}`)).toEqual([]);
    }
  });

  test("the lead prompt gives `boot`, `orders` and `send discord` to the skill command, not to `{{dori}}`", () => {
    const lead = rendered("lead.md");
    for (const cmd of ["boot", "orders", "send discord"]) {
      expect(lead).toContain(`\`dori ${cmd}`);
      expect(lead).not.toContain(`${MARK} ${cmd}`);
    }
  });
});
