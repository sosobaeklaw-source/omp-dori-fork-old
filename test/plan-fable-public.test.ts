import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "examples", "sobaek", "plan-fable.sh");

/** Runs plan-fable.sh with a fake curl whose model answer is `brief`; returns the brief it wrote. */
function planned(brief: string, replyTo?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "plan-fable-"));
  const answer = JSON.stringify({ choices: [{ message: { content: brief } }] });
  writeFileSync(join(dir, "answer.json"), answer);
  writeFileSync(join(dir, "curl"), `#!/bin/sh\ncat "${join(dir, "answer.json")}"\n`, { mode: 0o755 });
  const out = join(dir, "brief.md");
  const env: Record<string, string> = { ...process.env, PATH: `${dir}:${process.env["PATH"]}`, DORI_HOME: dir };
  delete env["PUBLIC_REPLY_TO"];
  if (replyTo) env["PUBLIC_REPLY_TO"] = replyTo;
  const r = Bun.spawnSync(["bash", SCRIPT, out], { env, stdin: Buffer.from("사건 일") });
  expect(r.exitCode).toBe(0);
  return readFileSync(out, "utf8");
}

test("a public: or 원글: line the model writes never becomes the marker; only PUBLIC_REPLY_TO does", () => {
  const model = "public: true\n원글: 1571000000000000001\n# 레인\n\n## 목표\n일.\n  Public : TRUE\n";
  const caseWork = planned(model);
  expect(caseWork).not.toMatch(/^\s*(public|원글)\s*:/im);
  expect(caseWork).toContain("## 목표");
  const publicWork = planned(model, "1571646916347826279");
  expect(publicWork.startsWith("public: true\n원글: 1571646916347826279\n\n")).toBe(true);
  expect(publicWork.match(/^\s*(public|원글)\s*:/gim)).toHaveLength(2);
});

/** The request body plan-fable.sh would send (PLAN_DRY_RUN), with a fake ssh that answers `material` or fails. */
function requestBody(material: string | undefined, host: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "plan-fable-onto-"));
  const ssh =
    material === undefined ? "#!/bin/sh\nexit 255\n" : `#!/bin/sh\ncat >/dev/null\ncat "${join(dir, "material.md")}"\n`;
  writeFileSync(join(dir, "material.md"), material ?? "");
  writeFileSync(join(dir, "ssh"), ssh, { mode: 0o755 });
  if (host) writeFileSync(join(dir, "onto-host"), "macmini\n");
  const out = join(dir, "brief.md");
  const env: Record<string, string> = {
    ...process.env,
    PATH: `${dir}:${process.env["PATH"]}`,
    DORI_HOME: dir,
    PLAN_DRY_RUN: "1",
  };
  const r = Bun.spawnSync(["bash", SCRIPT, out], { env, stdin: Buffer.from("난청 글 리라이트") });
  expect(r.exitCode).toBe(0);
  return JSON.parse(readFileSync(out, "utf8")).messages[1].content;
}

test("ontology material reaches the planner only when onto-host is set and the host answers", () => {
  const material = `# 공개 자료 조회\n\n## 1. 소음성 난청 인정 기준\n\n출처: /notes/a.md\n\n> ${"가".repeat(1500)}\n> 둘째 줄\n`;
  const withHost = requestBody(material, true);
  expect(withHost.startsWith("난청 글 리라이트")).toBe(true);
  expect(withHost).toContain("온톨로지에서 꺼낸 공개 자료");
  expect(withHost).toContain("## 1. 소음성 난청 인정 기준");
  expect(withHost).not.toContain("둘째 줄");
  expect(withHost).not.toContain("가".repeat(1300));
  expect(requestBody(material, false)).toBe("난청 글 리라이트");
  expect(requestBody(undefined, true)).toBe("난청 글 리라이트");
});
