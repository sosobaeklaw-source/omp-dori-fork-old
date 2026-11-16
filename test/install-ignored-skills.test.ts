import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setup } from "./install-setup.ts";

test("config.json laneIgnoredSkills joins dori-mode in the side omp.yml ignoredSkills; a bad name stops the install", () => {
  // Given a side install already made.
  const { home, install } = setup();
  expect(install({ DORI_INSTALL_MODE: "side" }).code).toBe(0);
  const side = join(home, ".omp-dori");
  const omp = () => readFileSync(join(side, "omp.yml"), "utf8");
  const setIgnored = (names: unknown[]) => {
    const config = JSON.parse(readFileSync(join(side, "config.json"), "utf8"));
    writeFileSync(join(side, "config.json"), JSON.stringify({ ...config, laneIgnoredSkills: names }));
  };
  expect(omp()).toContain("  ignoredSkills:\n    - dori-mode\n  customDirectories:\n");
  // When config.json names skills to ignore, dori-mode among them, and the install runs again.
  setIgnored(["nba", "re0-work", "dori-mode"]);
  expect(install({ DORI_INSTALL_MODE: "side" }).code).toBe(0);
  // Then dori-mode stays listed once and the other names follow it, before the side skill directory.
  expect(omp()).toContain("  ignoredSkills:\n    - dori-mode\n    - nba\n    - re0-work\n  customDirectories:\n");
  // And a name that is not a skill name stops the install before omp.yml is rewritten.
  setIgnored(["bad name"]);
  const r = install({ DORI_INSTALL_MODE: "side" });
  expect(r.code).toBe(1);
  expect(r.err).toContain("laneIgnoredSkills");
  expect(omp()).toContain("    - re0-work\n");
});
