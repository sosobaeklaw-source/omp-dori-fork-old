import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Refusal } from "../src/refusal.ts";
import { checkApproval, writeApproval } from "../src/publish-gate.ts";

// ig-replace-1117 (2026-11-18): a lane published a card version and deleted an old post on Instagram with only
// prose approval in its brief, plus an unbriefed profile swap. The gate refuses every external publish/delete
// whose exact artifact hashes have no lead-written approval record; the owner's go message id is recorded.

function world(artifacts: string[] = ["a.png", "b.png"]) {
  const home = mkdtempSync(join(tmpdir(), "publish-gate-"));
  const files = artifacts.map((name, i) => {
    const p = join(home, name);
    writeFileSync(p, `card ${i}\n`);
    return p;
  });
  return { home, files, clean: () => rmSync(home, { recursive: true, force: true }) };
}

describe("publish gate", () => {
  test("refuses an unapproved publish (the ig-replace-1117 failure)", () => {
    const w = world();
    try {
      expect(() => checkApproval(w.home, { channel: "instagram", action: "publish", artifacts: w.files })).toThrow(
        Refusal,
      );
    } finally {
      w.clean();
    }
  });

  test("passes the approved artifact set and any subset of it", () => {
    const w = world();
    try {
      writeApproval(w.home, {
        channel: "instagram",
        action: "publish",
        ownerMessageId: "1572354757719363670",
        artifacts: w.files,
      });
      const hit = checkApproval(w.home, { channel: "instagram", action: "publish", artifacts: [w.files[0]!] });
      expect(hit.ownerMessageId).toBe("1572354757719363670");
      const all = checkApproval(w.home, { channel: "instagram", action: "publish", artifacts: w.files });
      expect(all.artifacts).toHaveLength(2);
    } finally {
      w.clean();
    }
  });

  test("refuses a changed card version (sha256 mismatch after approval)", () => {
    const w = world();
    try {
      writeApproval(w.home, {
        channel: "instagram",
        action: "publish",
        ownerMessageId: "m1",
        artifacts: w.files,
      });
      writeFileSync(w.files[0]!, "card 0 EDITED\n");
      expect(() => checkApproval(w.home, { channel: "instagram", action: "publish", artifacts: w.files })).toThrow(
        Refusal,
      );
    } finally {
      w.clean();
    }
  });

  test("channel-agnostic: approval for one channel does not open another (x, tiktok later)", () => {
    const w = world();
    try {
      writeApproval(w.home, {
        channel: "instagram",
        action: "publish",
        ownerMessageId: "m1",
        artifacts: w.files,
      });
      expect(() => checkApproval(w.home, { channel: "x", action: "publish", artifacts: w.files })).toThrow(Refusal);
      expect(() => checkApproval(w.home, { channel: "tiktok", action: "publish", artifacts: w.files })).toThrow(
        Refusal,
      );
    } finally {
      w.clean();
    }
  });

  test("refuses delete without its own approval record", () => {
    const w = world();
    try {
      writeApproval(w.home, {
        channel: "instagram",
        action: "publish",
        ownerMessageId: "m1",
        artifacts: w.files,
      });
      expect(() => checkApproval(w.home, { channel: "instagram", action: "delete", artifacts: w.files })).toThrow(
        Refusal,
      );
    } finally {
      w.clean();
    }
  });

  test("refuses an artifact outside the approved set", () => {
    const w = world(["a.png"]);
    try {
      writeApproval(w.home, { channel: "instagram", action: "publish", ownerMessageId: "m1", artifacts: w.files });
      const extra = join(w.home, "c.png");
      writeFileSync(extra, "an extra card\n");
      expect(() => checkApproval(w.home, { channel: "instagram", action: "publish", artifacts: [extra] })).toThrow(
        Refusal,
      );
    } finally {
      w.clean();
    }
  });

  test("writeApproval refuses a missing owner message id", () => {
    const w = world();
    try {
      expect(() =>
        writeApproval(w.home, { channel: "instagram", action: "publish", ownerMessageId: " ", artifacts: w.files }),
      ).toThrow(Refusal);
    } finally {
      w.clean();
    }
  });
});
