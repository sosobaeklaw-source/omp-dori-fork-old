"""Keep numbers, number+unit, article references and formulas on one line in a published body.

The theme sets `word-break: keep-all` with `overflow-wrap: anywhere`, so Korean words stay whole but a run such as
`500·1,000·2,000헤르츠`, `70+(80×2)+(80×2)+100 = 490`, `2018. 9. 19.` or `제103조 제3항` can still break at `·`, `+`,
`(` or the space inside it; a reader then sees half a number at the end of one line. Each such run is wrapped in
`<span style="white-space:nowrap">`. Only text between tags is touched (never attributes or comments, even when they
hold a `>`; never text inside an element where a span would not render or would show as text — <script>, <style>,
<svg>, <title>, <textarea>, <select>, <pre>, <code> — nor inside <h1>–<h3>, whose large type would push even a short
run past the column; nor text already inside such a span), and a run wider than MAX_WIDTH is left alone, so nothing
new can push past a phone's 350px column at body size.

Usage: python3 tools/wp_publish/nowrap.py body.html > body.nowrap.html
"""
from __future__ import annotations

import re
import sys
import unicodedata

OPEN = '<span style="white-space:nowrap">'
# Width in half-em cells: Hangul and other wide characters count 2, the rest 1. 36 cells is about 18em, roughly 290px
# at a 16px body, so a wrapped run fits a 350px column with room to spare.
MAX_WIDTH = 36

# One alternative per kind of run; the first that matches at a position wins. A date or article may follow other
# space-free characters (`&#8211;2018. 9. 19.`), but never an opening bracket, which it sits inside instead.
LEAD = r"[^\s<>(\[〈「]*"
RUN = re.compile(
    LEAD + r"\d{4}\.\s\d{1,2}\.\s\d{1,2}\."  # 2018. 9. 19.
    r"|" + LEAD + r"제\d+조(?:의\d+)?(?:\s제\d+항)?(?:\s제\d+호)?"  # 제103조 제3항 제1호
    # 70+(80×2)+(80×2)+100 = 490: operands joined by operators, a space allowed only beside an operator, so a long
    # run of digits and spaces cannot backtrack
    r"|[{(]*\d[\d,.·]*[)}]*(?:\s?[+\-×÷=/]\s?[{(]*\d[\d,.·]*[)}]*)+"
    r"|[{(]\(?[a-z\d][a-z\d()+×÷/ ]*[+×÷][a-z\d()+×÷/ ]*\)?[)}]"  # {(a+2b+2c+d)÷6}
    r"|" + LEAD + r"\d[^\s<>]*"  # any space-free word holding a digit (500·1,000·2,000헤르츠, 90일, 81.67에서); it
    # never starts at an opening bracket, so `(2024. 1. 1. 시행)` and `(제103조 제3항)` reach the date/article runs
)
SKIP = re.compile(
    r"<!--.*?-->|<(script|style|svg|title|textarea|select|pre|code|h[1-3])\b.*?</\1>"
    r"|<span style=\"white-space:nowrap\">.*?</span>",
    re.DOTALL | re.IGNORECASE,
)
# A tag ends at the first `>` outside quotes, so `<a title="40dB > 25dB">` stays one tag.
TAG = re.compile(r"(<(?:\"[^\"]*\"|'[^']*'|[^'\">])*>)")
# A law link often ends in 제N조 with 제N항 just after </a>; the space between them sits outside any one text run, so
# it is made a no-break space instead of wrapping across the tag.
LINKED_ARTICLE = re.compile(r"(제\d+조(?:의\d+)?</a>) (제\d+항)")


def _width(run: str) -> int:
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in run)


def _wrap_text(text: str) -> str:
    def one(m: re.Match[str]) -> str:
        run = m.group(0)
        return run if _width(run) > MAX_WIDTH or not re.search(r"\d", run) else f"{OPEN}{run}</span>"

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
