#!/usr/bin/env python3
"""Red-team one artifact with web Carbon, web GPT 6 Pro and every pirate-ship model at once.

Usage:
  redteam.py --target FILE [--target FILE ...] --kind card|blog --material public|client \
             --out DIR [--carbon-account u1:<profile>] [--gpt-account u0:<profile>] [--lane KEY]

Branches (started together, same instruction for every model):
  (a) carbon_web.md  Gemini web Carbon via carbon-web-1114/run.js under carbon-lock <acct>.
  (b) pirate__*.md   every model in the tokenmaxx and OpenCode Go lists, highest reasoning first.
                     Google models are never called (recorded as skipped). With --material client
                     the whole branch is skipped and recorded.
  (c) gpt6pro_web.md  web GPT 6 Pro via gpt-web/run.js. Takes the account lock without waiting and
                     calls the runner directly (not through carbon-lock.sh). One attempt. A reply is
                     received only when meta.json says status 'ok', model_shown names GPT 6 Pro and
                     the answer file is not empty; anything else is recorded as '못 받음' with the
                     reason. The runner contract is tools/redteam/README.md. While the same account's
                     lock is held the branch is recorded as '못 받음' instead of waiting.
  Carbon and GPT 6 Pro must name different Aside accounts: one account, one lock, no race.
No GPT API branch: web GPT 6 Pro only (owner decision 2026-11-16 redteam.web_gpt6pro_carbon_plus_all_pirates).
Then merged.md groups the same finding across models (Opus via local ocx) with a model count.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import uuid
from pathlib import Path

HOME = Path.home()
LOCK = HOME / ".omp-dori/bin/carbon-lock.sh"
CARBON_RUN = HOME / "sobaegi-lead/results/carbon-web-1114/run.js"
OCX = "http://127.0.0.1:10100/v1/chat/completions"
MERGE_MODEL = "anthropic/claude-opus-5-5"
GOOGLE = re.compile(r"gemini|gemma|google|palm|lyria|bard", re.I)
EFFORT_RANK = {"max": 6, "xhigh": 5, "high": 4, "medium": 3, "low": 2, "minimal": 1, "none": 0}
UA = "omp-dori-redteam/1.0"

KIND_FOCUS = {
    "card": "카드뉴스(장마다 제목·정보 칸)다. 법령·판결과 어긋난 문구, 과장·단정, 독자가 오해할 표현, 장끼리 모순, 빠진 조건을 찾아라.",
    "blog": "블로그 본문이다. 법령·판결과 어긋난 주장, 근거 없는 단정, 논리 비약, 독자가 오해할 표현, 빠진 조건·예외를 찾아라.",
}


def build_prompt(kind: str, targets: list[Path]) -> str:
    body = "\n\n".join(f"===== {p.name} =====\n{p.read_text()}" for p in targets)
    return (
        "너는 레드팀이다. 아래 산출물의 약점만 찾아라. 고쳐 쓴 문장이나 새 원고는 쓰지 마라.\n"
        f"대상: {KIND_FOCUS[kind]}\n"
        "지적마다 한 줄로, 정확히 이 형식만 써라:\n"
        "지적: 위치=<장 번호·칸 또는 문단> | 문제=<무엇이 틀렸거나 위험한지> | 근거=<법령·판결·산출물 안의 근거>\n"
        "확실하지 않으면 근거에 '추정'이라고 적어라. 지적이 없으면 '지적 없음' 한 줄만 써라.\n\n"
        f"{body}\n"
    )


def write_model_file(path: Path, head: dict, text: str) -> None:
    lines = [f"- {k}: {v}" for k, v in head.items()]
    path.write_text("\n".join(lines) + "\n\n" + text.strip() + "\n")


# ---------- (a) Carbon web ----------
GOT = "받음"
NOT_GOT = "못 받음"


# ---------- account lock, shared with carbon-lock.sh and dori harness lock ----------
# Ported from src/lock-owner.ts and src/lock-claim.ts so this tool never invents a third set of rules: the
# owner line is `<lane> <YYYY-MM-DD HH:MM:SS> pid=<pid>` plus ` cmd=<runner pid>` once the runner starts,
# and a stale lock is removed only under a claim, after re-reading the owner line.
OWNERLESS_S = 60  # src/lock-owner.ts OWNERLESS_MS


def lock_dir(acct: str) -> Path:
    return HOME / ".omp-dori/state" / f"carbon-{acct.split(':')[0]}.lock"


def stamp() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def owner_text(d: Path) -> str | None:
    try:
        return (d / "owner").read_text().strip() or None
    except FileNotFoundError:
        return None


def stale_why(d: Path, owner: str | None) -> str | None:
    """Why this lock may be cleared, or None while its holder may still run (src/lock-owner.ts staleWhy)."""
    if owner is None:
        age = time.time() - d.stat().st_mtime
        return f"ownerless lock older than {OWNERLESS_S}s" if age > OWNERLESS_S else None
    pids = [int(m) for m in re.findall(r"(?:^|\s)(?:pid|cmd)=(\d+)", owner)]
    if not pids or any(alive(p) for p in pids):
        return None
    return f"stale lock from dead pid {', '.join(map(str, pids))} ({owner})"


def claim_path(d: Path, seen: str) -> Path:
    return d.parent / f".lock-claim-{hashlib.sha256((d.name + chr(0) + seen).encode()).hexdigest()}"


def take_claim(path: Path) -> str | None:
    """One claim file per observed owner line (src/lock-claim.ts takeFile), so two takers cannot both clear.

    Returns the claim text this process wrote, or None when another live taker holds it."""
    mine = f"pid={os.getpid()} {uuid.uuid4().hex}"
    for _ in range(2):
        try:
            with path.open("x") as claim_file:
                claim_file.write(mine)
            return mine
        except OSError:
            seen = path.read_text().strip() if path.exists() else None
            if seen is None:
                continue
            pid = re.search(r"pid=(\d+)", seen)
            if pid is None or alive(int(pid.group(1))):
                return None
            path.unlink(missing_ok=True)
    return None


def clear_stale(d: Path, seen: str | None) -> bool:
    """Remove the lock only while it still reads as `seen` and is still left behind (src/lock-owner.ts clear)."""
    claim = claim_path(d, seen or "")
    mine = take_claim(claim)
    if mine is None:
        return False
    try:
        now = owner_text(d)
        if now != seen or stale_why(d, now) is None:
            return False
        shutil.rmtree(d, ignore_errors=True)
        return True
    except FileNotFoundError:
        return False
    finally:
        try:
            if claim.read_text().strip() == mine:
                claim.unlink()
        except FileNotFoundError:
            pass


def try_lock(acct: str, lane: str) -> str | None:
    """Take the account lock without waiting; the owner line, or None while a live job holds it."""
    d = lock_dir(acct)
    for _ in range(3):
        try:
            d.mkdir(parents=True)
        except FileExistsError:
            try:
                seen = owner_text(d)
                why = stale_why(d, seen)
            except FileNotFoundError:
                continue
            if why is None:
                return None
            print(f"redteam: {acct} {why}; clearing", file=sys.stderr)
            clear_stale(d, seen)
            continue
        owner = f"{lane} {stamp()} pid={os.getpid()}"
        (d / "owner").write_text(owner + "\n")
        return owner
    return None


def name_command(acct: str, owner: str, pid: int) -> str:
    """Add ` cmd=<pid>` to the owner line, so a waiter keeps the lock held while the runner runs."""
    named = f"{owner} cmd={pid}"
    d = lock_dir(acct)
    tmp = d / "owner.tmp"
    tmp.write_text(named + "\n")
    tmp.replace(d / "owner")
    return named


def release_lock(acct: str, owner: str) -> None:
    """Remove the lock only while it is still this owner's."""
    d = lock_dir(acct)
    if owner_text(d) == owner:
        shutil.rmtree(d, ignore_errors=True)


