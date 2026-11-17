import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Step 5 of owner-now-sync.sh uploads MacBook 독후감·독서메모 to the macmini with -u: a note rewritten after its last
// upload goes up again, a file the macmini already holds newer is kept. This runs the real script end to end over a fake
// ssh that executes the receiver-side rsync locally, so the fake macmini home below is the receiving folder.
const RSYNC = "/opt/homebrew/bin/rsync";
const scriptPath =
  process.env["OWNER_NOW_SYNC_TEST_SCRIPT"] ?? join(import.meta.dir, "../examples/sobaek/owner-now-sync.sh");

// Fixed mtimes, no sleeps: the rewrite (T10) is newer than the macmini v1 (T9) so -u sends it, and older than the
// macmini's own newer copy (T11) so -u keeps that one.
const T9 = new Date("2026-11-17T09:00:00Z");
const T10 = new Date("2026-11-17T10:00:00Z");
const T11 = new Date("2026-11-17T11:00:00Z");

const root = mkdtempSync(join(tmpdir(), "owner-now-sync-upload-"));
const macbookHome = join(root, "home");
const macminiHome = join(root, "mini");
const fakeSshDir = join(root, "bin");
const macbookResults = join(macbookHome, "sobaegi-lead", "results", "wave-e");
const macminiResults = join(macminiHome, "sobaegi-lead", "results", "wave-e");

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const fakeSsh = `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    macmini) shift; break ;;
    *) shift ;;
  esac
done
[ "$#" -gt 0 ] || exit 0
if [ "$1" = rsync ]; then shift; fi
cd "${macminiHome}" || exit 1
exec "${RSYNC}" "$@"
`;

mkdirSync(join(macbookHome, ".omp-dori"), { recursive: true });
mkdirSync(macbookResults, { recursive: true });
mkdirSync(macminiResults, { recursive: true });
mkdirSync(fakeSshDir, { recursive: true });
writeFileSync(join(fakeSshDir, "ssh"), fakeSsh);
chmodSync(join(fakeSshDir, "ssh"), 0o755);

const writeNote = (dir: string, name: string, body: string, at: Date) => {
  const p = join(dir, name);
  writeFileSync(p, body);
  utimesSync(p, at, at);
};

writeNote(macbookResults, "독후감_신규.md", "v1 new note", T10);
writeNote(macbookResults, "독후감_재작성.md", "v2 rewritten", T10);
writeNote(macbookResults, "독후감_미니가새로움.md", "v1 old macbook copy", T10);
writeNote(macminiResults, "독후감_재작성.md", "v1 original", T9);
writeNote(macminiResults, "독후감_미니가새로움.md", "v2 newer macmini copy", T11);

const proc = Bun.spawnSync(["/bin/bash", scriptPath], {
  env: { PATH: `${fakeSshDir}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: macbookHome },
});

describe("owner-now-sync.sh step 5 upload (독후감 올림)", () => {
  test.skipIf(!existsSync(RSYNC))("the script exits 0 and the upload step copied something", () => {
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain("독후감올림");
    expect(proc.stdout.toString()).not.toContain("독후감올림 FAILED");
  });

  test.skipIf(!existsSync(RSYNC))("a note the macmini does not have is sent", () => {
    expect(readFileSync(join(macminiResults, "독후감_신규.md"), "utf8")).toBe("v1 new note");
  });

  test.skipIf(!existsSync(RSYNC))("a note rewritten after upload is sent again", () => {
    expect(readFileSync(join(macminiResults, "독후감_재작성.md"), "utf8")).toBe("v2 rewritten");
  });

  test.skipIf(!existsSync(RSYNC))("a file the macmini holds newer is kept, not overwritten", () => {
    expect(readFileSync(join(macminiResults, "독후감_미니가새로움.md"), "utf8")).toBe("v2 newer macmini copy");
  });
});
