"""Keep numbers, number+unit, article references and formulas on one line in a published body.

The theme sets `word-break: keep-all` with `overflow-wrap: anywhere`, so Korean words stay whole but a run such as
`500·1,000·2,000헤르츠`, `70+(80×2)+(80×2)+100 = 490`, `2018. 9. 19.` or `제103조 제3항` can still break at `·`, `+`,
`(` or the space inside it; a reader then sees half a number at the end of one line. Each such run is wrapped in
`<span style="white-space:nowrap">`. Only text between tags is touched (never attributes, text inside an element
where a span would not render or would show as text — <script>, <style>, <svg>, <title>, <textarea>, <select>,
<pre>, <code> — or text already inside such a span), and a run longer than MAX characters is left alone, so nothing
new can push past a phone's 350px column.

Usage: python3 tools/wp_publish/nowrap.py body.html > body.nowrap.html
"""
from __future__ import annotations

import re
import sys

OPEN = '<span style="white-space:nowrap">'
MAX = 28

# One alternative per kind of run; the first that matches at a position wins.
RUN = re.compile(
    r"\d{4}\.\s\d{1,2}\.\s\d{1,2}\."  # 2018. 9. 19.
    r"|제\d+조(?:의\d+)?(?:\s제\d+항)?(?:\s제\d+호)?"  # 제103조 제3항 제1호
    r"|[{(]?[\d(][\d,.·()+\-×÷/ ]*[+×÷=][\d,.·()+\-×÷/ =]*[\d)}]"  # {(a…)÷6} is below; this is 70+(80×2) = 490
    r"|[{(]\(?[a-z\d][a-z\d()+×÷/ ]*[+×÷][a-z\d()+×÷/ ]*\)?[)}]"  # {(a+2b+2c+d)÷6}
    r"|[^\s<>(\[〈「]*\d[^\s<>]*"  # any space-free word holding a digit (500·1,000·2,000헤르츠, 90일, 81.67에서); it
    # never starts at an opening bracket, so `(2024. 1. 1. 시행)` and `(제103조 제3항)` reach the date/article runs
)
SKIP = re.compile(
    r"<(script|style|svg|title|textarea|select|pre|code)\b.*?</\1>|<span style=\"white-space:nowrap\">.*?</span>",
    re.DOTALL | re.IGNORECASE,
)
TAG = re.compile(r"(<[^>]+>)")
# A law link often ends in 제N조 with 제N항 just after </a>; the space between them sits outside any one text run, so
# it is made a no-break space instead of wrapping across the tag.
LINKED_ARTICLE = re.compile(r"(제\d+조(?:의\d+)?</a>) (제\d+항)")


def _wrap_text(text: str) -> str:
    def one(m: re.Match[str]) -> str:
        run = m.group(0)
        return run if len(run) > MAX or not re.search(r"\d", run) else f"{OPEN}{run}</span>"

    return RUN.sub(one, text)


def nowrap(html: str) -> str:
    html = LINKED_ARTICLE.sub("\\1\u00a0\\2", html)
    out: list[str] = []
    pos = 0
    for m in SKIP.finditer(html):
        out.append(_wrap_body(html[pos : m.start()]))
        out.append(m.group(0))
        pos = m.end()
    out.append(_wrap_body(html[pos:]))
    return "".join(out)


def _wrap_body(html: str) -> str:
    return "".join(part if part.startswith("<") else _wrap_text(part) for part in TAG.split(html))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        raise SystemExit(2)
    with open(sys.argv[1], encoding="utf-8") as f:
        sys.stdout.write(nowrap(f.read()))
