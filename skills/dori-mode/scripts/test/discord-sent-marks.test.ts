import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ids, withDiscordCli } from "./discord-fakes.ts";

test("a Discord send with --reply posts as that reply and logs reply= and closes= at the end of its line", async () => {
  await withDiscordCli(async (f) => {
    const log = join(dirname(f.tmp), "discord-sent.log");
    const order = "1572108521254944830";
    const r = await f.invoke([
      "send",
      "discord",
      "--to",
      ids.text,
      "--text",
      "결과",
      "--reply",
      order,
      "--closes",
      order,
    ]);
    expect([r.code, r.out]).toEqual([0, `SENT ${ids.message}`]);
    expect(r.requests.at(-1)!.body).toEqual({
      content: "결과",
      allowed_mentions: { parse: [] },
      message_reference: { message_id: order, fail_if_not_exists: true },
    });
    const promise = await f.invoke(["send", "discord", "--to", ids.text, "--text", "할게", "--reply", order]);
    expect(promise.code).toBe(0);
    expect(readFileSync(log, "utf8")).toBe(
      `${ids.message}\t-\t-\treply=${order}\tcloses=${order}\n${ids.message}\t-\t-\treply=${order}\n`,
    );
    for (const flag of ["--reply", "--closes"]) {
      const bad = await f.invoke(["send", "discord", "--to", ids.text, "--text", "x", flag, "abc"]);
      expect([bad.code, bad.keys, bad.err]).toEqual([1, [], `${flag} must be a positive decimal Discord ID`]);
    }
  });
});