# ---------- (c) web GPT 6 Pro ----------
GPT_MODEL_MARK = re.compile(r"\s*GPT[- ]6\s+Pro\s*", re.I)


def read_gpt_answer(meta: dict, meta_path: Path, raw: Path) -> tuple[str, str]:
    """(answer text, why it is '못 받음'). Received needs all three, per tools/redteam/README.md:
    status 'ok', model_shown naming GPT 6 Pro, and a non-empty answer file."""
    if str(meta.get("status") or "") != "ok":
        reason = f"status={meta.get('status') or '없음'}"
        return "", reason + (f" ({meta['reason']})" if meta.get("reason") else "")
    model = str(meta.get("model_shown") or "")
    if not GPT_MODEL_MARK.fullmatch(model):
        return "", f"model_shown={model or '없음'} — GPT 6 Pro가 아니다"
    answer = raw
    if meta.get("answer_path"):
        p = Path(str(meta["answer_path"])).expanduser()
        answer = p if p.is_absolute() else meta_path.parent / p
    try:
        text = answer.read_text()
    except FileNotFoundError:
        return "", f"답 파일이 없다: {answer}"
    if not text.strip():
        return "", f"답이 비었다: {answer}"
    return text, ""


def run_gpt(out: Path, prompt_file: Path, acct: str | None, lane: str, blocked: str) -> dict:
    """Web GPT 6 Pro, one attempt. No answer is recorded as '못 받음'.

    The account lock is taken once, here, and never waited on. The runner is called directly, not through
    carbon-lock.sh, which would wait forever on the lock this function just took. The lock is released on
    every exit, including a missing runner or a raised error."""
    if not acct:
        write_model_file(out / "gpt6pro_web.md", {"branch": "gpt6pro_web", "status": NOT_GOT, "reason": blocked},
                         "돌리지 않았다. 다른 모델로 대신하지 않았다.")
        return {"branch": "gpt6pro_web", "status": NOT_GOT, "model": "-", "chars": 0}
    owner = try_lock(acct, lane)
    if owner is None:
        reason = "같은 Aside 계정을 카본이 쓰는 중이라 기다리지 않고 넘김"
        write_model_file(out / "gpt6pro_web.md",
                         {"branch": "gpt6pro_web", "account": acct, "status": NOT_GOT, "reason": reason}, reason)
        return {"branch": "gpt6pro_web", "status": NOT_GOT, "model": "-", "chars": 0}
    held = {"owner": owner}
    try:
        return _run_gpt_locked(out, prompt_file, acct, held)
    finally:
        release_lock(acct, held["owner"])


