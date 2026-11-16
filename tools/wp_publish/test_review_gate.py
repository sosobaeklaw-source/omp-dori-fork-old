"""공개 글 쓰기 전 검수 결과 확인. 네트워크는 가짜: python3 -m unittest discover -s tools/wp_publish"""
import hashlib
import json
import tempfile
import unittest
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


def write_post(c):
    return c._open(urllib.request.Request(w.API + "/posts/299", data=json.dumps({"content": "x"}).encode(), method="POST"))


class ReviewGateTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.html = self.dir / "글.html"
        self.html.write_text("<p>추가상병 불승인 처분에 대한 불복 절차</p>\n", encoding="utf-8")
        self.sha = hashlib.sha256(self.html.read_bytes()).hexdigest()

    def client(self):
        c = w.WP(html=self.html)
        c.op = FakeOpener()
        return c

    def test_matching_findings_lets_the_write_through(self):
        (self.dir / "findings.md").write_text(f"sha256: {self.sha}\n\n지적 없음\n", encoding="utf-8")
        c = self.client()
        self.assertEqual(write_post(c)[0], 200)
        self.assertEqual(c.op.sent, [("POST", w.API + "/posts/299")])

    def test_missing_findings_blocks_the_write(self):
        c = self.client()
        with self.assertRaisesRegex(ReviewMissing, "검수 결과 파일이 없다"):
            write_post(c)
        self.assertEqual(c.op.sent, [])

    def test_html_changed_after_review_blocks_the_write(self):
        (self.dir / "findings.md").write_text(f"{self.sha}\n", encoding="utf-8")
        self.html.write_text("<p>검수 뒤 고친 문장</p>\n", encoding="utf-8")
        c = self.client()
        with self.assertRaisesRegex(ReviewMissing, "검수한 글과 쓰려는 글이 다르다"):
            write_post(c)
        self.assertEqual(c.op.sent, [])

    def test_reads_need_no_review(self):
        c = w.WP()
        c.op = FakeOpener()
        c._open(urllib.request.Request(w.API + "/posts/299?context=edit"))
        with self.assertRaisesRegex(ReviewMissing, "WP\\(html=...\\)"):
            write_post(c)
        self.assertEqual(c.op.sent, [("GET", w.API + "/posts/299?context=edit")])


if __name__ == "__main__":
    unittest.main()
