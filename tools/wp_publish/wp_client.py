"""sobaeklaw.co.kr WP REST 쓰기의 공통 길(레인 결과 폴더의 wp_client.py 판 rewrite-299-now·rewrite-hearing-1116 정본).

로그인 정보는 Doppler·wp-totp를 경로로만 부르고 쿠키·비밀값은 메모리에만 둔다.
GET·HEAD 밖의 모든 요청(초안·갱신·그림 올리기·Rank Math 설명, /wp-json·?rest_route=·wp-admin 어디로 가든)은
_open 한 곳을 지난다. 예외는 login() 안의 로그인 폼 둘뿐. 거기서 검수 에이전트가 남긴 reviewed.json과 맞춰 본다:
  - 그림 올리기(image/*): 올리는 바이트의 sha256이 기록에 있어야 한다.
  - JSON 본문의 content: 그 글자의 sha256이 기록에 있어야 하고, 본문 <img src>가 부르는 그림을 하나하나 받아 sha256을 맞춘다.
  - featured_media(대표 그림): 그 그림 파일을 받아 sha256을 맞춘다.
  - 그 밖 형식의 본문은 보내지 않는다.
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
import datetime
import json
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from review_gate import ReviewMissing, check_bytes, first_paragraph, load

sys.path.insert(0, str(Path.home() / "sanjai-agent"))
try:
    from scripts.brand_write_guard import assert_clean  # noqa: E402
except ImportError:  # 시험 환경(CI)에는 sanjai-agent가 없다. 실제 쓰기는 login에서 막힌다.
    def assert_clean(payload, context=""):
        raise RuntimeError("brand_write_guard 없음: ~/sanjai-agent 가 필요하다")

BASE = "https://wp.sobaeklaw.co.kr"
API = BASE + "/wp-json/wp/v2"


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
        """GET·HEAD 밖은 모두 막고, 읽은 기록이 있는 본문·그림만 보낸다."""
        method = req.get_method()
        if method in ("GET", "HEAD"):
            return
        if self.reviewed is None:
            raise ReviewMissing(f"{method} {req.full_url}: 읽은 기록을 WP(reviewed=...)로 주지 않았다")
        doc = load(self.reviewed)
        if not self.ack:
            raise ReviewMissing("리드가 무엇을 열어 보았는지 적은 한 줄(ack)이 비어 있다")
        body = req.data or b""
        ctype = (req.get_header("Content-type") or "").split(";")[0].strip().lower()
        if ctype.startswith("image/"):
            check_bytes(doc, [(f"올리는 그림 {req.get_header('Content-disposition') or req.full_url}", body)])
        elif ctype == "application/json":
            payload = json.loads(body) if body else {}
            items = []
            if isinstance(payload, dict) and isinstance(payload.get("content"), str):
                items.append(("본문", payload["content"].encode("utf-8")))
                for src in dict.fromkeys(re.findall(r'<img\b[^>]*?\bsrc="([^"]+)"', payload["content"])):
                    items.append((f"본문 그림 {src.rsplit('/', 1)[-1]}", self._fetch(src.replace("&amp;", "&"))))
            if isinstance(payload, dict) and payload.get("featured_media"):
                m = json.loads(self._fetch(f"{API}/media/{payload['featured_media']}"))
                items.append((f"대표 그림 {m['source_url'].rsplit('/', 1)[-1]}", self._fetch(m["source_url"])))
            check_bytes(doc, items)
        else:
            raise ReviewMissing(f"{method} {req.full_url}: JSON·그림 밖 본문({ctype or '형식 없음'})은 보내지 않는다")
        print(f"[검수 기록] 읽은 모델 {doc.get('model')} · {doc.get('at')}\n{first_paragraph(doc)}\n[리드] {self.ack}")
        log = Path(self.reviewed).with_name("publish_log.jsonl")
        with log.open("a", encoding="utf-8") as f:
            f.write(json.dumps({"at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
                                "request": f"{method} {req.full_url}", "reviewed": str(self.reviewed),
                                "ack": self.ack}, ensure_ascii=False) + "\n")

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
        assert payload.get("status", "draft") == "draft", "초안 외 상태는 보내지 않는다"
        assert_clean(payload, context=context)
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
