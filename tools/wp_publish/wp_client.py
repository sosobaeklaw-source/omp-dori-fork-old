"""sobaeklaw.co.kr WP REST 쓰기의 공통 길(레인 결과 폴더의 wp_client.py 판 rewrite-299-now·rewrite-hearing-1116 정본).

로그인 정보는 Doppler·wp-totp를 경로로만 부르고 쿠키·비밀값은 메모리에만 둔다.
GET·HEAD 밖의 모든 요청(초안·갱신·그림 올리기·Rank Math 설명, /wp-json·?rest_route=·wp-admin 어디로 가든)은
_open 한 곳을 지나고, 거기서 review_gate.check(html, findings)가 통과해야 보낸다. 예외는 login() 안의 로그인 폼 둘뿐.
보내는 본문도 검수한 파일에 묶는다: JSON 본문의 content는 그 HTML 파일 글자 그대로여야 하고,
JSON이 아닌 본문은 그림 올리기(Content-Type image/*)만 보낸다. 그러니 검수할 HTML은 실제로 보낼 최종 본문이어야 한다.
WP(html=...)를 주지 않으면 읽기만 된다. 레인 스크립트가 c._open(...)으로 직접 POST해도 같은 검사를 지난다.

사용(레인 스크립트):
    sys.path.insert(0, str(Path.home() / "src/omp-dori/tools/wp_publish"))
    import wp_client as w
    c = w.WP(html="<검수받은 글.html>")      # findings.md는 같은 폴더, 다르면 findings=...
    c.login()
"""
import http.cookiejar
import json
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from review_gate import ReviewMissing, check

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
    def __init__(self, html=None, findings=None):
        self.html, self.findings = html, findings
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.op.addheaders = [("User-Agent", "Mozilla/5.0 sobaek-wp-publish")]
        self.nonce = None

    def _gate(self, req):
        """GET·HEAD 밖은 모두 막고, 검수 통과한 HTML과 같은 본문만 보낸다."""
        method = req.get_method()
        if method in ("GET", "HEAD"):
            return
        if self.html is None:
            raise ReviewMissing(f"{method} {req.full_url}: 검수받은 HTML을 WP(html=...)로 주지 않았다")
        check(self.html, self.findings)
        body = req.data or b""
        ctype = (req.get_header("Content-type") or "").split(";")[0].strip().lower()
        if ctype.startswith("image/"):
            return
        if ctype != "application/json":
            raise ReviewMissing(f"{method} {req.full_url}: JSON·그림 밖 본문({ctype or '형식 없음'})은 보내지 않는다")
        payload = json.loads(body) if body else {}
        if isinstance(payload, dict) and "content" in payload:
            if payload["content"] != Path(self.html).read_text(encoding="utf-8"):
                raise ReviewMissing(f"{method} {req.full_url}: 보내는 content가 검수한 {Path(self.html).name}과 다르다")

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
