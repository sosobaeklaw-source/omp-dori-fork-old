"""공개 글 쓰기 전 검수 결과 확인. 네트워크는 가짜: python3 -m unittest discover -s tools/wp_publish"""
import hashlib
import json
import tempfile
import unittest
import urllib.parse
import urllib.request
from pathlib import Path

import wp_client as w
from review_gate import ReviewMissing


class FakeOpener:
    def __init__(self):
        self.sent = []

    def open(self, req, timeout=60):
        self.sent.append((req.get_method(), req.full_url))

        class R:
            status = 200

            def geturl(self):
                return req.full_url

            def read(self):
                return b"{}"
        return R()


def json_post(c, url, payload):
    return c._open(urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST",
                                          headers={"Content-Type": "application/json"}))


class ReviewGateTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.html = self.dir / "글.html"
        self.body = "<p>추가상병 불승인 처분에 대한 불복 절차</p>\n"
        self.html.write_text(self.body, encoding="utf-8")
        self.sha = hashlib.sha256(self.html.read_bytes()).hexdigest()

    def findings(self, first_line):
        (self.dir / "findings.md").write_text(first_line + "\n\n지적 없음\n", encoding="utf-8")

    def client(self):
        c = w.WP(html=self.html)
        c.op = FakeOpener()
        return c

    def assertBlocked(self, c, reason, send):
        with self.assertRaisesRegex(ReviewMissing, reason):
            send()
        self.assertEqual(c.op.sent, [])

    def test_reviewed_body_with_pass_verdict_goes_through(self):
        self.findings(f"sha256: {self.sha}  verdict: pass")
        c = self.client()
        self.assertEqual(json_post(c, w.API + "/posts/299", {"content": self.body})[0], 200)
        self.assertEqual(c.op.sent, [("POST", w.API + "/posts/299")])

    def test_missing_findings_blocks_the_write(self):
        c = self.client()
        self.assertBlocked(c, "검수 결과 파일이 없다", lambda: json_post(c, w.API + "/posts/299", {"content": self.body}))

    def test_html_changed_after_review_blocks_the_write(self):
        self.findings(f"sha256: {self.sha}  verdict: pass")
        self.html.write_text("<p>검수 뒤 고친 문장</p>\n", encoding="utf-8")
        c = self.client()
        self.assertBlocked(c, "검수한 글과 쓰려는 글이 다르다",
                           lambda: json_post(c, w.API + "/posts/299", {"content": "<p>검수 뒤 고친 문장</p>\n"}))

    def test_content_other_than_the_reviewed_file_is_refused(self):
        self.findings(f"sha256: {self.sha}  verdict: pass")
        c = self.client()
        self.assertBlocked(c, "보내는 content가 검수한", lambda: json_post(c, w.API + "/posts/299", {"content": "x"}))

    def test_failing_verdict_blocks_the_write(self):
        self.findings(f"sha256: {self.sha}  verdict: block")
        c = self.client()
        self.assertBlocked(c, "pass가 아니다", lambda: json_post(c, w.API + "/posts/299", {"content": self.body}))

    def test_rest_route_and_wp_admin_writes_are_gated_too(self):
        c = self.client()
        self.assertBlocked(c, "검수 결과 파일이 없다",
                           lambda: json_post(c, w.BASE + "/?rest_route=/wp/v2/posts/299", {"content": "x"}))
        self.findings(f"sha256: {self.sha}  verdict: pass")
        form = urllib.request.Request(w.BASE + "/wp-admin/post.php", data=urllib.parse.urlencode({"content": "x"}).encode(),
                                      headers={"Content-Type": "application/x-www-form-urlencoded"})
        self.assertBlocked(c, "JSON·그림 밖 본문", lambda: c._open(form))

    def test_reads_need_no_review(self):
        c = w.WP()
        c.op = FakeOpener()
        c._open(urllib.request.Request(w.API + "/posts/299?context=edit"))
        with self.assertRaisesRegex(ReviewMissing, "WP\\(html=...\\)"):
            json_post(c, w.API + "/posts/299", {"content": "x"})
        self.assertEqual(c.op.sent, [("GET", w.API + "/posts/299?context=edit")])


if __name__ == "__main__":
    unittest.main()