def _run_gpt_locked(out: Path, prompt_file: Path, acct: str, held: dict) -> dict:
    gpt_run = HOME / "sobaegi-lead/results/gpt-web/run.js"
    if not gpt_run.exists():
        reason = f"runner missing: {gpt_run}"
        write_model_file(out / "gpt6pro_web.md",
                         {"branch": "gpt6pro_web", "account": acct, "status": NOT_GOT, "reason": reason}, reason)
        return {"branch": "gpt6pro_web", "status": NOT_GOT, "model": "-", "chars": 0}
    raw = out / "raw_gpt6pro_web.txt"
    meta_path = out / "raw_gpt6pro_web.meta.json"
    raw.unlink(missing_ok=True)  # an earlier run's answer must never read as this run's
    meta_path.unlink(missing_ok=True)
    t0 = time.time()
    proc = subprocess.Popen(["node", str(gpt_run), "--prompt", str(prompt_file),
                             "--out", str(raw), "--account", acct, "--meta", str(meta_path), "--timeout", "1800"],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    held["owner"] = name_command(acct, held["owner"], proc.pid)  # a killed redteam.py leaves this lock held
    stdout, stderr = proc.communicate()
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    text, why = (read_gpt_answer(meta, meta_path, raw) if meta
                 else ("", f"meta.json 없음 (runner exit {proc.returncode})"))
    head = {"branch": "gpt6pro_web", "account": acct, "status": GOT if text else NOT_GOT,
            "model_shown": str(meta.get("model_shown") or "-"),
            "finished_at": str(meta.get("finished_at") or "-"),
            "chat_url": str(meta.get("chat_url") or meta.get("chatUrl") or "-"),
            "chars": len(text), "seconds": round(time.time() - t0)}
    if not text:
        head["reason"] = why
    write_model_file(out / "gpt6pro_web.md", head, text or (why + "\n" + stdout[-3000:] + stderr[-2000:]))
    return {"branch": "gpt6pro_web", "status": head["status"], "model": head["model_shown"],
            "chars": len(text), "text": text}


def run_carbon(out: Path, prompt_file: Path, acct: str | None, lane: str, blocked: str) -> dict:
    if not acct:
        write_model_file(out / "carbon_web.md", {"branch": "carbon_web", "status": NOT_GOT, "reason": blocked},
                         "돌리지 않았다. 다른 모델로 대신하지 않았다.")
        return {"branch": "carbon_web", "status": NOT_GOT, "model": "-", "chars": 0}
    lock_acct = acct.split(":")[0]
    raw = out / "raw_carbon_web.txt"
    meta = out / "raw_carbon_web.meta.json"
    raw.unlink(missing_ok=True)  # an earlier run's answer must never read as this run's
    meta.unlink(missing_ok=True)
    t0 = time.time()
    proc = subprocess.run([str(LOCK), lock_acct, lane, "--", "node", str(CARBON_RUN), "--prompt", str(prompt_file),
                           "--out", str(raw), "--account", acct, "--meta", str(meta), "--timeout", "1800"],
                          capture_output=True, text=True)
    m = json.loads(meta.read_text()) if meta.exists() else {}
    text = raw.read_text() if raw.exists() and m.get("status") == "ok" else ""
    model = m.get("modelLabel", "-")
    got = m.get("status") == "ok" and bool(text)
    head = {"branch": "carbon_web", "account": acct, "status": GOT if got else NOT_GOT,
            "model_shown": model, "chat_url": m.get("chatUrl", "-"), "chars": len(text), "seconds": round(time.time() - t0)}
    if not got:
        head["reason"] = m.get("reason") or m.get("status") or f"exit {proc.returncode}"
    write_model_file(out / "carbon_web.md", head, text or (m.get("reason", "") + "\n" + proc.stdout[-3000:] + proc.stderr[-2000:]))
    return {"branch": "carbon_web", "status": head["status"], "model": model, "chars": len(text), "text": text}


# ---------- (b) pirate ships ----------
def http_json(url: str, headers: dict, body: dict | None = None, timeout: int = 60) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data, {"user-agent": UA, "content-type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def pirate_ships() -> tuple[list[dict], list[str]]:
    """Both ship lists read at run time. A ship whose list cannot be read (e.g. the paidlock guard
    blocks opencode.ai) is reported, never routed around."""
    ships = [("tokenmaxx", "https://oc.hyeon.space/v1", lambda: (HOME / ".omp/agent/tokenmaxx.key").read_text().strip()),
             ("opencode-go", "https://opencode.ai/zen/go/v1", lambda: os.environ.get("OPENCODE_API_KEY", ""))]
    models, down = [], []
    for ship, base, read_key in ships:
        try:
            key = read_key()
            listed = http_json(base + "/models", {"authorization": "Bearer " + key})["data"]
        except Exception as e:
            down.append(f"{ship}: 목록을 읽지 못함 — {e}")
            continue
        for m in listed:
            r = (m.get("capabilities") or {}).get("reasoning") or {}
            efforts = r.get("effort") or []
            top = max(efforts, key=lambda e: EFFORT_RANK.get(e, -1)) if efforts else None
            rank = EFFORT_RANK.get(top, -1) if top else (0.5 if r.get("supported") else -1)
            models.append({"ship": ship, "base": base, "key": key, "id": m["id"], "effort": top, "rank": rank,
                           "efforts": efforts,
                           "google": bool(GOOGLE.search(m["id"] + " " + str(m.get("owned_by") or "")))})
    return sorted(models, key=lambda x: -x["rank"]), down


def is_timeout(e: Exception) -> bool:
    return isinstance(e, TimeoutError) or isinstance(getattr(e, "reason", None), TimeoutError)


def lower_effort(m: dict, effort: str | None) -> str | None:
    """The model's next listed effort below `effort` (high -> medium, ...); None when there is none."""
    below = [e for e in m.get("efforts") or [] if EFFORT_RANK.get(e, -1) < EFFORT_RANK.get(effort, -1)]
    return max(below, key=lambda e: EFFORT_RANK.get(e, -1)) if below else None


def ask_pirate(prompt: str, m: dict, effort: str | None) -> tuple[dict, str, bool]:
    """One call. Returns (attempt record, answer text, timed_out)."""
    body = {"model": m["id"], "messages": [{"role": "user", "content": prompt}]}
    if effort:
        body["reasoning_effort"] = effort
    att, t0, timed_out = {"effort": effort or "-"}, time.time(), False
    try:
        r = http_json(m["base"] + "/chat/completions", {"authorization": "Bearer " + m["key"],
                                                         "x-opencode-session": "redteam-" + uuid.uuid4().hex[:12]},
                      body, timeout=900)
        text = (r["choices"][0]["message"].get("content") or "").strip()
        att.update({"status": "ok" if text else "empty", "model_shown": r.get("model", "-"), "chars": len(text),
                    "finish_reason": r["choices"][0].get("finish_reason"), "usage": json.dumps(r.get("usage"))})
    except Exception as e:  # each model's failure is its own result
        detail = e.read().decode(errors="replace")[:1500] if hasattr(e, "read") else ""
        text, timed_out = "", is_timeout(e)
        att.update({"status": "timeout" if timed_out else "error", "model_shown": "-", "chars": 0,
                    "error": f"{e} {detail}".strip()})
    att["seconds"] = round(time.time() - t0)
    return att, text, timed_out


def call_pirate(out: Path, prompt: str, m: dict) -> dict:
    """Ask at the model's top effort; on a timeout, ask once more one effort level lower."""
    name = f"pirate__{m['ship']}__{m['id'].replace('/', '_')}"
    att, text, timed_out = ask_pirate(prompt, m, m["effort"])
    attempts = [att]
    retry = lower_effort(m, m["effort"]) if timed_out else None
    if retry:
        att, text, _ = ask_pirate(prompt, m, retry)
        attempts.append(att)
    head = {"branch": "pirate", "ship": m["ship"], "requested": m["id"], **att,
            "seconds": sum(a["seconds"] for a in attempts)}
    if len(attempts) > 1:
        head["attempts"] = json.dumps(attempts, ensure_ascii=False)
    write_model_file(out / f"{name}.md", head, text or att.get("error", ""))
    return {"branch": name, "status": att["status"], "model": att["model_shown"], "chars": att["chars"],
            "attempts": attempts, "text": text}


def run_pirates(out: Path, prompt: str, material: str) -> list[dict]:
    if material == "client":
        (out / "pirates_skipped.md").write_text("의뢰인·사건 자료가 든 대상이라 해적선 가지를 돌리지 않았다.\n")
        return [{"branch": "pirates", "status": "skipped", "model": "-", "chars": 0}]
    models, down = pirate_ships()
    skipped = [m for m in models if m["google"]]
    (out / "pirates_order.md").write_text(
        "추론 높은 순서(호출 순서):\n" + "".join(f"- {m['ship']}/{m['id']} effort={m['effort'] or '-'}\n" for m in models if not m["google"])
        + "\nGoogle 모델이라 부르지 않음(Antigravity·웹 Gemini에서만 쓴다):\n"
        + ("".join(f"- {m['ship']}/{m['id']}\n" for m in skipped) or "- 없음\n")
        + ("\n부르지 못한 해적선:\n" + "".join(f"- {d}\n" for d in down) if down else ""))
    with cf.ThreadPoolExecutor(8) as ex:  # submitted in reasoning order, high to low
        return list(ex.map(lambda m: call_pirate(out, prompt, m), [m for m in models if not m["google"]]))


# ---------- merge ----------
MERGE_INSTR = (
    "아래는 여러 모델이 같은 산출물에 낸 레드팀 지적이다. 같은 위치의 같은 문제만 하나로 묶어라. "
    "같은 지적인지 애매하면 따로 둬라. 새 지적을 만들거나 문장을 고쳐 쓰지 마라. "
    'JSON 배열만 출력하라: [{"location":"…","problem":"…","evidence":"…","models":["모델 이름", …]}]. '
    "models에는 그 지적을 낸 모델 이름(각 답의 머리 표시 그대로)을 넣어라.\n\n"
)


def merge(out: Path, results: list[dict]) -> int:
    """Group findings; returns the group count. Raises when the merge model's reply cannot be used."""
    got = [r for r in results if r.get("text")]
    counted = [r for r in results if r.get("status") != "skipped"]
    received = [r["branch"] for r in counted if r.get("text")]
    missed = [r["branch"] for r in counted if not r.get("text")]
    tally = f" | 받음: {', '.join(received) or '-'} | 못 받음: {', '.join(missed) or '-'}"
    if not got:
        (out / "merged.md").write_text(f"# 병합 지적 0건 (답 0개, 병합하지 않음){tally}\n")
        return 0
    known = {r["branch"] for r in got}
    blob = "\n\n".join(f"### {r['branch']}\n{r['text']}" for r in got)
    r = http_json(OCX, {}, {"model": MERGE_MODEL, "messages": [{"role": "user", "content": MERGE_INSTR + blob}]}, timeout=900)
    raw = r["choices"][0]["message"]["content"]
    (out / "merged.raw.json").write_text(raw)
    groups = json.loads(raw[raw.index("["): raw.rindex("]") + 1])
    for g in groups:  # count only names that are real answers in this run
        named = set(g.get("models") or [])
        g["counted"], g["unknown"] = sorted(named & known), sorted(named - known)
    groups.sort(key=lambda g: -len(g["counted"]))
    lines = [f"# 병합 지적 {len(groups)}건 (병합 {r.get('model', MERGE_MODEL)}, 답 {len(got)}개){tally}\n"]
    for i, g in enumerate(groups, 1):
        extra = f" | 모르는 이름(세지 않음): {', '.join(g['unknown'])}" if g["unknown"] else ""
        lines.append(f"{i}. [{len(g['counted'])}개 모델] 위치: {g.get('location', '?')} | 문제: {g.get('problem', '?')}"
                     f" | 근거: {g.get('evidence', '?')} | 모델: {', '.join(g['counted'])}{extra}")
    (out / "merged.md").write_text("\n".join(lines) + "\n")
    return len(groups)


def read_back(path: Path) -> dict:
    """A model file written earlier by write_model_file: '- key: value' head, blank line, body."""
    if not path.exists():
        return {"branch": path.stem, "status": "missing", "model": "-", "chars": 0, "text": ""}
    head_txt, _, body = path.read_text().partition("\n\n")
    head = dict(line[2:].split(": ", 1) for line in head_txt.splitlines() if ": " in line)
    ok = head.get("status") in ("ok", GOT)
    return {"branch": path.stem, "status": head.get("status", "?"), "model": head.get("model_shown", "-"),
            "chars": int(head.get("chars", 0)) if ok else 0, "text": body.strip() if ok else ""}


def same_account_error(carbon: str | None, gpt: str | None) -> str | None:
    """Why one Aside account cannot serve both branches: they share one lock, so one would only wait for the other."""
    if carbon and gpt and carbon.split(":")[0] == gpt.split(":")[0]:
        return (f"--carbon-account and --gpt-account must name different Aside accounts: both would take "
                f"{carbon.split(':')[0]}'s lock, and one branch would only ever wait for the other")
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", action="append", required=True)
    ap.add_argument("--kind", choices=sorted(KIND_FOCUS), required=True)
    ap.add_argument("--material", choices=["public", "client"], required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--carbon-account", help="aside account for Gemini Carbon, e.g. u1:<profile>; omitted = branch recorded as blocked")
    ap.add_argument("--carbon-blocked", default="no logged-in Gemini account given", help="reason written when --carbon-account is omitted")
    ap.add_argument("--lane", default="redteam-path-1116")
    ap.add_argument("--gpt-account", help="aside account for web GPT 6 Pro, e.g. u0:<profile>; must differ from --carbon-account")
    ap.add_argument("--gpt-blocked", default="no logged-in ChatGPT account given", help="reason written when --gpt-account is omitted")
    ap.add_argument("--only", default="carbon,gpt,pirates",
                    help="branches to (re)run; the others are read back from their files in --out and merged again")
    a = ap.parse_args()
    if (same := same_account_error(a.carbon_account, a.gpt_account)):
        ap.error(same)
    only = set(a.only.split(","))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    prompt = build_prompt(a.kind, [Path(t) for t in a.target])
    pf = out / "prompt.txt"
    pf.write_text(prompt)

    def settle(fut, branch: str):
        """A branch that raises becomes that branch's recorded failure; the others still merge."""
        try:
            return fut.result()
        except Exception as e:
            write_model_file(out / f"{branch}.md", {"branch": branch, "status": "error", "error": repr(e)}, repr(e))
            return {"branch": branch, "status": "error", "model": "-", "chars": 0, "text": ""}
    with cf.ThreadPoolExecutor(3) as ex:
        fc = ex.submit(run_carbon, out, pf, a.carbon_account, a.lane, a.carbon_blocked) if "carbon" in only else None
        fg = ex.submit(run_gpt, out, pf, a.gpt_account, a.lane, a.gpt_blocked) if "gpt" in only else None
        fp = ex.submit(run_pirates, out, prompt, a.material) if "pirates" in only else None
        carbon = settle(fc, "carbon_web") if fc else read_back(out / "carbon_web.md")
        gpt = settle(fg, "gpt6pro_web") if fg else read_back(out / "gpt6pro_web.md")
        if fp:
            pirates = settle(fp, "pirates_error")
            pirates = pirates if isinstance(pirates, list) else [pirates]
        else:
            pirates = [read_back(p) for p in sorted(out.glob("pirate__*.md"))]
    results = [carbon, gpt, *pirates]
    code, merged = 0, None
    try:
        merged = merge(out, results)
    except Exception as e:
        (out / "merged.md").write_text(f"# 병합 실패\n\n{e!r}\n")
        code = 1
    (out / "summary.json").write_text(json.dumps([{k: v for k, v in r.items() if k != "text"} for r in results]
                                                 + [{"merged": merged}], ensure_ascii=False, indent=1))
    def short(r): return f"{r['model']} {r['chars']}" if r["chars"] else f"{r['status']}"
    ok = [r for r in pirates if r["chars"]]
    print(f"Carbon {short(carbon)} | GPT 6 Pro {short(gpt)} | 해적선 "
          + ", ".join(f"{r['model']}:{r['chars']}" for r in ok) + f" | 병합 지적 {merged if merged is not None else '실패'}건")
    return code


if __name__ == "__main__":
    sys.exit(main())
