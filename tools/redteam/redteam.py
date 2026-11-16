#!/usr/bin/env python3
"""Red-team one artifact with web GPT 6 Pro, web Carbon and every pirate-ship model at once.

Usage:
  redteam.py --target FILE [--target FILE ...] --kind card|blog --material public|client \
             --out DIR [--gpt-account u0|u1|u2] [--carbon-account u1:<profile>] [--lane KEY]

Branches (started together, same instruction for every model):
  (a) gpt_web.md     ChatGPT web, Pro mode, via tikitaka2 tk2.py under carbon-lock <acct>.
                     Without --gpt-account the file records "blocked: no ChatGPT login".
  (b) carbon_web.md  Gemini web Carbon via carbon-web-1114/run.js under carbon-lock <acct>.
  (c) pirate__*.md   every model in the tokenmaxx and OpenCode Go lists, highest reasoning first.
                     Google models are never called (recorded as skipped). With --material client
                     the whole branch is skipped and recorded.
Then merged.md groups the same finding across models (Opus via local ocx) with a model count.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import uuid
from pathlib import Path

HOME = Path.home()
LOCK = HOME / ".omp-dori/bin/carbon-lock.sh"
TK2 = HOME / ".agents/skills/tikitaka2/scripts/tk2.py"
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


# ---------- (a) GPT web ----------
def run_gpt(out: Path, prompt_file: Path, acct: str | None, lane: str) -> dict:
    dst = out / "gpt_web.md"
    if not acct:
        write_model_file(dst, {"branch": "gpt_web", "status": "blocked: no ChatGPT login"},
                         "u0/u1/u2 ChatGPT 웹에 로그인된 세션이 없어 돌리지 않았다. 다른 모델로 대신하지 않았다.")
        return {"branch": "gpt_web", "status": "blocked", "model": "-", "chars": 0}
    raw = out / "raw_gpt_web"
    led = raw / "ledger.json"
    # tk2 never resends a lane its ledger marks UNAVAILABLE; keep that attempt aside so a rerun sends again.
    if led.exists() and json.loads(led.read_text())["lanes"].get(f"gpt6pro_{acct}", {}).get("status") == "UNAVAILABLE":
        raw.rename(out / f"raw_gpt_web.failed-{time.strftime('%H%M%S')}")
    t0 = time.time()
    proc = subprocess.run([str(LOCK), acct, lane, "--", sys.executable, str(TK2), "run", "--prompt", str(prompt_file),
                           "--out", str(raw), "--only", f"gpt6pro_{acct}", "--deadline-min", "45"],
                          capture_output=True, text=True)
    rec = {}
    if led.exists():
        rec = json.loads(led.read_text())["lanes"].get(f"gpt6pro_{acct}", {})
    text = (raw / "lanes" / rec["output"]).read_text() if rec.get("status") == "ok" else ""
    model = rec.get("mode_evidence", "-")
    head = {"branch": "gpt_web", "account": acct, "status": rec.get("status", f"exit {proc.returncode}"),
            "model_shown": model, "chat_url": rec.get("url", "-"), "chars": len(text), "seconds": round(time.time() - t0)}
    write_model_file(dst, head, text or (proc.stdout[-3000:] + proc.stderr[-2000:]))
    return {"branch": "gpt_web", "status": head["status"], "model": model, "chars": len(text), "text": text}


# ---------- (b) Carbon web ----------
def run_carbon(out: Path, prompt_file: Path, acct: str | None, lane: str, blocked: str) -> dict:
    if not acct:
        write_model_file(out / "carbon_web.md", {"branch": "carbon_web", "status": f"blocked: {blocked}"},
                         "돌리지 않았다. 다른 모델로 대신하지 않았다.")
        return {"branch": "carbon_web", "status": "blocked", "model": "-", "chars": 0}
    lock_acct = acct.split(":")[0]
    raw = out / "raw_carbon_web.txt"
    meta = out / "raw_carbon_web.meta.json"
    t0 = time.time()
    proc = subprocess.run([str(LOCK), lock_acct, lane, "--", "node", str(CARBON_RUN), "--prompt", str(prompt_file),
                           "--out", str(raw), "--account", acct, "--meta", str(meta), "--timeout", "1800"],
                          capture_output=True, text=True)
    m = json.loads(meta.read_text()) if meta.exists() else {}
    text = raw.read_text() if raw.exists() and m.get("status") == "ok" else ""
    model = m.get("modelLabel", "-")
    head = {"branch": "carbon_web", "account": acct, "status": m.get("status", f"exit {proc.returncode}"),
            "model_shown": model, "chat_url": m.get("chatUrl", "-"), "chars": len(text), "seconds": round(time.time() - t0)}
    write_model_file(out / "carbon_web.md", head, text or (m.get("reason", "") + "\n" + proc.stdout[-3000:] + proc.stderr[-2000:]))
    return {"branch": "carbon_web", "status": head["status"], "model": model, "chars": len(text), "text": text}


# ---------- (c) pirate ships ----------
def http_json(url: str, headers: dict, body: dict | None = None, timeout: int = 60) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data, {"user-agent": UA, "content-type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def pirate_ships() -> tuple[list[dict], list[str]]:
    """Both ship lists read at run time. A ship whose list cannot be read (e.g. the paidlock guard
    blocks opencode.ai) is reported, never routed around."""
    ships = [("tokenmaxx", "https://oc.hyeon.space/v1", (HOME / ".omp/agent/tokenmaxx.key").read_text().strip()),
             ("opencode-go", "https://opencode.ai/zen/go/v1", os.environ.get("OPENCODE_API_KEY", ""))]
    models, down = [], []
    for ship, base, key in ships:
        try:
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
                           "google": bool(GOOGLE.search(m["id"] + " " + str(m.get("owned_by") or "")))})
    return sorted(models, key=lambda x: -x["rank"]), down


def call_pirate(out: Path, prompt: str, m: dict) -> dict:
    name = f"pirate__{m['ship']}__{m['id'].replace('/', '_')}"
    head = {"branch": "pirate", "ship": m["ship"], "requested": m["id"], "effort": m["effort"] or "-"}
    body = {"model": m["id"], "messages": [{"role": "user", "content": prompt}]}
    if m["effort"]:
        body["reasoning_effort"] = m["effort"]
    t0 = time.time()
    try:
        r = http_json(m["base"] + "/chat/completions", {"authorization": "Bearer " + m["key"],
                                                         "x-opencode-session": "redteam-" + uuid.uuid4().hex[:12]},
                      body, timeout=900)
        text = (r["choices"][0]["message"].get("content") or "").strip()
        head.update({"status": "ok" if text else "empty", "model_shown": r.get("model", "-"), "chars": len(text),
                     "finish_reason": r["choices"][0].get("finish_reason"), "usage": json.dumps(r.get("usage"))})
    except Exception as e:  # each model's failure is its own result
        detail = e.read().decode(errors="replace")[:1500] if hasattr(e, "read") else ""
        text = ""
        head.update({"status": "error", "model_shown": "-", "chars": 0, "error": f"{e} {detail}".strip()})
    head["seconds"] = round(time.time() - t0)
    write_model_file(out / f"{name}.md", head, text or head.get("error", ""))
    return {"branch": name, "status": head["status"], "model": head["model_shown"], "chars": head["chars"], "text": text}


def run_pirates(out: Path, prompt: str, material: str) -> list[dict]:
    if material == "client":
        (out / "pirates_skipped.md").write_text("의뢰인·사건 자료가 든 대상이라 해적선 가지(c)를 돌리지 않았다.\n")
        return []
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
    got = [r for r in results if r.get("text")]
    blob = "\n\n".join(f"### {r['branch']}\n{r['text']}" for r in got)
    r = http_json(OCX, {}, {"model": MERGE_MODEL, "messages": [{"role": "user", "content": MERGE_INSTR + blob}]}, timeout=900)
    raw = r["choices"][0]["message"]["content"]
    (out / "merged.raw.json").write_text(raw)
    groups = json.loads(raw[raw.index("["): raw.rindex("]") + 1])
    groups.sort(key=lambda g: -len(set(g["models"])))
    lines = [f"# 병합 지적 {len(groups)}건 (병합 {r.get('model', MERGE_MODEL)}, 답 {len(got)}개)\n"]
    for i, g in enumerate(groups, 1):
        lines.append(f"{i}. [{len(set(g['models']))}개 모델] 위치: {g['location']} | 문제: {g['problem']} | 근거: {g['evidence']}")
    (out / "merged.md").write_text("\n".join(lines) + "\n")
    return len(groups)


def read_back(path: Path) -> dict:
    """A model file written earlier by write_model_file: '- key: value' head, blank line, body."""
    head_txt, _, body = path.read_text().partition("\n\n")
    head = dict(line[2:].split(": ", 1) for line in head_txt.splitlines() if ": " in line)
    ok = head.get("status") == "ok"
    return {"branch": path.stem, "status": head.get("status", "?"), "model": head.get("model_shown", "-"),
            "chars": int(head.get("chars", 0)) if ok else 0, "text": body.strip() if ok else ""}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", action="append", required=True)
    ap.add_argument("--kind", choices=sorted(KIND_FOCUS), required=True)
    ap.add_argument("--material", choices=["public", "client"], required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--gpt-account", choices=["u0", "u1", "u2"])
    ap.add_argument("--carbon-account", help="aside account for Gemini Carbon, e.g. u1:<profile>; omitted = branch recorded as blocked")
    ap.add_argument("--carbon-blocked", default="no logged-in Gemini account given", help="reason written when --carbon-account is omitted")
    ap.add_argument("--lane", default="redteam-path-1116")
    ap.add_argument("--only", default="gpt,carbon,pirates",
                    help="branches to (re)run; the others are read back from their files in --out and merged again")
    a = ap.parse_args()
    only = set(a.only.split(","))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    prompt = build_prompt(a.kind, [Path(t) for t in a.target])
    pf = out / "prompt.txt"
    pf.write_text(prompt)
    with cf.ThreadPoolExecutor(3) as ex:
        fg = ex.submit(run_gpt, out, pf, a.gpt_account, a.lane) if "gpt" in only else None
        fc = ex.submit(run_carbon, out, pf, a.carbon_account, a.lane, a.carbon_blocked) if "carbon" in only else None
        fp = ex.submit(run_pirates, out, prompt, a.material) if "pirates" in only else None
        gpt = fg.result() if fg else read_back(out / "gpt_web.md")
        carbon = fc.result() if fc else read_back(out / "carbon_web.md")
        pirates = fp.result() if fp else [read_back(p) for p in sorted(out.glob("pirate__*.md"))]
    results = [gpt, carbon, *pirates]
    n = merge(out, results)
    (out / "summary.json").write_text(json.dumps([{k: v for k, v in r.items() if k != "text"} for r in results] + [{"merged": n}],
                                                 ensure_ascii=False, indent=1))
    def short(r): return f"{r['model']} {r['chars']}" if r["chars"] else f"{r['status']}"
    ok = [r for r in pirates if r["chars"]]
    print(f"GPT웹 {short(gpt)} | Carbon {short(carbon)} | 해적선 "
          + ", ".join(f"{r['model']}:{r['chars']}" for r in ok) + f" | 병합 지적 {n}건")
    return 0


if __name__ == "__main__":
    sys.exit(main())
