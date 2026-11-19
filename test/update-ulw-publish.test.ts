import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishUlwCandidate } from "../scripts/update-ulw-publish.ts";
import { prepareUlwUpdate } from "../src/release/source-bundle-update.ts";
import { fixtureGit, overlayFixture } from "./source-bundle-setup.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ulw-publish-")));
  roots.push(root);
  const source = join(root, "source");
  const remote = join(root, "upstream");
  const old = overlayFixture(source, remote);
  fixtureGit(remote, "branch", "-M", "main");
  fixtureGit(source, "init", "--quiet");
  fixtureGit(source, "add", ".");
  fixtureGit(source, "commit", "--quiet", "-m", "Pinned bundle");
  fixtureGit(remote, "reset", "--hard", old.commit);
  writeFileSync(join(remote, "new.ts"), "export {};\n");
  fixtureGit(remote, "add", ".");
  fixtureGit(remote, "commit", "--quiet", "-m", "Next upstream");
  const directory = join(root, "candidate");
  const candidate = (await prepareUlwUpdate(source, directory, remote))!;
  const branch = `automation/ulw-${candidate.commit}-${candidate.previousIdentity.slice(0, 12)}`;
  const commit = "c".repeat(40),
    tree = "d".repeat(40);
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const state = {
    branch: false,
    pull: undefined as { state: string; html_url: string; head: { sha: string } } | undefined,
    runs: [] as { head_sha: string }[],
    main: candidate.sourceCommit,
    foreign: false,
    dispatchFail: false,
  };
  const api = async (path: string, method = "GET", body?: unknown): Promise<unknown> => {
    calls.push({ path, method, body });
    if (path.endsWith("/git/ref/heads/main")) return { object: { sha: state.main } };
    if (path.endsWith(`/git/commits/${candidate.sourceCommit}`)) return { tree: { sha: "b".repeat(40) } };
    if (path.endsWith("/git/blobs")) return { sha: "e".repeat(40) };
    if (path.endsWith("/git/trees")) return { sha: tree };
    if (path.includes("/git/matching-refs/"))
      return state.branch ? [{ ref: `refs/heads/${branch}`, object: { sha: commit } }] : [];
    if (path.endsWith(`/git/commits/${commit}`))
      return { tree: { sha: state.foreign ? "f".repeat(40) : tree }, parents: [{ sha: candidate.sourceCommit }] };
    if (path.endsWith("/git/commits")) return { sha: commit };
    if (path.endsWith("/git/refs")) {
      state.branch = true;
      return {};
    }
    if (path.includes("/pulls?")) return state.pull ? [state.pull] : [];
    if (path.endsWith("/pulls")) {
      state.pull = { state: "open", html_url: "https://github.com/vntrevx/omp-dori/pull/999", head: { sha: commit } };
      return state.pull;
    }
    if (path.includes("/runs?")) return { workflow_runs: state.runs };
    if (path.endsWith(`/git/ref/heads/${branch}`)) return { object: { sha: commit } };
    if (path.endsWith("/dispatches")) {
      if (state.dispatchFail) throw new Error("Dispatch unavailable");
      state.runs.push({ head_sha: commit });
      return undefined;
    }
    throw new Error(`Unexpected API: ${method} ${path}`);
  };
  return { source, directory, candidate, branch, commit, calls, state, api };
}

test("publication changes only three metadata blobs on a new draft branch and dispatches exact-head CI", async () => {
  const f = await fixture();
  const url = await publishUlwCandidate(f.source, f.directory, f.api);
  expect(url).toEndWith("/999");
  const tree = f.calls.find((call) => call.path.endsWith("/git/trees"))!.body as { tree: { path: string }[] };
  expect(tree.tree.map((entry) => entry.path)).toEqual(["omp-ulw.lock", "omp-ulw.overlay.lock", "omp-ulw.patch"]);
  expect(f.calls.find((call) => call.path.endsWith("/pulls"))!.body).toMatchObject({
    draft: true,
    head: f.branch,
    base: "main",
  });
  expect(f.calls.find((call) => call.path.endsWith("/dispatches"))!.body).toEqual({ ref: f.branch });
  expect(f.calls.some((call) => call.method === "PATCH" || /merge|releases|tags/.test(call.path))).toBe(false);
  f.calls.length = 0;
  expect(await publishUlwCandidate(f.source, f.directory, f.api)).toBe(url);
  expect(f.calls.some((call) => /dispatches|\/pulls$|\/git\/refs$|\/git\/commits$/.test(call.path))).toBe(false);
});

test("closed/rejected candidates are never reopened or redispatched", async () => {
  const f = await fixture();
  await publishUlwCandidate(f.source, f.directory, f.api);
  f.state.pull!.state = "closed";
  f.state.runs = [];
  f.calls.length = 0;
  await publishUlwCandidate(f.source, f.directory, f.api);
  expect(f.calls.some((call) => call.path.endsWith("/dispatches") || call.path.endsWith("/pulls"))).toBe(false);
});

test("a PR-created but unstarted CI dispatch recovers without duplicate branches or pull requests", async () => {
  const f = await fixture();
  f.state.dispatchFail = true;
  await expect(publishUlwCandidate(f.source, f.directory, f.api)).rejects.toThrow("Dispatch unavailable");
  f.state.dispatchFail = false;
  f.calls.length = 0;
  await publishUlwCandidate(f.source, f.directory, f.api);
  expect(f.calls.filter((call) => call.path.endsWith("/dispatches"))).toHaveLength(1);
  expect(f.calls.some((call) => /\/git\/refs$|\/pulls$/.test(call.path))).toBe(false);
});

test("main advancement or edited automatic branch is held, never force-pushed", async () => {
  const f = await fixture();
  f.state.main = "f".repeat(40);
  await expect(publishUlwCandidate(f.source, f.directory, f.api)).rejects.toThrow("Main advanced");
  expect(f.calls.some((call) => call.method !== "GET")).toBe(false);
  f.state.main = f.candidate.sourceCommit;
  f.state.branch = true;
  f.state.foreign = true;
  await expect(publishUlwCandidate(f.source, f.directory, f.api)).rejects.toThrow("branch changed");
  expect(f.calls.some((call) => call.method === "PATCH")).toBe(false);
});

test("tampered receipts, bundle bytes, and unexpected artifact paths never reach GitHub", async () => {
  const f = await fixture();
  const receipt = join(f.directory, "candidate.json");
  const original = readFileSync(receipt);
  writeFileSync(receipt, JSON.stringify({ ...f.candidate, commit: "../main" }));
  await expect(publishUlwCandidate(f.source, f.directory, f.api)).rejects.toThrow("receipt");
  writeFileSync(receipt, original);
  writeFileSync(join(f.directory, "foreign.ts"), "throw new Error('must not execute');\n");
  await expect(publishUlwCandidate(f.source, f.directory, f.api)).rejects.toThrow("Unexpected");
  rmSync(join(f.directory, "foreign.ts"));
  writeFileSync(join(f.directory, "omp-ulw.patch"), "tampered\n");
  await expect(publishUlwCandidate(f.source, f.directory, f.api)).rejects.toThrow("digest");
  expect(f.calls).toEqual([]);
});
