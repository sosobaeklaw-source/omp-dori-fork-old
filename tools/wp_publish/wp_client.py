"""sobaeklaw.co.kr WP REST 쓰기의 공통 길(레인 결과 폴더의 wp_client.py 판 rewrite-299-now·rewrite-hearing-1116 정본).

로그인 정보는 Doppler·wp-totp를 경로로만 부르고 쿠키·비밀값은 메모리에만 둔다.
GET·HEAD 밖의 모든 요청(/wp-json·?rest_route=·wp-admin 어디로 가든)은 _open 한 곳을 지난다. _open에는 검사를 건너뛰는
인자가 없다. 로그인 폼 POST 둘만 비공개 _login_post가 op.open을 바로 부르고, 그 주소는 우리 로그인 화면 하나로 묶었다.
거기서 막힌 쪽으로 본다(fail closed): 허용한 모양이 아니면 보내지 않는다.
  - 방법은 POST만(X-HTTP-Method-Override 헤더 금지), 주소는 /wp-json/wp/v2/{posts,pages,media}[/<번호>]와
    /wp-json/rankmath/v1/updateMeta만.
  - GET·HEAD라도 방법 바꾸기(?_method=·X-HTTP-Method-Override)가 붙으면 보내지 않는다. 쿼리 키는 PHP처럼 앞 공백을 벗기고
    소문자·공백·점·[ → _로 맞춘 뒤 method가 들어 있기만 해도 막는다(WP REST는 GET ?_method=DELETE를 삭제로 처리한다).
    읽기 자리도 묶는다: REST 글·페이지·그림, 로그인 화면·nonce, Rank Math getHead, 초안 미리보기, 올린 그림 파일만.
    wp-admin/post.php?action=trash 같은 관리 화면 GET은 보내지 않는다.
  - 그림 올리기(image/*, /media): 올리는 바이트의 sha256이 reviewed.json에 있어야 한다.
  - JSON은 dict만, 아는 칸만. content는 글자(str)만이고 그 sha256이 기록에 있어야 한다.
    본문 HTML은 허용 목록으로 읽는다: 아는 태그·속성만 받고 모르는 것(script·iframe·object·embed·srcdoc 따위)은 막는다.
    그림·영상 태그(img·source·video·audio·track)의 src·srcset·poster·data-src는 하나하나 받아 sha256을 맞추고,
    <a href> 말고 바깥 자원을 부르는 속성, style 속 url·image·역슬래시, 그림을 서버에서 넣을 수 있는 것
    (wp:블록 주석 밖의 주석, 그림·동적 블록, [단축코드], 한 줄짜리 주소(oEmbed — WP autoembed 정규식 둘 다:
    줄 전체가 주소인 것, 속성이 붙은 <p>URL</p> 본문 어디든), 닫히지 않은 채 끝나는 태그, SVG 칠 속성의 url( )은
    확인할 길이 없으니 막는다.
    featured_media·Rank Math 그림(주소·첨부 번호)도 받아 맞춘다. 검사용으로 받는 그림은 https://sobaeklaw.co.kr·
    wp.sobaeklaw.co.kr의 /wp-content/uploads/ 파일(쿼리 없음)만, nonce 없이 받는다. REST·관리·?rest_route= 주소는
    본문이 가리켜도 받지 않는다. 주소 모양은 무엇이든 받기 전에 다 본다(하나라도 틀리면 네트워크 0번).
    첨부 번호 조회만 고정 주소 API/media/<번호>로 nonce를 실어 읽는다. 리다이렉트도 우리 사이트 안, 그림에서 시작했으면
    올린 그림 자리로만 따라간다(nonce는 딸려 가지 않는다). 다른 곳 그림은 검수 뒤 바뀔 수 있어 막는다.
  - 글자 칸에는 '<'를 넣지 못한다(테마가 HTML로 찍는다). 그 위에 검수 기록 texts의 그 대상 항목과 똑같아야 한다(빈 값도):
    글의 제목·요약·Rank Math 설명은 "post",
    그림(/media/<번호>)의 대체 글·캡션·제목은 그 번호의 source_url로 받은 바이트의 "media:<sha256>".
    방금 올린 그림의 칸은 source_url 말고 방금 올린 바이트로 맞춘다(-scaled 사본은 바이트가 달라진다).
  - status는 새 글 만들기(/posts)에서만 draft로 보낼 수 있다. 기존 글·Rank Math·그림 고침에는 status를 아예 못 넣는다
    (status로 공개 글을 내리는 것을 막는다). brand_write_guard.assert_clean도 여기서.
  - 검수 기록의 글 번호(review_gate --post, 필수)와 URL의 글 번호·Rank Math(objectType=post) objectID·그림을 붙이는
    글 번호(post 칸)가 같아야 한다. 글 번호 없는 기록으로는 글·Rank Math 쓰기를 하지 못 한다.
  - 확인한 것이 하나도 없는 요청은 그림 붙이기(post 칸)만 보낸다.
하나라도 기록에 없으면 어느 것이 읽히지 않았는지 대고 멈춘다. 다 맞으면 findings.md 첫 문단과 읽은 모델을 보여 주고 보낸다.
응답을 받은 뒤 상태 코드와 리드가 무엇을 열어 보았는지 적은 한 줄(ack, 비어 있으면 안 됨)을 reviewed.json 옆
publish_log.jsonl에 남긴다. WP(reviewed=...)를 주지 않으면 읽기만 된다. 레인 스크립트가 c._open(...)으로 직접 보내도
건너뛸 길 없이 같은 검사를 지난다.

옛 레인 결과 폴더의 wp_client.py 복사본 3곳(~/.omp-dori/results/ 아래 rewrite-299-now·rewrite-hearing-1116·
rootfix2-bd-1116/D/work/hearing의 wp/)은 사본(wp_client.py.bak-20261118-gate)을 남기고 이 모듈을 부르는 얇은 판으로 바꿨다.
그 판의 WP()는 env WP_REVIEWED·WP_ACK로 읽은 기록을 받고, 없으면 쓰기를 막는다. 그 폴더 스크립트도 이 검사를 지난다.

사용(레인 스크립트):
    sys.path.insert(0, str(Path.home() / "src/omp-dori/tools/wp_publish"))
    import wp_client as w
    c = w.WP(reviewed="<결과 폴더>/reviewed.json", ack="<리드가 본 것을 자기 말로>")
    c.login()
"""
import http.cookiejar
import html.parser
import datetime
import json
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import review_gate
from review_gate import ReviewMissing, check_bytes, check_texts, first_paragraph, load

