import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Refusal } from "./refusal.ts";

/**
 * The one code safety line for sending work OUT (2026-11-18, after ig-replace-1117 published and deleted on
 * Instagram with only prose approval in its brief): a lane may publish or delete on an external channel
 * (Instagram, X, TikTok, a website — any channel string) only after publish-check passes. The lead writes an
 * approval record (publish-approve) once the owner has said go for that exact artifact set; the check
 * recomputes every artifact's sha256, so a different card version, an extra file or a stale record refuses.
 */
export type PublishAction = "publish" | "delete";
export type PublishArtifact = { path: string; sha256: string };

export type PublishApproval = {
  id: string;
  channel: string;
  action: PublishAction;
  /** The owner's explicit go (Discord message id or equal evidence) this approval rests on. */
  ownerMessageId: string;
  approvedAt: string;
  artifacts: PublishArtifact[];
  note?: string;
};

export const APPROVALS_DIRNAME = "publish-approvals";

export function approvalsDir(doriHome: string): string {
  return join(doriHome, "state", APPROVALS_DIRNAME);
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isAction(value: string): value is PublishAction {
  return value === "publish" || value === "delete";
}

function hashArtifacts(artifacts: readonly string[]): PublishArtifact[] {
  if (artifacts.length === 0) throw new Refusal("needs at least one --artifact file");
  return artifacts.map((path) => {
    try {
      return { path, sha256: sha256File(path) };
    } catch {
      throw new Refusal(`artifact not readable: ${path}`);
    }
  });
}

export function writeApproval(
  doriHome: string,
  input: { channel: string; action: string; ownerMessageId: string; artifacts: readonly string[]; note?: string },
): PublishApproval {
  if (!input.channel.trim()) throw new Refusal("publish-approve needs --channel (instagram, x, tiktok, web, …)");
  if (!isAction(input.action)) throw new Refusal("--action must be publish or delete");
  if (!input.ownerMessageId.trim())
    throw new Refusal("publish-approve needs --owner-msg: the owner's go message id this approval rests on");
  const artifacts = hashArtifacts(input.artifacts);
  const at = new Date();
  const approval: PublishApproval = {
    id: `${at.toISOString()}-${input.channel}-${input.action}`,
    channel: input.channel,
    action: input.action,
    ownerMessageId: input.ownerMessageId,
    approvedAt: at.toISOString(),
    artifacts,
    ...(input.note ? { note: input.note } : {}),
  };
  const dir = approvalsDir(doriHome);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${approval.id}.json`), `${JSON.stringify(approval, null, 2)}\n`);
  return approval;
}

/** The record covering every requested artifact for this channel and action, or a Refusal naming what is missing. */
export function checkApproval(
  doriHome: string,
  request: { channel: string; action: string; artifacts: readonly string[] },
): PublishApproval {
  if (!request.channel.trim()) throw new Refusal("publish-check needs --channel (instagram, x, tiktok, web, …)");
  if (!isAction(request.action)) throw new Refusal("--action must be publish or delete");
  const wanted = hashArtifacts(request.artifacts);
  const dir = approvalsDir(doriHome);
  if (!existsSync(dir)) throw refuse(request, wanted);
  const candidates: PublishApproval[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      candidates.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as PublishApproval);
    } catch {
      throw new Refusal(`corrupt approval record: ${name}`);
    }
  }
  const sameChannelAction = candidates.filter((r) => r.channel === request.channel && r.action === request.action);
  const hit = sameChannelAction.find((r) => wanted.every((w) => r.artifacts.some((a) => a.sha256 === w.sha256)));
  if (hit) return hit;
  throw refuse(request, wanted);
}

function refuse(request: { channel: string; action: string }, wanted: PublishArtifact[]): Refusal {
  return new Refusal(
    `외부 ${request.action} 거부: ${request.channel} 채널에 이 산출물의 승인 기록이 없다 (sha256 불일치 또는 부재). ` +
      `대상: ${wanted.map((w) => w.path).join(", ")}. 리드가 회장님 'ㄱ' 뒤에 publish-approve로 기록을 남기면 통과한다. ` +
      `브리프의 글 승인은 승인 기록이 아니다.`,
  );
}
