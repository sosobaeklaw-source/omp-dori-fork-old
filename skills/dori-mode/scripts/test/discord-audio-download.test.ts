import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { withLocalAudio } from "../src/cli-discord-ops.ts";

test("a voice download that never answers fails within its limit and leaves no private folder", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
  const ours = () =>
    readdirSync(tmpdir())
      .filter((name) => name.startsWith("dori-audio-"))
      .sort();
  const before = ours();
  try {
    let used = false;
    const started = performance.now();
    const outcome = withLocalAudio(
      `http://127.0.0.1:${server.port}/voice.ogg`,
      async () => {
        used = true;
        return "never";
      },
      50,
    );
    await expect(outcome).rejects.toThrow("could not download audio");
    expect({ used, quick: performance.now() - started < 2_000, left: ours() }).toEqual({
      used: false,
      quick: true,
      left: before,
    });
  } finally {
    server.stop(true);
  }
});