sys.path.insert(0, str(Path.home() / "sanjai-agent"))
try:
    from scripts.brand_write_guard import assert_clean  # noqa: E402
except ImportError:  # 시험 환경(CI)에는 sanjai-agent가 없다. 실제 쓰기는 login에서 막힌다.
    def assert_clean(payload, context=""):
        raise RuntimeError("brand_write_guard 없음: ~/sanjai-agent 가 필요하다")

BASE = "https://wp.sobaeklaw.co.kr"
API = BASE + "/wp-json/wp/v2"
_WP_PATH = re.compile(re.escape(API) + r"/(posts|pages|media)(/\d+)?")
_TEXT = ("title", "excerpt", "alt_text", "caption")
_PLAIN = ("status", "post")
_META_ONLY = {"post"}
_IMAGE_HOSTS = {"sobaeklaw.co.kr", "wp.sobaeklaw.co.kr"}
_RM_TEXT = ("rank_math_description", "rank_math_title", "rank_math_facebook_title", "rank_math_facebook_description",
            "rank_math_twitter_title", "rank_math_twitter_description")
_RM_IMAGE = ("rank_math_facebook_image", "rank_math_twitter_image")
_RM_IMAGE_ID = ("rank_math_facebook_image_id", "rank_math_twitter_image_id")
_RM_PLAIN = ("rank_math_twitter_use_facebook",)
_MEDIA_TAGS = {"img", "source", "video", "audio", "track"}
_MEDIA_URL_ATTRS = {"src", "srcset", "poster", "data-src", "data-srcset"}
_COMMON_ATTRS = {"class", "id", "title", "lang", "dir", "role", "style", "width", "height", "align"}
_SVG_TAGS = ("svg", "g", "path", "polyline", "polygon", "line", "circle", "rect", "ellipse")
_SVG_ATTRS = {"viewbox", "xmlns", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "points", "d",
              "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "transform", "opacity"}
_TAG_ATTRS = {
    **{t: set() for t in ("p", "div", "span", "strong", "b", "em", "i", "u", "s", "mark", "small", "sub", "sup", "br", "hr",
                          "h1", "h2", "h3", "h4", "h5", "h6", "ul", "li", "dl", "dt", "dd", "blockquote", "q", "cite",
                          "code", "pre", "kbd", "abbr", "del", "ins", "figure", "figcaption", "picture", "caption",
                          "table", "thead", "tbody", "tfoot", "tr", "colgroup", "summary",
                          "main", "header", "footer", "section", "article", "aside", "nav")},
    "a": {"href", "rel", "target", "name"}, "ol": {"start", "reversed", "type"}, "col": {"span"},
    "td": {"colspan", "rowspan", "headers", "data-label"}, "th": {"colspan", "rowspan", "headers", "scope", "data-label"},
    "time": {"datetime"}, "details": {"open"},
    "img": _MEDIA_URL_ATTRS | {"alt", "sizes", "loading", "decoding"},
    "source": _MEDIA_URL_ATTRS | {"type", "media", "sizes"},
    "video": {"src", "poster", "controls", "preload", "muted", "loop", "playsinline", "autoplay"},
    "audio": {"src", "controls", "preload", "muted", "loop"},
    "track": {"src", "kind", "srclang", "label", "default"},
    **{t: _SVG_ATTRS | {"aria-hidden", "focusable"} for t in _SVG_TAGS},
}
_BLOCKS = {"paragraph", "heading", "list", "list-item", "table", "quote", "pullquote", "separator", "spacer", "group",
           "columns", "column", "details", "html", "preformatted", "code"}
_BLOCK_KEYS = {"anchor", "align", "className", "level", "ordered", "reversed", "start", "lock", "metadata",
               "textColor", "backgroundColor", "fontSize", "gradient", "style"}
_STYLE_KEYS = {"color", "typography", "spacing", "border", "dimensions"}  # background* 는 그림이 되니 아예 없앤다
_BLOCK_COMMENT = re.compile(r"<!-- /?wp:([a-z0-9-]+(?:/[a-z0-9-]+)?)(?: (\{(?:(?!-->)[^<>])*\}))? /?-->")
_BLOCK_ATTR_MEDIA = re.compile(r"url|src|image|media|featured|\"ids?\"|//", re.I)
_SHORTCODE = re.compile(r"\[\[?/?(?!dB\()[\w-]", re.A)  # WP get_shortcode_regex의 [\w-](PHP /u 없음 → ASCII): 이름은 _·숫자로도 시작한다. [dB(A)] 같은 소음 단위는 글자다
_OEMBED_LINE = re.compile(r'^(\s*)(https?://[^\s<>"]+)(\s*)$', re.I | re.M | re.A)  # WP |^(\s*)(https?://[^\s<>"]+)(\s*)$|im — 글자 하나까지 같게
_OEMBED_P = re.compile(r'(<p(?: [^>]*)?>\s*)(https?://[^\s<>"]+)(\s*</p>)', re.I | re.A)  # WP |(<p(?: [^>]*)?>\s*)(https?://[^\s<>"]+)(\s*<\/p>)|i — PHP \s는 /u 없이 ASCII(re.A)
_STYLE_BAD = re.compile(r"\\|url|image|expression|@|/\*", re.I)
_PAINT_URL = re.compile(r"url\s*\(|\\", re.I)  # SVG 칠 속성(fill·stroke…)의 값도 css url(·역슬래시를 못 쓰게
_HREF_OK = re.compile(r"(https?:|mailto:|tel:|#|/(?![/\\]))", re.I)  # /\ 처럼 역슬래시는 브라우저는 슬래시로 읽는다
_UPLOAD_PATH = re.compile(r"/wp-content/uploads/[^?#\\]+")  # 검사용으로 받는 그림은 올린 파일 자리만(REST·관리 화면 아님)
_SNEAKY_PATH = re.compile(r"(^|/)\.\.?(/|$)|%2e|%2f|%5c", re.I)  # ../ 이나 인코딩한 점·슬래시로 다른 자리로 빠지지 않게


def _query_keys(url):
    """PHP가 읽는 이름으로 바꾼 쿼리 키들. PHP처럼 앞 공백을 벗기고(여기선 공백 문자 전부) 소문자, 공백·점·[ → _.
    `+_method`·`%20_method`·`.method`·`_METHOD`·`_method[]`도 _method로 본다."""
    keys = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query, keep_blank_values=True)
    return {re.sub(r"[ .\[]", "_", k.lstrip().lower()) for k in keys}


