"""공개 글(WP)에는 검수 에이전트가 읽은 기록이 있는 글자·그림만 올린다.

검수 쪽(검수가 끝나면 결과 폴더에 한 장):
    python3 review_gate.py record <reviewed.json> --model <읽은 모델> --findings <findings.md> <본문.html> <그림>...
  → {"files": [{"path", "sha256"}...], "model", "at", "findings"}. 판정은 적지 않는다. 읽었다는 사실만 적는다.

발행 쪽: wp_client.WP(reviewed=..., ack=...)가 올릴 본문과 그 본문이 부르는 그림(대표 그림 포함)의
sha256을 check_bytes로 이 기록과 맞춰 본다. 하나라도 기록에 없으면 어느 것이 읽히지 않았는지 대고 멈춘다.
검수 메모에 지적이 남아 있어도 막지 않는다. 받아들일지는 리드가 findings 첫 문단을 읽고 정하고, 그 한 줄(ack)이 발행 기록에 남는다.
"""
import argparse
import datetime
import hashlib
import json
import sys
from pathlib import Path


class ReviewMissing(RuntimeError):
    pass


def sha(data):
    return hashlib.sha256(data).hexdigest()


def record(out, files, model, findings):
    if not Path(findings).is_file():
        raise SystemExit(f"findings.md가 없다: {findings}")
    doc = {"files": [{"path": str(Path(f).resolve()), "sha256": sha(Path(f).read_bytes())} for f in files],
           "model": model, "at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
           "findings": str(Path(findings).resolve())}
    Path(out).write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    return doc


def load(reviewed):
    p = Path(reviewed)
    if not p.is_file():
        raise ReviewMissing(f"읽은 기록 reviewed.json이 없다: {p}. 검수 에이전트가 본문과 그림을 먼저 읽어야 한다")
    doc = json.loads(p.read_text(encoding="utf-8"))
    if not Path(doc.get("findings", "")).is_file():
        raise ReviewMissing(f"{p}의 findings.md가 없다: {doc.get('findings')!r}")
    return doc


def check_bytes(doc, items):
    """items: [(이름, 바이트)]. 읽은 기록에 sha256이 없는 것 이름을 모아 한 번에 거부한다."""
    read = {f["sha256"] for f in doc["files"]}
    unread = [name for name, data in items if sha(data) not in read]
    if unread:
        raise ReviewMissing(f"읽히지 않았다({len(unread)}개): " + ", ".join(unread)
                            + ". 검수 뒤 바뀌었거나 검수에 넣지 않은 것이다. 다시 검수받고 reviewed.json을 새로 남겨라")


def first_paragraph(doc):
    text = Path(doc["findings"]).read_text(encoding="utf-8").strip()
    paras = [p.strip() for p in text.split("\n\n") if p.strip() and not p.strip().startswith(("#", "<!--"))]
    return paras[0] if paras else text[:400]


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["record"])
    ap.add_argument("out")
    ap.add_argument("--model", required=True)
    ap.add_argument("--findings", required=True)
    ap.add_argument("files", nargs="+")
    a = ap.parse_args()
    print(json.dumps(record(a.out, a.files, a.model, a.findings), ensure_ascii=False, indent=1))
    sys.exit(0)
