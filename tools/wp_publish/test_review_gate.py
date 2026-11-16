"""공개 글에는 읽은 기록(reviewed.json)이 있는 본문·그림만 올린다. 네트워크는 가짜: python3 -m unittest discover -s tools/wp_publish"""
import io
import json
import tempfile
import unittest
import urllib.parse
import urllib.request
from contextlib import redirect_stdout
from pathlib import Path

import review_gate
import wp_client as w
from review_gate import ReviewMissing

IMG = "https://sobaeklaw.co.kr/wp-content/uploads/2026/11/flow.png"
COVER = "https://sobaeklaw.co.kr/wp-content/uploads/2026/11/cover.jpg"


class FakeOpener:
    """그림 주소·media 조회는 files에서 돌려주고, 보낸 요청은 sent에 쌓는다."""
    def __init__(self, files):
        self.files, self.sent = files, []

    def open(self, req, timeout=60):
        if req.get_method() == "GET":
            data = self.files[req.full_url]
        else:
            self.sent.append((req.get_method(), req.full_url))
            data = b"{}"

        class R:
            status = 200

            def geturl(self):
                return req.full_url

            def read(self):
                return data
        return R()


class ReviewGateTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.body = f'<p>추가상병 불승인 처분에 대한 불복 절차</p>\n<img src="{IMG}" alt="순서">\n'
        self.img, self.cover = b"PNG-flow-v1", b"JPG-cover-v1"
        (self.dir / "본문.html").write_text(self.body, encoding="utf-8")
        (self.dir / "flow.png").write_bytes(self.img)
        (self.dir / "cover.jpg").write_bytes(self.cover)
        (self.dir / "findings.md").write_text("# findings\n\n다친 사람으로 읽으면 90일 기한이 첫 화면에 보인다.\n\n- 지적 1\n",
                                              encoding="utf-8")
        self.reviewed = self.dir / "reviewed.json"

    def record(self, *names):
        review_gate.record(self.reviewed, [self.dir / n for n in names], "opencodex/anthropic/claude-opus-5-5",
                           self.dir / "findings.md")

    def client(self, ack="본문 첫 화면과 순서도 그림, 대표 그림을 폰 크기로 열어 봤다"):
        c = w.WP(reviewed=self.reviewed, ack=ack)
        c.op = FakeOpener({IMG: self.img, COVER: self.cover, w.API + "/media/843": json.dumps({"source_url": COVER}).encode()})
        return c

    def post(self, c, payload, url=w.API + "/posts/299"):
        req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST",
                                     headers={"Content-Type": "application/json"})
        with redirect_stdout(io.StringIO()) as out:
            st = c._open(req)[0]
        return st, out.getvalue()

    def assertBlocked(self, c, reason, payload, url=w.API + "/posts/299"):
        with self.assertRaisesRegex(ReviewMissing, reason):
            self.post(c, payload, url)
        self.assertEqual(c.op.sent, [])

    def test_body_and_every_image_read_goes_through_and_logs_the_ack(self):
        self.record("본문.html", "flow.png", "cover.jpg")
        c = self.client()
        st, out = self.post(c, {"content": self.body, "featured_media": 843})
        self.assertEqual(st, 200)
        self.assertEqual(c.op.sent, [("POST", w.API + "/posts/299")])
        self.assertIn("90일 기한이 첫 화면에 보인다", out)
        log = json.loads((self.dir / "publish_log.jsonl").read_text(encoding="utf-8").splitlines()[0])
        self.assertEqual(log["ack"], "본문 첫 화면과 순서도 그림, 대표 그림을 폰 크기로 열어 봤다")

    def test_no_reviewed_record_blocks(self):
        self.assertBlocked(self.client(), "reviewed.json이 없다", {"content": self.body})

    def test_body_other_than_what_was_read_names_the_body(self):
        self.record("본문.html", "flow.png", "cover.jpg")
        self.assertBlocked(self.client(), r"읽히지 않았다\(1개\): 본문\.", {"content": self.body + "<p>덧붙임</p>"})

    def test_image_changed_after_review_names_that_image(self):
        self.record("본문.html", "flow.png", "cover.jpg")
        c = self.client()
        c.op.files[IMG] = b"PNG-flow-v2"
        self.assertBlocked(c, r"읽히지 않았다\(1개\): 본문 그림 flow\.png", {"content": self.body})

    def test_featured_image_not_read_names_the_cover(self):
        self.record("본문.html", "flow.png")
        self.assertBlocked(self.client(), "대표 그림 cover.jpg", {"content": self.body, "featured_media": 843})

    def test_image_upload_must_be_read(self):
        self.record("본문.html", "flow.png")
        c = self.client()
        req = urllib.request.Request(w.API + "/media", data=b"JPG-new", method="POST",
                                     headers={"Content-Type": "image/jpeg", "Content-Disposition": 'attachment; filename="new.jpg"'})
        with self.assertRaisesRegex(ReviewMissing, "올리는 그림"):
            c._open(req)
        self.assertEqual(c.op.sent, [])

    def test_empty_ack_blocks(self):
        self.record("본문.html", "flow.png", "cover.jpg")
        self.assertBlocked(self.client(ack="  "), "ack", {"content": self.body})

    def test_rest_route_and_wp_admin_writes_are_gated_too(self):
        c = self.client()
        self.assertBlocked(c, "reviewed.json이 없다", {"content": "x"}, url=w.BASE + "/?rest_route=/wp/v2/posts/299")
        self.record("본문.html", "flow.png", "cover.jpg")
        form = urllib.request.Request(w.BASE + "/wp-admin/post.php", data=urllib.parse.urlencode({"content": "x"}).encode(),
                                      headers={"Content-Type": "application/x-www-form-urlencoded"})
        with self.assertRaisesRegex(ReviewMissing, "JSON·그림 밖 본문"):
            c._open(form)
        self.assertEqual(c.op.sent, [])

    def test_reads_need_no_review(self):
        c = w.WP()
        c.op = FakeOpener({w.API + "/posts/299?context=edit": b"{}"})
        c._open(urllib.request.Request(w.API + "/posts/299?context=edit"))
        with self.assertRaisesRegex(ReviewMissing, r"WP\(reviewed=...\)"):
            self.post(c, {"content": "x"})
        self.assertEqual(c.op.sent, [])


if __name__ == "__main__":
    unittest.main()