def _method_override(url, headers=()):
    """WP REST가 방법을 바꿔 읽는 신호(?_method=, X-HTTP-Method-Override)가 있으면 그 이름, 없으면 None.
    GET이라도 이것이 붙으면 서버는 DELETE·POST로 처리한다(class-wp-rest-server.php serve_request).
    쿼리는 넓게 본다: 벗긴 키에 method가 들어 있기만 해도 신호로 본다."""
    for k in _query_keys(url):
        if "method" in k:
            return f"쿼리 {k}"
    for h in headers:
        if "method" in h.lower().replace("_", "-") and "override" in h.lower():
            return f"헤더 {h}"
    return None


_REST_READ = re.compile(r"/wp-json/wp/v2/(posts|pages|media)(/[1-9][0-9]*)?/?")
_PREVIEW_KEYS = {"p", "page_id", "preview", "preview_id", "preview_nonce"}  # 레인이 쓰는 초안 미리보기(읽기만)


def _read_ok(url, method="GET"):
    """로그인한 채 보내는 읽기(GET·HEAD)도 자리를 묶는다: REST 읽기(글·페이지·그림), 로그인 화면, REST nonce 받기,
    올린 그림 파일만. wp-admin/post.php?action=trash 처럼 GET으로 일을 하는 관리 주소는 보내지 않는다."""
    u = urllib.parse.urlsplit(url)
    if f"{u.scheme}://{u.netloc}" == BASE and not u.fragment and "rest_route" not in _query_keys(url):
        if _REST_READ.fullmatch(u.path) or (u.path.rstrip("/") == "/sbk-entrance" and not u.query):
            return
        if u.path == "/wp-json/rankmath/v1/getHead" and _query_keys(url) == {"url"}:
            return
        if "preview" in _query_keys(url) and _query_keys(url) <= _PREVIEW_KEYS and not u.path.startswith(("/wp-", "/xmlrpc")):
            return
        if u.path == "/wp-admin/admin-ajax.php" and u.query == "action=rest-nonce":
            return
    try:
        _image_url_ok(url)
    except ReviewMissing:
        raise ReviewMissing(f"{method} {url[:100]}: 읽기는 REST 글·페이지·그림, 로그인 화면, nonce, 올린 그림 파일만 보낸다"
                            "(관리 화면 GET은 글을 지우거나 바꿀 수 있다)") from None


