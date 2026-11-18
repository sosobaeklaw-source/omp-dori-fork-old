"""공개 글(WP)에는 검수 에이전트가 읽은 기록이 있는 글자·그림만 올린다.

검수 쪽(검수가 끝나면 결과 폴더에 한 장):
    python3 review_gate.py record <reviewed.json> --model <읽은 모델> --findings <findings.md> \\
        [--text title=<읽은 제목>] [--text excerpt=<읽은 요약>] ... \\
        [--media-text <그림 파일> alt_text=<그 그림의 대체 글>] [--media-text <그림 파일> caption=<캡션>] ... \\
        [--post <검수한 글 번호>] <본문.html> <그림>...
  → {"files": [{"path", "sha256"}...], "texts": {"post": {칸: 값}, "media:<sha256>": {칸: 값}}, "model", "at", "findings"}
    (+ 줬을 때 "post": 글 번호). 글 번호를 적으면 발행 쪽에서 URL 글 번호·Rank Math objectID와 같은지 맞춘다.

발행 쪽: wp_client.WP(reviewed=..., ack=...)가 올릴 본문과 그 본문이 부르는 그림(대표 그림 포함)의
sha256을 check_bytes로, 글자 칸은 check_texts로 그 대상(글 또는 그 그림) 항목의 같은 칸 값과 똑같은지
(빈 값도) 이 기록과 맞춰 본다.
하나라도 기록에 없으면 어느 것이 읽히지 않았는지 대고 멈춘다.
검수 메모에 지적이 남아 있어도 막지 않는다. 받아들일지는 리드가 findings 첫 문단을 읽고 정하고, 그 한 줄(ack)이 발행 기록에 남는다.
이 기록은 누구든 만들 수 있다. 검수 에이전트만 만들게 하거나 서명하는 일은 남은 일이다.
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


def record(out, files, model, findings, texts=None, media_texts=None, post=None):
    """texts: 글 칸→값. media_texts: {그림 파일: {칸: 값}} — 그 그림 바이트의 sha256 항목으로 적는다. post: 검수한 글 번호."""
    if not Path(findings).is_file():
        raise SystemExit(f"findings.md가 없다: {findings}")
    entries = [{"path": str(Path(f).resolve()), "sha256": sha(Path(f).read_bytes())} for f in files]
    by_target = {"post": dict(texts or {})}
    for f, kv in (media_texts or {}).items():
        h = sha(Path(f).read_bytes())
        if h not in {e["sha256"] for e in entries}:
            raise SystemExit(f"--media-text 그림이 읽은 파일 목록에 없다: {f}")
        by_target[f"media:{h}"] = dict(kv)
    doc = {"files": entries, "texts": by_target, "model": model,
           "at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
           "findings": str(Path(findings).resolve())}
    if post is not None:
        doc["post"] = post
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


def check_texts(doc, target, items):
    """items: [(칸 이름, 글자)]. target("post" 또는 "media:<sha256>") 항목의 같은 칸 값과 똑같아야 한다. 빈 값도 맞춘다."""
    read = (doc.get("texts") or {}).get(target) or {}
    unread = [name for name, text in items if read.get(name) != text]
    if unread:
        raise ReviewMissing(f"읽히지 않았다({len(unread)}개): " + ", ".join(unread)
                            + f". 이 칸 값이 검수 기록({target})과 다르다. 검수받은 값으로 보내거나 기록을 새로 남겨라")


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
    ap.add_argument("--post", type=int)
    ap.add_argument("--text", action="append", default=[], metavar="칸=값")
    ap.add_argument("--media-text", action="append", default=[], nargs=2, metavar=("그림", "칸=값"))
    ap.add_argument("files", nargs="+")
    a = ap.parse_args()
    if bad := [t for t in a.text + [kv for _, kv in a.media_text] if "=" not in t]:
        raise SystemExit(f"--text·--media-text 값은 칸=값 모양이어야 한다: {bad}")
    texts = dict(t.split("=", 1) for t in a.text)
    media_texts = {}
    for f, kv in a.media_text:
        media_texts.setdefault(f, {}).__setitem__(*kv.split("=", 1))
    print(json.dumps(record(a.out, a.files, a.model, a.findings, texts, media_texts, a.post), ensure_ascii=False, indent=1))
    sys.exit(0)
