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
        self.guarded = []
        orig, w.assert_clean = w.assert_clean, lambda payload, context="": self.guarded.append(context)
        self.addCleanup(setattr, w, "assert_clean", orig)
        self.dir = Path(tempfile.mkdtemp())
        self.title = "추가상병 불승인 처분에 대한 불복 절차"
        self.body = f'<p>{self.title}</p>\n<img src="{IMG}" alt="순서">\n'
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

    def test_rest_route_wp_admin_batch_and_other_methods_are_refused(self):
        self.record("본문.html", "flow.png", "cover.jpg")
        c = self.client()
        for url in (w.BASE + "/?rest_route=/wp/v2/posts/299", w.BASE + "/wp-json/batch/v1", w.API + "/users/1",
                    w.API + "/posts/299?status=publish"):
            self.assertBlocked(c, "보낼 수 있는 곳이 아니다", {"content": self.body}, url=url)
        for method in ("DELETE", "PUT", "PATCH"):
            req = urllib.request.Request(w.API + "/posts/299", method=method, headers={"Content-Type": "application/json"})
            with self.assertRaisesRegex(ReviewMissing, "보낼 수 있는 곳이 아니다"):
                c._open(req)
        form = urllib.request.Request(w.BASE + "/wp-admin/post.php", data=urllib.parse.urlencode({"content": "x"}).encode(),
                                      headers={"Content-Type": "application/x-www-form-urlencoded"})
        with self.assertRaisesRegex(ReviewMissing, "보낼 수 있는 곳이 아니다"):
            c._open(form)
        self.assertEqual(c.op.sent, [])

    def test_payload_shapes_that_skip_the_body_check_are_refused(self):
        self.record("본문.html", "flow.png", "cover.jpg")
        c = self.client()
        self.assertBlocked(c, "content는 글자", {"content": {"raw": "<p>읽지 않은 본문</p>"}})
        self.assertBlocked(c, "dict", [{"content": self.body}])
        self.assertBlocked(c, "dict", {})
        self.assertBlocked(c, "확인하지 않는 칸.*slug", {"slug": "x"})
        self.assertBlocked(c, "확인하지 않는 칸.*meta", {"meta": {"rank_math_description": "읽지 않은 설명"}})

    def test_public_text_fields_must_be_in_a_read_file(self):
        self.record("본문.html", "flow.png", "cover.jpg")
        c = self.client()
        self.assertBlocked(c, r"읽히지 않았다\(2개\): title, excerpt", {"title": "읽지 않은 제목", "excerpt": "읽지 않은 요약"})
        rm = w.BASE + "/wp-json/rankmath/v1/updateMeta"
        self.assertBlocked(c, "rank_math_description", {"objectType": "post", "objectID": 299,
                                                         "meta": {"rank_math_description": "읽지 않은 설명"}}, url=rm)
        st, _ = self.post(c, {"objectType": "post", "objectID": 299,
                              "meta": {"rank_math_description": self.title}}, url=rm)
        self.assertEqual(st, 200)
        st, _ = self.post(c, {"title": self.title})
        self.assertEqual(st, 200)

    def test_status_other_than_draft_is_refused_and_brand_guard_runs_on_direct_open(self):
        self.record("본문.html", "flow.png", "cover.jpg")
        c = self.client()
        self.assertBlocked(c, "status는 draft만", {"content": self.body, "status": "publish"})
        st, _ = self.post(c, {"content": self.body})
        self.assertEqual(st, 200)
        self.assertEqual(self.guarded, ["POST " + w.API + "/posts/299"])

    def test_every_image_shape_in_the_body_is_checked(self):
        self.record("본문.html", "flow.png", "cover.jpg")
        c = self.client()
        other = "https://sobaeklaw.co.kr/wp-content/uploads/2026/11/other.png"
        c.op.files[other] = b"PNG-unread"
        for body in (f"<img src='{other}'>", f"<img src={other}>", f'<img src="{IMG}" data-src="{other}">',
                     f'<img src="{IMG}" srcset="{other} 2x">', f'<video poster="{other}"></video>'):
            self.assertBlocked(c, r"본문 그림 other\.png", {"content": body})
        for body in (f'<div style="background:url({other})"></div>', f'<iframe src="{other}"></iframe>',
                     "<style>p{background:url(x)}</style>"):
            self.assertBlocked(c, "확인할 수 없는", {"content": body})

    def test_reads_need_no_review(self):
        c = w.WP()
        c.op = FakeOpener({w.API + "/posts/299?context=edit": b"{}"})
        c._open(urllib.request.Request(w.API + "/posts/299?context=edit"))
        with self.assertRaisesRegex(ReviewMissing, r"WP\(reviewed=...\)"):
            self.post(c, {"content": "x"})
        self.assertEqual(c.op.sent, [])

    def test_check_texts_ignores_files_changed_after_record(self):
        self.record("본문.html", "flow.png", "cover.jpg")
        (self.dir / "본문.html").write_text(self.body + "<p>나중에 끼운 문장</p>", encoding="utf-8")
        with self.assertRaisesRegex(ReviewMissing, "title"):
            review_gate.check_texts(review_gate.load(self.reviewed), [("title", "나중에 끼운 문장")])


if __name__ == "__main__":
    unittest.main()