def _image_url_ok(url):
    """검사용으로 받아 볼 수 있는 그림 주소인지. https 우리 사이트의 /wp-content/uploads/ 파일, 쿼리 없음만."""
    u = urllib.parse.urlsplit(url)
    if u.scheme != "https" or u.hostname not in _IMAGE_HOSTS or u.username or u.port:
        raise ReviewMissing(f"우리 사이트(https://{'·'.join(sorted(_IMAGE_HOSTS))}) 그림이 아니라 확인할 수 없다: {url[:80]}")
    if u.query or not _UPLOAD_PATH.fullmatch(u.path) or _SNEAKY_PATH.search(u.path):
        raise ReviewMissing(f"올린 그림 자리(/wp-content/uploads/…, 쿼리 없음)가 아니라 받아 보지 않는다: {url[:80]}")



class _Images(html.parser.HTMLParser):
    """허용 목록: 아는 태그·속성만 받는다. 그림·영상 태그의 주소 속성은 모아 대조하고, 그 밖은 막는다."""

    def __init__(self):
        super().__init__(convert_charrefs=False)  # &lt; 같은 글자 참조는 handle_entityref로 따로 와서 아래 검사를 비켜 간다
        self.urls, self.bad = [], []

    def handle_starttag(self, tag, attrs):
        allowed = _TAG_ATTRS.get(tag)
        if allowed is None:
            self.bad.append(f"<{tag}>")
            return
        for k, v in attrs:
            if k not in allowed and k not in _COMMON_ATTRS and not k.startswith("aria-"):
                self.bad.append(f"<{tag} {k}>")
            elif k == "style" and v and _STYLE_BAD.search(v):
                self.bad.append(f"<{tag} style=…>")
            elif tag in _SVG_TAGS and v and _PAINT_URL.search(v):
                self.bad.append(f"<{tag} {k}=…>")
            elif tag == "a" and k == "href" and v and not _HREF_OK.match(v.strip()):
                self.bad.append(f"<a href={v.strip()[:20]}>")
            elif tag in _MEDIA_TAGS and k in _MEDIA_URL_ATTRS and v:
                if k.endswith("srcset"):
                    self.urls += [c.split()[0] for c in v.split(",") if c.strip()]
                else:
                    self.urls.append(v.strip())

    handle_startendtag = handle_starttag

    def handle_data(self, data):
        if re.search(r"<[A-Za-z/!?]", data):  # 이 파서는 글자로 읽었지만 브라우저는 태그로 읽을 수 있는 조각
            self.bad.append("읽지 못한 < 조각")

    def handle_comment(self, data):
        if not _BLOCK_COMMENT.fullmatch(f"<!--{data}-->"):
            self.bad.append(f"wp 블록이 아닌 주석 {data[:12]!r}")

    def handle_decl(self, decl):
        self.bad.append(f"<!{decl[:20]}>")

    def unknown_decl(self, data):
        self.bad.append(f"<![{data[:20]}>")

    def handle_pi(self, data):
        self.bad.append(f"<?{data[:20]}>")


def _body_images(content, where):
    """본문이 부르는 그림 주소 전부. 확인할 수 없는 모양은 막는다."""
    bad = []
    pos = 0
    while (i := content.find("<!--", pos)) >= 0:
        m = _BLOCK_COMMENT.match(content, i)
        if not m:
            bad.append(f"wp 블록이 아닌 주석 {content[i:i + 12]!r}")
            pos = i + 4
            continue
        name, attrs = m.group(1), m.group(2) or ""
        if name.removeprefix("core/") not in _BLOCKS:
            bad.append(f"wp:{name} 블록")
        elif attrs:
            bad += _block_attr_bad(name, attrs)
        pos = m.end()
    if m := _SHORTCODE.search(content):
        bad.append(f"단축코드 {m.group(0)}")
    t = content.rstrip()
    if t.rfind("<") > t.rfind(">"):  # 태그가 닫히지 않은 채 본문이 끝난다 — 브라우저는 theme 마크업 뒤에서 태그를 마저 읽는다
        bad.append("태그가 닫히지 않은 채 끝난 본문")
    if m := _OEMBED_LINE.search(content):
        bad.append(f"한 줄짜리 주소(oEmbed) {m.group(0).strip()[:40]}")
    if m := _OEMBED_P.search(content):
        bad.append(f"한 줄짜리 주소(oEmbed) {m.group(2)[:40]}")
    p = _Images()
    p.feed(content)
    if p.rawdata.strip():  # 파서가 못 끝낸 조각: close()가 그냥 버리면 브라우저와 읽는 게 달라진다
        bad.append(f"끝까지 읽히지 않은 조각 {p.rawdata.strip()[:20]!r}")
    p.close()
    bad += p.bad
    if bad:
        raise ReviewMissing(f"{where}: 본문에 확인할 수 없는 그림·외부 자원이 있다: {', '.join(dict.fromkeys(bad))}")
    return list(dict.fromkeys(p.urls))


