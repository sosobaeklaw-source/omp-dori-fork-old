/** Made-up client names and salt (no real names, no real salt) as the macmini's hash export writes them. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNameHashes, NAME_HASH_SCHEME, nameHash } from "../src/ready-reply.ts";

export const ROOM = "1571013138764140544";
export const OWNER_MSG = "1571675313379737672";
export const FAKE_SALT = "fake-salt-for-tests";

/** A hash file and a mode-600 salt file as the macmini exports them, in a fresh directory. */
export function hashFiles(names: readonly string[] = ["가나다", "라마바"], salt = FAKE_SALT) {
  const dir = mkdtempSync(join(tmpdir(), "name-hashes-"));
  const hashes = join(dir, "case-name-hashes.json");
  const saltFile = join(dir, "name_hash_salt");
  const lengths = [...new Set(names.map((n) => Array.from(n).length))];
  writeFileSync(
    hashes,
    JSON.stringify({ scheme: NAME_HASH_SCHEME, lengths, hashes: names.map((n) => nameHash(salt, n)) }),
  );
  writeFileSync(saltFile, `${salt}\n`, { mode: 0o600 });
  return { hashes, saltFile };
}

/** The made-up names loaded the way ready_reply loads the real export. */
export function fakeNames() {
  const f = hashFiles();
  return loadNameHashes(f.hashes, f.saltFile);
}
