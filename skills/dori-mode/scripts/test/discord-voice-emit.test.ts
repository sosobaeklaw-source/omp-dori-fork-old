import { expect, test } from "bun:test";

test("an opted-in transcriber fills an empty voice message; text, non-voice, no transcriber, failure and timeout pass through", async () => {
  const { voiceEmit } = await import("../src/cli-discord.ts");
  const voice = {
    channel: "1",
    message: "2",
    reference: null,
    text: "",
    replyTo: null,
    attachments: [{ filename: "voice-message.ogg", size: 9, url: "https://cdn.example/v.ogg", voice: true as const }],
  };
  const opts = { prefix: "[heard] ", deadlineMs: 50 };
  const printed: string[] = [];
  const warned: string[] = [];
  const kept: string[] = [];
  const print = (shown: { text: string }, sent: { text: string }) => {
    printed.push(shown.text);
    kept.push(sent.text); // What a verbatim record (the correction ledger) gets: never the transcript.
  };
  const warn = (l: string) => void warned.push(l);
  const heard = voiceEmit(print, async (url) => `들은 말 ${url}`, warn, opts);
  await heard(voice);
  await heard({ ...voice, text: "글로 쓴 지시" });
  await heard({ ...voice, attachments: [{ filename: "a.png", size: 1, url: "https://cdn.example/a.png" }] });
  expect(voiceEmit(print, undefined, warn, opts)(voice)).toBeUndefined(); // No transcriber: printed at once.
  await voiceEmit(print, async () => Promise.reject(new Error("empty transcript")), warn, opts)(voice);
  await voiceEmit(print, () => new Promise<string>(() => {}), warn, opts)(voice);
  expect(printed).toEqual(["[heard] 들은 말 https://cdn.example/v.ogg", "글로 쓴 지시", "", "", "", ""]);
  expect(kept).toEqual(["", "글로 쓴 지시", "", "", "", ""]);
  expect(warned).toEqual(["WARN transcribe 2: empty transcript", "WARN transcribe 2: timed out after 0.05s"]);
});