def _walk_block_attrs(obj, path=""):
    """풀린 블록 속성을 걸어 다니며 확인할 수 없는 키·값을 찾는다(\\uXXXX·\\/ 이스케이프로 숨겨도 풀린 값을 본다)."""
    off = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            full = k if path == "" else f"{path}.{k}"
            if _BLOCK_ATTR_MEDIA.search(k):
                off.append(f"키 {full}")
            elif path == "" and k not in _BLOCK_KEYS:
                off.append(f"키 {full}")
            elif path == "metadata" and k != "name":  # bindings 은 서버가 검수 밖 글자로 바꿔 넣는다
                off.append(f"키 {full}")
            elif path == "style" and k not in _STYLE_KEYS:  # style.background* 는 렌더할 때 그림이 된다
                off.append(f"키 {full}")
            elif isinstance(v, (dict, list)):
                off += _walk_block_attrs(v, full)
            elif isinstance(v, str) and _BLOCK_ATTR_MEDIA.search(v):
                off.append(f"값 {full}")
    elif isinstance(obj, list):
        for v in obj:
            off += _walk_block_attrs(v, path)
    return off


def _block_attr_bad(name, attrs):
    """블록 주석의 속성: JSON으로 못 풀거나 걸어 다니며 걸리면 확인할 수 없다."""
    try:
        obj = json.loads(attrs)
    except ValueError:
        return [f"wp:{name} 속성이 JSON으로 풀리지 않는다"]
    if not isinstance(obj, dict):
        return [f"wp:{name} 속성이 객체(dict)가 아니다"]
    return [f"wp:{name} 블록 속성 {o}" for o in _walk_block_attrs(obj)]


