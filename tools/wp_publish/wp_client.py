"""sobaeklaw.co.kr WP REST 쓰기의 공통 길(레인 결과 폴더의 wp_client.py 판 rewrite-299-now·rewrite-hearing-1116 정본).

로그인 정보는 Doppler·wp-totp를 경로로만 부르고 쿠키·비밀값은 메모리에만 둔다.
GET·HEAD 밖의 모든 요청(/wp-json·?rest_route=·wp-admin 어디로 가든)은 _open 한 곳을 지난다. 예외는 login() 안의
로그인 폼 둘뿐. 거기서 막힌 쪽으로 본다(fail closed): 허용한 모양이 아니면 보내지 않는다.
  - 방법은 POST만(X-HTTP-Method-Override 헤더 금지), 주소는 /wp-json/wp/v2/{posts,pages,media}[/<번호>]와
    /wp-json/rankmath/v1/updateMeta만.
  - 그림 올리기(image/*, /media): 올리는 바이트의 sha256이 reviewed.json에 있어야 한다.
  - JSON은 dict만, 아는 칸만. content는 글자(str)만이고 그 sha256이 기록에 있어야 한다.
    본문 HTML은 허용 목록으로 읽는다: 아는 태그·속성만 받고 모르는 것(script·iframe·object·embed·srcdoc 따위)은 막는다.
    그림·영상 태그(img·source·video·audio·track)의 src·srcset·poster·data-src는 하나하나 받아 sha256을 맞추고,
    <a href> 말고 바깥 자원을 부르는 속성, style 속 url·image·역슬래시, 그림을 서버에서 넣을 수 있는 것
    (wp:블록 주석 밖의 주석, 그림·동적 블록, [단축코드], 한 줄짜리 주소(oEmbed — WP autoembed 정규식 둘 다:
    줄 전체가 주소인 것, 속성이 붙은 <p>URL</p> 본문 어디든))은 확인할 길이 없으니 막는다.
    featured_media·Rank Math 그림(주소·첨부 번호)도 받아 맞춘다. 그림은 https://sobaeklaw.co.kr·wp.sobaeklaw.co.kr에서만 받는다
    (다른 곳 그림은 검수 뒤 바뀔 수 있어 막는다).
  - 글자 칸은 검수 기록 texts의 그 대상 항목과 똑같아야 한다(빈 값도): 글의 제목·요약·Rank Math 설명은 "post",
    그림(/media/<번호>)의 대체 글·캡션·제목은 그 번호의 source_url로 받은 바이트의 "media:<sha256>".
    방금 올린 그림의 칸은 source_url 말고 방금 올린 바이트로 맞춘다(-scaled 사본은 바이트가 달라진다).
  - status는 draft만 보낼 수 있다(발행 글 갱신은 status를 빼고 보낸다). brand_write_guard.assert_clean도 여기서.
  - 검수 기록에 글 번호(review_gate --post)가 적혀 있으면 URL의 글 번호·Rank Math objectID와 같아야 한다.
  - 확인한 것이 하나도 없는 요청은 그림 붙이기(post 칸)만 보낸다. status만 보내 공개 글을 내리는 것은 막는다.
하나라도 기록에 없으면 어느 것이 읽히지 않았는지 대고 멈춘다. 다 맞으면 findings.md 첫 문단과 읽은 모델을 보여 주고 보낸다.
응답을 받은 뒤 상태 코드와 리드가 무엇을 열어 보았는지 적은 한 줄(ack, 비어 있으면 안 됨)을 reviewed.json 옆
publish_log.jsonl에 남긴다. WP(reviewed=...)를 주지 않으면 읽기만 된다. 레인 스크립트가 c._open(...)으로 직접 POST해도
같은 검사를 지난다.

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
    **{t: _SVG_ATTRS | {"aria-hidden", "focusable"} for t in ("svg", "g", "path", "polyline", "polygon", "line", "circle",
                                                             "rect", "ellipse")},
}
_BLOCKS = {"paragraph", "heading", "list", "list-item", "table", "quote", "pullquote", "separator", "spacer", "group",
           "columns", "column", "details", "html", "preformatted", "code"}
_BLOCK_COMMENT = re.compile(r"<!-- /?wp:([a-z0-9-]+(?:/[a-z0-9-]+)?)(?: (\{(?:(?!-->)[^<>])*\}))? /?-->")
_BLOCK_ATTR_MEDIA = re.compile(r"url|src|image|media|featured|\"ids?\"|//", re.I)
_SHORTCODE = re.compile(r"\[\[?/?(?!dB\()[A-Za-z][\w-]*")  # [dB(A)] 같은 소음 단위는 글자다(그런 단축코드는 없다)
_OEMBED_LINE = re.compile(r"^\s*(?:<p>\s*)?https?://[^\s<>\"()]+\s*(?:</p>)?\s*$", re.I | re.M)
_OEMBED_P = re.compile(r'(<p(?: [^>]*)?>\s*)(https?://[^\s<>"()]+)(\s*</p>)', re.I)  # WP autoembed: 속성 있는 <p>URL</p> 본문 어디든
_STYLE_BAD = re.compile(r"\\|url|image|expression|@|/\*", re.I)
_HREF_OK = re.compile(r"(https?:|mailto:|tel:|#|/(?![/\\]))", re.I)  # /\ 처럼 역슬래시도 브라우저는 슬래시로 읽는다


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
        elif _BLOCK_ATTR_MEDIA.search(attrs):
            bad.append(f"wp:{name} 블록 속성 {attrs[:30]}")
        pos = m.end()
    if m := _SHORTCODE.search(content):
        bad.append(f"단축코드 {m.group(0)}")
    if m := _OEMBED_LINE.search(content):
        bad.append(f"한 줄짜리 주소(oEmbed) {m.group(0).strip()[:40]}")
    if m := _OEMBED_P.search(content):
        bad.append(f"한 줄짜리 주소(oEmbed) {m.group(2)[:40]}")
    p = _Images()
    p.feed(content)
    p.close()
    bad += p.bad
    if bad:
        raise ReviewMissing(f"{where}: 본문에 확인할 수 없는 그림·외부 자원이 있다: {', '.join(dict.fromkeys(bad))}")
    return list(dict.fromkeys(p.urls))


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


class WP:
    def __init__(self, reviewed=None, ack=""):
        self.reviewed, self.ack = reviewed, ack.strip()
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.op.addheaders = [("User-Agent", "Mozilla/5.0 sobaek-wp-publish")]
        self.nonce = None
        self._uploaded = {}  # 방금 올린 그림 번호 → 올린 바이트. -scaled 사본 말고 이 바이트로 칸을 맞춘다.

    def _fetch(self, url):
        """검사용 읽기. 우리 사이트(https) 그림만 받는다. 받지 못한 그림은 확인 못 한 것이니 막는다. nonce는 우리 WP에만."""
        u = urllib.parse.urlsplit(url)
        if u.scheme != "https" or u.hostname not in _IMAGE_HOSTS or u.username or u.port:
            raise ReviewMissing(f"우리 사이트(https://{'·'.join(sorted(_IMAGE_HOSTS))}) 그림이 아니라 확인할 수 없다: {url[:80]}")
        ours = u.netloc == urllib.parse.urlsplit(BASE).netloc
        st, _, b = self._open(urllib.request.Request(url, headers={"X-WP-Nonce": self.nonce or ""} if ours else {}))
        if st != 200:
            raise ReviewMissing(f"그림을 받아 확인하지 못했다({st}): {url}")
        return b

    def _media_bytes(self, where, name, k, media_id):
        """/media/<번호>의 그림 바이트. 방금 올린 그림이면 그 바이트를 그대로 쓴다(-scaled 사본과 무관).
        번호·응답이 이상하면 칸 이름을 대고 멈춘다."""
        try:
            mid = str(int(media_id))
            if mid in self._uploaded:
                return f"<방금 올린 그림 {mid}>", self._uploaded[mid]
            m = json.loads(self._fetch(f"{API}/media/{mid}"))
            src = m["source_url"]
            if not isinstance(src, str):
                raise TypeError(src)
        except (ValueError, TypeError, KeyError) as e:
            raise ReviewMissing(f"{where}: {name}({k}={media_id!r})의 그림 주소를 확인하지 못했다: {e!r}") from None
        return src, self._fetch(src)

    def _gate(self, req):
        """GET·HEAD 밖은 허용한 모양만, 읽은 기록이 있는 글자·그림만 보낸다. 쓰기면 True."""
        method = req.get_method()
        if method in ("GET", "HEAD"):
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
        body = req.data or b""
        ctype = (req.get_header("Content-type") or "").split(";")[0].strip().lower()
        if ctype.startswith("image/"):
            if target != API + "/media":
                raise ReviewMissing(f"{where}: 그림은 {API}/media로만 올린다")
            check_bytes(doc, [(f"올리는 그림 {req.get_header('Content-disposition') or ''}".strip(), body)])
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
        if payload.get("status", "draft") != "draft":
            raise ReviewMissing(f"{where}: status는 draft만 보낸다(발행 글 갱신은 status를 빼고 보낸다)")
        assert_clean(payload, context=where)
        post = doc.get("post")
        if post is not None:
            mid = path.group(2)[1:] if path and path.group(2) else None
            if mid and path.group(1) in ("posts", "pages") and mid != str(post):
                raise ReviewMissing(f"{where}: 검수 기록은 글 {post}용이다. 글 {mid}에는 보내지 않는다")
            if rankmath and str(payload.get("objectID")) != str(post):
                raise ReviewMissing(f"{where}: 검수 기록은 글 {post}용이다(Rank Math objectID={payload.get('objectID')!r})")
        items, texts, target = [], [], "post"
        if path and path.group(1) == "media":
            if not path.group(2):
                raise ReviewMissing(f"{where}: 그림 칸은 올린 뒤 {API}/media/<번호>로 보낸다")
            src, data = self._media_bytes(where, "고치는 그림", "id", path.group(2)[1:])
            items.append((f"고치는 그림 {src.rsplit('/', 1)[-1]}", data))
            target = f"media:{review_gate.sha(data)}"
        if "content" in fields:
            if not isinstance(fields["content"], str):
                raise ReviewMissing(f"{where}: content는 글자(str)만 보낸다(raw 객체 모양 금지)")
            items.append(("본문", fields["content"].encode("utf-8")))
            for src in _body_images(fields["content"], where):
                items.append((f"본문 그림 {src.rsplit('/', 1)[-1]}", self._fetch(src)))
        for k in texts_keys:
            if k in fields:
                if not isinstance(fields[k], str):
                    raise ReviewMissing(f"{where}: {k}는 글자(str)만 보낸다")
                texts.append((k, fields[k]))
        for k in image_keys:
            if fields.get(k):
                items.append((f"{k} {str(fields[k]).rsplit('/', 1)[-1]}", self._fetch(str(fields[k]))))
        for k in media_keys:
            if fields.get(k):
                name = "대표 그림" if k == "featured_media" else k
                src, data = self._media_bytes(where, name, k, fields[k])
                items.append((f"{name} {src.rsplit('/', 1)[-1]}", data))
        if not items and not texts and not set(fields) <= _META_ONLY:
            raise ReviewMissing(f"{where}: 확인할 글자·그림이 하나도 없는 요청이다")
        check_bytes(doc, items)
        check_texts(doc, target, texts)

    def _open(self, req, timeout=60, _login_form=False):
        write = not _login_form and self._gate(req)
        try:
            r = self.op.open(req, timeout=timeout)
            st, url, b = r.status, r.geturl(), r.read()
        except urllib.error.HTTPError as e:
            st, url, b = e.code, req.full_url, e.read()
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
        _, final, page = self._open(urllib.request.Request(
            url, data=urllib.parse.urlencode(data).encode(),
            headers={"Content-Type": "application/x-www-form-urlencoded", "Referer": url}), _login_form=True)
        page = page.decode("utf-8", "replace")
        if "authcode" in page.lower() or "two-factor" in page.lower():
            act = re.search(r'<form[^>]+action="([^"]+)"', page)
            act = act.group(1).replace("&amp;", "&") if act else url
            fields = dict(re.findall(r'<input[^>]+type="hidden"[^>]+name="([^"]+)"[^>]+value="([^"]*)"', page))
            fields.update({"authcode": totp(), "redirect_to": BASE + "/wp-admin/", "wp-submit": "Log In"})
            fields.setdefault("provider", "Two_Factor_Totp")
            _, _, page2 = self._open(urllib.request.Request(
                act, data=urllib.parse.urlencode(fields).encode(),
                headers={"Content-Type": "application/x-www-form-urlencoded", "Referer": final}), _login_form=True)
            page = page2.decode("utf-8", "replace")
        if not any(c.name.startswith("wordpress_logged_in") for c in self.jar):
            err = re.search(r'id="login_error"[^>]*>(.*?)</div>', page, re.S)
            raise SystemExit("로그인 실패(logged_in 쿠키 없음) "
                             + (re.sub(r"<[^>]+>", "", err.group(1)).strip()[:160] if err else ""))
        _, _, b = self._open(urllib.request.Request(BASE + "/wp-admin/admin-ajax.php?action=rest-nonce"))
        self.nonce = b.decode().strip()
        if not re.fullmatch(r"[0-9a-f]{10}", self.nonce):
            raise SystemExit("REST nonce 받기 실패")

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
