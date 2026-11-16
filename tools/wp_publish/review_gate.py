"""공개 글(WP)에 쓰기 전에, 쓰려는 HTML 파일을 검수 에이전트가 읽고 통과시켰는지 확인한다.

검수 결과 파일 findings.md(기본: HTML 파일과 같은 폴더)의 첫 줄은
    sha256: <그 HTML 파일의 sha256>  verdict: pass
이어야 한다. 파일이 없거나, sha256이 다르거나, verdict가 pass가 아니면(fail·block·없음) ReviewMissing을 던진다.
검수 뒤 HTML이 한 글자라도 바뀌면 sha256이 달라져 다시 검수해야 한다.

사용: python3 review_gate.py <글.html> [findings.md]   # 통과 0, 거부 1(이유 출력)
"""
import hashlib
import re
import sys
from pathlib import Path


class ReviewMissing(RuntimeError):
    pass


def check(html, findings=None):
    html = Path(html)
    findings = Path(findings) if findings else html.parent / "findings.md"
    if not html.is_file():
        raise ReviewMissing(f"공개 글에 쓸 HTML 파일이 없다: {html}")
    want = hashlib.sha256(html.read_bytes()).hexdigest()
    if not findings.is_file():
        raise ReviewMissing(f"검수 결과 파일이 없다: {findings} (대상 {html.name} sha256 {want})")
    first = findings.read_text(encoding="utf-8").split("\n", 1)[0]
    got = re.search(r"sha256:\s*([0-9a-f]{64})\b", first.lower())
    if not got:
        raise ReviewMissing(f"{findings} 첫 줄에 'sha256: <64자리>'가 없다: {first[:120]!r}")
    if got.group(1) != want:
        raise ReviewMissing(f"검수한 글과 쓰려는 글이 다르다: findings {got.group(1)} ≠ {html.name} {want}")
    verdict = re.search(r"verdict:\s*(\S+)", first.lower())
    if not verdict or verdict.group(1) != "pass":
        raise ReviewMissing(f"{findings} 검수 판정이 pass가 아니다: {verdict.group(1) if verdict else '판정 없음'}")
    return want


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3):
        raise SystemExit(__doc__)
    try:
        print("통과", check(*sys.argv[1:]))
    except ReviewMissing as e:
        print("거부:", e, file=sys.stderr)
        sys.exit(1)