def secret(name):
    r = subprocess.run(["doppler", "secrets", "get", name, "--plain", "--project", "sanjai-ai", "--config", "prd"],
                       capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        raise SystemExit("doppler 실패: " + name)
    return r.stdout.strip()


def totp():
    r = subprocess.run([str(Path.home() / ".dori/bin/wp-totp"), "sobaeklaw"], capture_output=True, text=True, timeout=20)
    m = re.search(r"\d{6}", r.stdout or "")
    if r.returncode != 0 or not m:
        raise SystemExit("wp-totp 실패")
    return m.group(0)


class _GateRedirect(urllib.request.HTTPRedirectHandler):
    """리다이렉트도 우리 사이트 https로만, 방법 바꾸기·rest_route 없이 따라간다. 따라가는 요청에 nonce를 싣지 않는다.
    올린 그림 자리에서 시작한 읽기는 올린 그림 자리로만 간다(그림 주소가 REST·관리 주소로 넘기지 못하게)."""

    def redirect_request(self, req, fp, code, msg, hdrs, newurl):
        u = urllib.parse.urlsplit(newurl)
        if (u.scheme != "https" or u.hostname not in _IMAGE_HOSTS or u.username or u.port
                or _method_override(newurl) or "rest_route" in _query_keys(newurl)):
            raise ReviewMissing(f"다른 곳으로 가는 리다이렉트는 따라가지 않는다: {newurl[:80]}")
        if _UPLOAD_PATH.fullmatch(urllib.parse.urlsplit(req.full_url).path):
            _image_url_ok(newurl)
        r = super().redirect_request(req, fp, code, msg, hdrs, newurl)
        if r is not None:
            r.headers.pop("X-wp-nonce", None)  # Request 헤더는 capitalize 로 들어간다
            r.unredirected_hdrs.pop("X-wp-nonce", None)
        return r


class WP:
    def __init__(self, reviewed=None, ack=""):
        self.reviewed, self.ack = reviewed, ack.strip()
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar), _GateRedirect)
        self.op.addheaders = [("User-Agent", "Mozilla/5.0 sobaek-wp-publish")]
        self.nonce = None
        self._uploaded = {}  # 방금 올린 그림 번호 → 올린 바이트. -scaled 사본 말고 이 바이트로 칸을 맞춘다.

    def _read(self, url, headers):
        st, _, b = self._open(urllib.request.Request(url, headers=headers))
        if st != 200:
            raise ReviewMissing(f"그림을 받아 확인하지 못했다({st}): {url}")
        return b

    def _fetch(self, url):
        """검사용 그림 읽기. 우리 사이트 https의 /wp-content/uploads/ 파일(쿼리 없음)만, nonce 없이 받는다.
        본문·Rank Math가 적은 주소는 검수 전 글자라 REST·관리 주소면 받는 것만으로 서버가 움직일 수 있다."""
        _image_url_ok(url)
        return self._read(url, {})

    def _media_json(self, mid):
        """/media/<번호> 읽기. 주소는 여기서 고정해 만들고 nonce는 이 읽기에만 싣는다."""
        return self._read(f"{API}/media/{mid}", {"X-WP-Nonce": self.nonce or ""})

    def _media_bytes(self, where, name, k, media_id):
        """/media/<번호>의 그림 바이트. 방금 올린 그림이면 그 바이트를 그대로 쓴다(-scaled 사본과 무관).
        번호·응답이 이상하면 칸 이름을 대고 멈춘다."""
        try:
            mid = int(media_id)
            if isinstance(media_id, bool) or mid <= 0:
                raise ValueError(media_id)
            mid = str(mid)
            if mid in self._uploaded:
                return f"<방금 올린 그림 {mid}>", self._uploaded[mid]
            m = json.loads(self._media_json(mid))
            src = m["source_url"]
            if not isinstance(src, str):
                raise TypeError(src)
        except (ValueError, TypeError, KeyError) as e:
            raise ReviewMissing(f"{where}: {name}({k}={media_id!r})의 그림 주소를 확인하지 못했다: {e!r}") from None
        return src, self._fetch(src)

    def _gate(self, req):
        """GET·HEAD는 방법 바꾸기 신호만 막고 통과, 그 밖은 허용한 모양만, 읽은 기록이 있는 글자·그림만 보낸다. 쓰기면 True."""
        method = req.get_method()
        if method in ("GET", "HEAD"):
            if sig := _method_override(req.full_url, [h for h, _ in req.header_items()]):
                raise ReviewMissing(f"{method} {req.full_url[:100]}: 방법 바꾸기({sig})가 붙은 읽기는 보내지 않는다"
                                    "(WP REST는 이것을 DELETE·POST로 처리한다)")
            _read_ok(req.full_url, method)
            return False
        where = f"{method} {req.full_url}"
        if self.reviewed is None:
            raise ReviewMissing(f"{where}: 읽은 기록을 WP(reviewed=...)로 주지 않았다")
        doc = load(self.reviewed)
        if not self.ack:
            raise ReviewMissing("리드가 무엇을 열어 보았는지 적은 한 줄(ack)이 비어 있다")
        url = urllib.parse.urlsplit(req.full_url)
        target = f"{url.scheme}://{url.netloc}{url.path}"
        rankmath = target == BASE + "/wp-json/rankmath/v1/updateMeta"
        override = [h for h, _ in req.header_items() if h.lower().replace("_", "-") == "x-http-method-override"]
        if method != "POST" or override or url.query or not (rankmath or _WP_PATH.fullmatch(target)):
            raise ReviewMissing(f"{where}: 보낼 수 있는 곳이 아니다(POST {API}/posts|pages|media[/번호], Rank Math updateMeta만,"
                                " 방법 바꾸기 헤더 금지)")
        if req.unredirected_hdrs:  # urllib은 이것을 headers 위에 덮어 보낸다 — 검사한 형식과 보내는 형식이 갈라지지 않게
            raise ReviewMissing(f"{where}: add_unredirected_header로 붙인 헤더({', '.join(req.unredirected_hdrs)})가 있는 쓰기는"
                                " 보내지 않는다")
        if not isinstance(req.data, bytes):
            raise ReviewMissing(f"{where}: 본문은 bytes만 보낸다(파일·반복자는 검사한 것과 다를 수 있다)")
        body = req.data
        ctype = (req.headers.get("Content-type") or "").split(";")[0].strip().lower()
        if ctype.startswith("image/"):
            if target != API + "/media":
                raise ReviewMissing(f"{where}: 그림은 {API}/media로만 올린다")
            check_bytes(doc, [(f"올리는 그림 {req.headers.get('Content-disposition') or ''}".strip(), body)])
        elif ctype == "application/json":
            self._gate_json(doc, where, json.loads(body or b"null"), rankmath, _WP_PATH.fullmatch(target))
        else:
            raise ReviewMissing(f"{where}: JSON·그림 밖 본문({ctype or '형식 없음'})은 보내지 않는다")
        print(f"[검수 기록] 읽은 모델 {doc.get('model')} · {doc.get('at')}\n{first_paragraph(doc)}\n[리드] {self.ack}")
        return True

    def _log(self, req, status):
        """응답을 받은 뒤 상태 코드와 함께 남긴다. 실패한 쓰기도 실패로 남는다."""
        log = Path(self.reviewed).with_name("publish_log.jsonl")
        with log.open("a", encoding="utf-8") as f:
            f.write(json.dumps({"at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
                                "request": f"{req.get_method()} {req.full_url}", "status": status,
                                "reviewed": str(self.reviewed), "ack": self.ack}, ensure_ascii=False) + "\n")

    def _gate_json(self, doc, where, payload, rankmath, path):
        if not isinstance(payload, dict) or not payload:
            raise ReviewMissing(f"{where}: JSON은 칸이 있는 객체(dict)만 보낸다")
        if rankmath:
            if set(payload) != {"objectType", "objectID", "meta"} or not isinstance(payload["meta"], dict):
                raise ReviewMissing(f"{where}: Rank Math는 objectType·objectID·meta만 보낸다")
            fields, texts_keys, image_keys, plain = payload["meta"], _RM_TEXT, _RM_IMAGE, _RM_PLAIN
            media_keys = ("featured_media",) + _RM_IMAGE_ID
        else:
            fields, texts_keys, image_keys, plain = payload, _TEXT, (), _PLAIN
            media_keys = ("featured_media",)
        unknown = sorted(set(fields) - set(texts_keys) - set(image_keys) - set(plain) - set(media_keys) - {"content"})
        if unknown:
            raise ReviewMissing(f"{where}: 확인하지 않는 칸은 보내지 않는다: {', '.join(unknown)}")
        if "post" in fields and (type(fields["post"]) is not int or fields["post"] <= 0):
            raise ReviewMissing(f"{where}: post는 양의 정수만 보낸다: {fields['post']!r}")
        for k in _RM_PLAIN:
            if rankmath and k in fields and not (isinstance(fields[k], bool) or fields[k] in ("on", "off")):
                raise ReviewMissing(f"{where}: {k}는 'on'·'off'·참거짓만 보낸다: {fields[k]!r}"[:200])
        if "status" in payload:
            if not (path and path.group(1) == "posts" and not path.group(2)):
                raise ReviewMissing(f"{where}: status는 새 글 만들기({API}/posts)에서만 보낸다"
                                    "(기존 글 고칠 땐 status를 뺀다 — 내리기로 쓰지 않게)")
            if payload["status"] != "draft":
                raise ReviewMissing(f"{where}: status는 draft만 보낸다(발행 글 갱신은 status를 빼고 보낸다)")
        assert_clean(payload, context=where)
        post = doc.get("post")
        if (rankmath or (path and path.group(1) in ("posts", "pages"))) and post is None:
            raise ReviewMissing(f"{where}: 검수 기록에 글 번호(post)가 없다. review_gate record --post 로 남겨라")
        if post is not None:
            mid = path.group(2)[1:] if path and path.group(2) else None
            if mid and path.group(1) in ("posts", "pages") and mid != str(post):
                raise ReviewMissing(f"{where}: 검수 기록은 글 {post}용이다. 글 {mid}에는 보내지 않는다")
            if "post" in fields and str(fields["post"]) != str(post):
                raise ReviewMissing(f"{where}: 검수 기록은 글 {post}용이다(그림을 글 {fields['post']!r}에 붙이지 않는다)")
        if rankmath:
            if payload.get("objectType") != "post":
                raise ReviewMissing(f"{where}: Rank Math는 objectType=post만 보낸다(objectType={payload.get('objectType')!r})")
            if str(payload.get("objectID")) != str(post):
                raise ReviewMissing(f"{where}: 검수 기록은 글 {post}용이다(Rank Math objectID={payload.get('objectID')!r})")
        items, texts, target = [], [], "post"
        # 1) 네트워크 없이 볼 수 있는 것을 먼저 다 본다: 글자 칸, 본문 모양, 받을 그림 주소 모양.
        for k in texts_keys:
            if k in fields:
                if not isinstance(fields[k], str):
                    raise ReviewMissing(f"{where}: {k}는 글자(str)만 보낸다")
                if "<" in fields[k]:  # 제목·요약·캡션도 테마가 HTML로 찍는다 — 같은 글자 대조만으로는 안의 그림을 못 본다
                    raise ReviewMissing(f"{where}: {k}에 태그 글자('<')가 있다. 글자 칸에는 태그를 넣지 않는다")
                texts.append((k, fields[k]))
        srcs = []
        if "content" in fields:
            if not isinstance(fields["content"], str):
                raise ReviewMissing(f"{where}: content는 글자(str)만 보낸다(raw 객체 모양 금지)")
            srcs = [(f"본문 그림 {s.rsplit('/', 1)[-1]}", s) for s in _body_images(fields["content"], where)]
        srcs += [(f"{k} {str(fields[k]).rsplit('/', 1)[-1]}", str(fields[k])) for k in image_keys if fields.get(k)]
        for _, s in srcs:
            _image_url_ok(s)
        # 2) 그다음에만 읽는다: 올린 그림 자리(nonce 없음)와 고정 /media/<번호>(nonce).
        if path and path.group(1) == "media":
            if not path.group(2):
                raise ReviewMissing(f"{where}: 그림 칸은 올린 뒤 {API}/media/<번호>로 보낸다")
            src, data = self._media_bytes(where, "고치는 그림", "id", path.group(2)[1:])
            items.append((f"고치는 그림 {src.rsplit('/', 1)[-1]}", data))
            target = f"media:{review_gate.sha(data)}"
        if "content" in fields:
            items.append(("본문", fields["content"].encode("utf-8")))
        for name, s in srcs:
            items.append((name, self._fetch(s)))
        for k in media_keys:
            if fields.get(k):
                name = "대표 그림" if k == "featured_media" else k
                src, data = self._media_bytes(where, name, k, fields[k])
                items.append((f"{name} {src.rsplit('/', 1)[-1]}", data))
        if not items and not texts and not set(fields) <= _META_ONLY:
            raise ReviewMissing(f"{where}: 확인할 글자·그림이 하나도 없는 요청이다")
        check_bytes(doc, items)
        check_texts(doc, target, texts)

    def _open(self, req, timeout=60):
        write = self._gate(req)
        try:
            r = self.op.open(req, timeout=timeout)
            st, url, b = r.status, r.geturl(), r.read()
        except urllib.error.HTTPError as e:
            st, url, b = e.code, req.full_url, e.read()
        except ReviewMissing as e:  # 예: 리다이렉트 거부 — 이미 서버에 닿았을 수 있는 쓰기도 로그에 남긴다
            if write:
                self._log(req, f"막힘 {e}")
            raise
        except OSError as e:
            if write:
                self._log(req, f"네트워크 오류 {e.__class__.__name__}")
            raise
        if write:
            self._log(req, st)
        return st, url, b

    def login(self):
        url = BASE + "/sbk-entrance"
        self._open(urllib.request.Request(url))
        data = {"log": secret("SOBAEKLAW_WP_ADMIN_USER"), "pwd": secret("SOBAEKLAW_WP_ADMIN_PASSWORD"),
                "wp-submit": "Log In", "redirect_to": BASE + "/wp-admin/", "testcookie": "1"}
        _, final, page = self._login_post(url, data, url)
        page = page.decode("utf-8", "replace")
        if "authcode" in page.lower() or "two-factor" in page.lower():
            act = re.search(r'<form[^>]+action="([^"]+)"', page)
            act = act.group(1).replace("&amp;", "&") if act else url
            fields = dict(re.findall(r'<input[^>]+type="hidden"[^>]+name="([^"]+)"[^>]+value="([^"]*)"', page))
            fields.update({"authcode": totp(), "redirect_to": BASE + "/wp-admin/", "wp-submit": "Log In"})
            fields.setdefault("provider", "Two_Factor_Totp")
            _, _, page2 = self._login_post(act, fields, final)
            page = page2.decode("utf-8", "replace")
        if not any(c.name.startswith("wordpress_logged_in") for c in self.jar):
            err = re.search(r'id="login_error"[^>]*>(.*?)</div>', page, re.S)
            raise SystemExit("로그인 실패(logged_in 쿠키 없음) "
                             + (re.sub(r"<[^>]+>", "", err.group(1)).strip()[:160] if err else ""))
        _, _, b = self._open(urllib.request.Request(BASE + "/wp-admin/admin-ajax.php?action=rest-nonce"))
        self.nonce = b.decode().strip()
        if not re.fullmatch(r"[0-9a-f]{10}", self.nonce):
            raise SystemExit("REST nonce 받기 실패")

    def _login_post(self, url, fields, referer):
        """로그인 폼(아이디·비밀번호, 2단계 코드) POST. 글을 바꾸지 않으니 _gate를 지나지 않고 op.open을 바로 부른다.
        그래서 주소를 우리 로그인 화면 하나로 묶는다: 2단계 폼 action은 서버가 준 글자라 다른 곳·방법 바꾸기면 보내지 않는다."""
        u = urllib.parse.urlsplit(url)
        if (f"{u.scheme}://{u.netloc}" != BASE or u.path.rstrip("/") not in ("/sbk-entrance", "/wp-login.php")
                or u.fragment or _method_override(url) or "rest_route" in _query_keys(url)):
            raise ReviewMissing(f"로그인 폼은 {BASE}/sbk-entrance로만 보낸다(방법 바꾸기·rest_route 없이): {url[:80]}")
        req = urllib.request.Request(url, data=urllib.parse.urlencode(fields).encode(), method="POST",
                                     headers={"Content-Type": "application/x-www-form-urlencoded", "Referer": referer})
        try:
            r = self.op.open(req, timeout=60)
            return r.status, r.geturl(), r.read()
        except urllib.error.HTTPError as e:
            return e.code, url, e.read()

    def get(self, path):
        st, _, b = self._open(urllib.request.Request(API + path, headers={"X-WP-Nonce": self.nonce}))
        if st != 200:
            raise SystemExit(f"GET {path} → {st} {b[:200]!r}")
        return json.loads(b)

    def post_json(self, path, payload, context):
        st, _, b = self._open(urllib.request.Request(
            API + path, data=json.dumps(payload).encode(), method="POST",
            headers={"X-WP-Nonce": self.nonce, "Content-Type": "application/json"}))
        if st not in (200, 201):
            raise SystemExit(f"POST {path} → {st} {b[:300]!r}")
        return json.loads(b)

    def upload(self, file, alt, caption, post_id):
        meta = {"alt_text": alt, "caption": caption, "title": file.stem, "post": post_id}
        assert_clean({"file": file.name, **meta}, context=f"media upload {file.name}")
        mime = "image/png" if file.suffix == ".png" else "image/jpeg"
        data = file.read_bytes()
        st, _, b = self._open(urllib.request.Request(
            API + "/media", data=data, method="POST",
            headers={"X-WP-Nonce": self.nonce, "Content-Type": mime,
                     "Content-Disposition": f'attachment; filename="{file.name}"'}), timeout=180)
        if st not in (200, 201):
            raise SystemExit(f"upload {file.name} → {st} {b[:300]!r}")
        m = json.loads(b)
        self._uploaded[str(m["id"])] = data  # 뒤따르는 칸 확인은 source_url(-scaled) 말고 이 바이트로 한다
        return self.post_json(f"/media/{m['id']}", {"alt_text": alt, "caption": caption, "post": post_id},
                              context=f"media meta {m['id']}")
