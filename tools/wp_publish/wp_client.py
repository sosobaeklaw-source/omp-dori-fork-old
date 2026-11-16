"""sobaeklaw.co.kr WP REST 쓰기의 공통 길(레인 결과 폴더의 wp_client.py 판 rewrite-299-now·rewrite-hearing-1116 정본).

로그인 정보는 Doppler·wp-totp를 경로로만 부르고 쿠키·비밀값은 메모리에만 둔다.
GET·HEAD 밖의 모든 요청(/wp-json·?rest_route=·wp-admin 어디로 가든)은 _open 한 곳을 지난다. 예외는 login() 안의
로그인 폼 둘뿐. 거기서 막힌 쪽으로 본다(fail closed): 허용한 모양이 아니면 보내지 않는다.
  - 방법은 POST만, 주소는 /wp-json/wp/v2/{posts,pages,media}[/<번호>]와 /wp-json/rankmath/v1/updateMeta만.
  - 그림 올리기(image/*, /media): 올리는 바이트의 sha256이 reviewed.json에 있어야 한다.
  - JSON은 dict만, 아는 칸만. content는 글자(str)만이고 그 sha256이 기록에 있어야 한다.
    본문이 부르는 그림(img·source·video·audio의 src·srcset·poster·data-src 따위)은 하나하나 받아 sha256을 맞추고,
    그 밖 태그의 src·CSS url()은 확인할 길이 없으니 막는다. featured_media·Rank Math 그림도 받아 맞춘다.
  - 제목·요약·대체 글·캡션·Rank Math 설명은 검수한 파일 안에 그 글자 그대로 있어야 한다.
  - status는 draft만 보낼 수 있다(발행 글 갱신은 status를 빼고 보낸다). brand_write_guard.assert_clean도 여기서.
  - 확인한 것이 하나도 없는 요청은 그림 붙이기(post)·draft 같은 메타 칸만일 때만 보낸다.
하나라도 기록에 없으면 어느 것이 읽히지 않았는지 대고 멈춘다. 다 맞으면 findings.md 첫 문단과 읽은 모델을 보여 주고,
리드가 무엇을 열어 보았는지 적은 한 줄(ack, 비어 있으면 안 됨)을 reviewed.json 옆 publish_log.jsonl에 남긴 뒤 보낸다.
WP(reviewed=...)를 주지 않으면 읽기만 된다. 레인 스크립트가 c._open(...)으로 직접 POST해도 같은 검사를 지난다.

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
_META_ONLY = {"status", "post"}
_RM_TEXT = ("rank_math_description", "rank_math_title", "rank_math_facebook_title", "rank_math_facebook_description",
            "rank_math_twitter_title", "rank_math_twitter_description")
_RM_IMAGE = ("rank_math_facebook_image", "rank_math_twitter_image")
_RM_PLAIN = ("rank_math_facebook_image_id", "rank_math_twitter_image_id", "rank_math_twitter_use_facebook")
_MEDIA_TAGS = {"img", "source", "video", "audio", "picture", "track"}
_SRC_ATTR = re.compile(r"(^|[-_])(src|srcset|poster)$")


class _Images(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.urls, self.bad = [], []

    def handle_starttag(self, tag, attrs):
        for k, v in attrs:
            if k == "style" and v and "url(" in v.lower():
                self.bad.append(f"<{tag} style=url(...)>")
            if not _SRC_ATTR.search(k) or not v:
                continue
            if tag not in _MEDIA_TAGS:
                self.bad.append(f"<{tag} {k}>")
            elif k.endswith("srcset"):
                self.urls += [c.split()[0] for c in v.split(",") if c.strip()]
            else:
                self.urls.append(v.strip())


def _body_images(content, where):
    """본문이 부르는 그림 주소 전부. 확인할 수 없는 모양은 막는다."""
    p = _Images()
    p.feed(content)
    p.close()
    if re.search(r"<style\b", content, re.I):
        p.bad.append("<style>")
    if p.bad:
        raise ReviewMissing(f"{where}: 본문에 확인할 수 없는 그림·외부 자원이 있다: {', '.join(dict.fromkeys(p.bad))}")
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

    def _fetch(self, url):
        """검사용 읽기. 받지 못한 그림은 확인 못 한 것이니 막는다."""
        st, _, b = self._open(urllib.request.Request(url, headers={"X-WP-Nonce": self.nonce or ""}))
        if st != 200:
            raise ReviewMissing(f"그림을 받아 확인하지 못했다({st}): {url}")
        return b

    def _gate(self, req):
        """GET·HEAD 밖은 허용한 모양만, 읽은 기록이 있는 글자·그림만 보낸다."""
        method = req.get_method()
        if method in ("GET", "HEAD"):
            return
        where = f"{method} {req.full_url}"
        if self.reviewed is None:
            raise ReviewMissing(f"{where}: 읽은 기록을 WP(reviewed=...)로 주지 않았다")
        doc = load(self.reviewed)
        if not self.ack:
            raise ReviewMissing("리드가 무엇을 열어 보았는지 적은 한 줄(ack)이 비어 있다")
        url = urllib.parse.urlsplit(req.full_url)
        target = f"{url.scheme}://{url.netloc}{url.path}"
        rankmath = target == BASE + "/wp-json/rankmath/v1/updateMeta"
        if method != "POST" or url.query or not (rankmath or _WP_PATH.fullmatch(target)):
            raise ReviewMissing(f"{where}: 보낼 수 있는 곳이 아니다(POST {API}/posts|pages|media[/번호], Rank Math updateMeta만)")
        body = req.data or b""
        ctype = (req.get_header("Content-type") or "").split(";")[0].strip().lower()
        if ctype.startswith("image/"):
            if target != API + "/media":
                raise ReviewMissing(f"{where}: 그림은 {API}/media로만 올린다")
            check_bytes(doc, [(f"올리는 그림 {req.get_header('Content-disposition') or ''}".strip(), body)])
        elif ctype == "application/json":
            self._gate_json(doc, where, json.loads(body or b"null"), rankmath)
        else:
            raise ReviewMissing(f"{where}: JSON·그림 밖 본문({ctype or '형식 없음'})은 보내지 않는다")
        print(f"[검수 기록] 읽은 모델 {doc.get('model')} · {doc.get('at')}\n{first_paragraph(doc)}\n[리드] {self.ack}")
        log = Path(self.reviewed).with_name("publish_log.jsonl")
        with log.open("a", encoding="utf-8") as f:
            f.write(json.dumps({"at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
                                "request": f"{method} {req.full_url}", "reviewed": str(self.reviewed),
                                "ack": self.ack}, ensure_ascii=False) + "\n")

    def _gate_json(self, doc, where, payload, rankmath):
        if not isinstance(payload, dict) or not payload:
            raise ReviewMissing(f"{where}: JSON은 칸이 있는 객체(dict)만 보낸다")
        if rankmath:
            if set(payload) != {"objectType", "objectID", "meta"} or not isinstance(payload["meta"], dict):
                raise ReviewMissing(f"{where}: Rank Math는 objectType·objectID·meta만 보낸다")
            fields, texts_keys, image_keys, plain = payload["meta"], _RM_TEXT, _RM_IMAGE, _RM_PLAIN
        else:
            fields, texts_keys, image_keys, plain = payload, _TEXT, (), _PLAIN
        unknown = sorted(set(fields) - set(texts_keys) - set(image_keys) - set(plain) - {"content", "featured_media"})
        if unknown:
            raise ReviewMissing(f"{where}: 확인하지 않는 칸은 보내지 않는다: {', '.join(unknown)}")
        if payload.get("status", "draft") != "draft":
            raise ReviewMissing(f"{where}: status는 draft만 보낸다(발행 글 갱신은 status를 빼고 보낸다)")
        assert_clean(payload, context=where)
        items, texts = [], []
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
        if fields.get("featured_media"):
            m = json.loads(self._fetch(f"{API}/media/{int(fields['featured_media'])}"))
            items.append((f"대표 그림 {m['source_url'].rsplit('/', 1)[-1]}", self._fetch(m["source_url"])))
        if not items and not texts and not set(fields) <= _META_ONLY:
            raise ReviewMissing(f"{where}: 확인할 글자·그림이 하나도 없는 요청이다")
        check_bytes(doc, items)
        check_texts(doc, texts)

    def _open(self, req, timeout=60, _login_form=False):
        if not _login_form:
            self._gate(req)
        try:
            r = self.op.open(req, timeout=timeout)
            return r.status, r.geturl(), r.read()
        except urllib.error.HTTPError as e:
            return e.code, req.full_url, e.read()

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
        st, _, b = self._open(urllib.request.Request(
            API + "/media", data=file.read_bytes(), method="POST",
            headers={"X-WP-Nonce": self.nonce, "Content-Type": mime,
                     "Content-Disposition": f'attachment; filename="{file.name}"'}), timeout=180)
        if st not in (200, 201):
            raise SystemExit(f"upload {file.name} → {st} {b[:300]!r}")
        m = json.loads(b)
        return self.post_json(f"/media/{m['id']}", {"alt_text": alt, "caption": caption, "post": post_id},
                              context=f"media meta {m['id']}")
