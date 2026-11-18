"""공개 글에는 읽은 기록(reviewed.json)이 있는 본문·그림만 올린다. 네트워크는 가짜: python3 -m unittest discover -s tools/wp_publish"""
import io
import json
import subprocess
import sys
import tempfile
import unittest
import urllib.error
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
    """그림 주소·media 조회는 files에서 돌려주고, 보낸 요청은 sent(GET 밖)·got(GET)에 쌓는다."""
    def __init__(self, files):
        self.files, self.sent, self.got, self.post = files, [], [], {}

    def open(self, req, timeout=60):
        if req.get_method() == "GET":
            self.got.append(req.full_url)
            data = self.files[req.full_url]
        else:
            self.sent.append((req.get_method(), req.full_url))
            data = self.post.get(req.full_url, b"{}")

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

    def record(self, *names, texts=None, media_texts=None, post=299):
        review_gate.record(self.reviewed, [self.dir / n for n in names], "opencodex/anthropic/claude-opus-5-5",
                           self.dir / "findings.md", texts, {self.dir / f: kv for f, kv in (media_texts or {}).items()}, post)

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
        self.assertEqual(log["status"], 200)

    def test_log_is_written_after_the_response_with_its_status(self):
        self.record("본문.html", "flow.png", "cover.jpg")
        c = self.client()
        sent = c.op.open

        def fail(req, timeout=60):
            if req.get_method() == "GET":
                return sent(req)
            raise urllib.error.HTTPError(req.full_url, 500, "boom", {}, io.BytesIO(b"{}"))
        c.op.open = fail
        st, _ = self.post(c, {"content": self.body})
        self.assertEqual(st, 500)
        log = [json.loads(x) for x in (self.dir / "publish_log.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual([x["status"] for x in log], [500])

        def down(req, timeout=60):
            if req.get_method() == "GET":
                return sent(req)
            raise urllib.error.URLError("no route")
        c.op.open = down
        with self.assertRaises(urllib.error.URLError):
            self.post(c, {"content": self.body})
        log = [json.loads(x) for x in (self.dir / "publish_log.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(log[-1]["status"], "네트워크 오류 URLError")

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
        for name in ("X-HTTP-Method-Override", "x-http-method-override", "X_HTTP_METHOD_OVERRIDE"):
            req = urllib.request.Request(w.API + "/posts/299", data=json.dumps({"status": "draft"}).encode(), method="POST",
                                         headers={"Content-Type": "application/json", name: "DELETE"})
            with self.assertRaisesRegex(ReviewMissing, "방법 바꾸기 헤더"):
                c._open(req)
        self.assertEqual(c.op.sent, [])

    def test_payload_shapes_that_skip_the_body_check_are_refused(self):
        self.record("본문.html", "flow.png", "cover.jpg")
        c = self.client()
        self.assertBlocked(c, "content는 글자", {"content": {"raw": "<p>읽지 않은 본문</p>"}})
        self.assertBlocked(c, "dict", [{"content": self.body}])
        self.assertBlocked(c, "dict", {})
        self.assertBlocked(c, "확인하지 않는 칸.*slug", {"slug": "x"})
        self.assertBlocked(c, "확인하지 않는 칸.*meta", {"meta": {"rank_math_description": "읽지 않은 설명"}})

    def test_public_text_fields_must_equal_the_recorded_value(self):
        self.record("본문.html", "flow.png", "cover.jpg", texts={"title": self.title, "rank_math_description": "읽은 설명"})
        c = self.client()
        self.assertBlocked(c, r"읽히지 않았다\(2개\): title, excerpt", {"title": "읽지 않은 제목", "excerpt": "읽지 않은 요약"})
        self.assertBlocked(c, r"읽히지 않았다\(1개\): title", {"title": "추가상병"})  # 본문 속 한 단어
        self.assertBlocked(c, r"읽히지 않았다\(1개\): excerpt", {"excerpt": self.title})  # 다른 칸의 값
        rm = w.BASE + "/wp-json/rankmath/v1/updateMeta"
        self.assertBlocked(c, "rank_math_description", {"objectType": "post", "objectID": 299,
                                                         "meta": {"rank_math_description": "읽은"}}, url=rm)
        st, _ = self.post(c, {"objectType": "post", "objectID": 299,
                              "meta": {"rank_math_description": "읽은 설명"}}, url=rm)
        self.assertEqual(st, 200)
        st, _ = self.post(c, {"title": self.title})
        self.assertEqual(st, 200)

    def test_empty_or_blank_text_fields_need_a_record_too(self):
        self.record("본문.html", "flow.png", "cover.jpg", texts={"title": self.title})
        c = self.client()
        self.assertBlocked(c, r"읽히지 않았다\(1개\): title", {"title": ""})
        self.assertBlocked(c, r"읽히지 않았다\(1개\): excerpt", {"excerpt": " "})
        self.assertBlocked(c, "rank_math_description", {"objectType": "post", "objectID": 299,
                                                         "meta": {"rank_math_description": ""}},
                           url=w.BASE + "/wp-json/rankmath/v1/updateMeta")

    def test_status_alone_cannot_take_a_post_down(self):
        self.record("본문.html", "flow.png", "cover.jpg")
        c = self.client()
        self.assertBlocked(c, "확인할 글자·그림이 하나도 없는", {"status": "draft"}, url=w.API + "/posts")
        self.assertBlocked(c, "status는 새 글 만들기", {"status": "draft"})
        self.assertBlocked(c, "status는 새 글 만들기", {"content": self.body, "status": "draft"})
        self.assertBlocked(c, "status는 새 글 만들기", {"content": self.body, "status": "draft"}, url=w.API + "/pages/299")
        self.assertBlocked(c, "status는 새 글 만들기", {"alt_text": "읽은 설명", "status": "draft"}, url=w.API + "/media/901")
        st, _ = self.post(c, {"content": self.body, "status": "draft"}, url=w.API + "/posts")
        self.assertEqual(st, 200)  # 만들기에서의 status=draft 는 그대로 간다

    def test_two_images_each_with_their_own_alt_and_caption(self):
        (self.dir / "second.png").write_bytes(b"PNG-second")
        self.record("본문.html", "flow.png", "second.png",
                    media_texts={"flow.png": {"alt_text": "첫 그림 설명", "caption": "첫 캡션"},
                                 "second.png": {"alt_text": "둘째 그림 설명", "caption": "둘째 캡션"}})
        c = self.client()
        second = "https://sobaeklaw.co.kr/wp-content/uploads/2026/11/second.png"
        c.op.files.update({second: b"PNG-second", w.API + "/media/901": json.dumps({"source_url": IMG}).encode(),
                           w.API + "/media/902": json.dumps({"source_url": second}).encode()})
        for mid, alt, cap in ((901, "첫 그림 설명", "첫 캡션"), (902, "둘째 그림 설명", "둘째 캡션")):
            st, _ = self.post(c, {"alt_text": alt, "caption": cap, "post": 299}, url=w.API + f"/media/{mid}")
            self.assertEqual(st, 200)
        c.op.sent.clear()
        # 그림을 바꿔 단 설명, 빈 값은 그 그림의 기록과 다르다
        self.assertBlocked(c, r"읽히지 않았다\(1개\): alt_text", {"alt_text": "첫 그림 설명"}, url=w.API + "/media/902")
        self.assertBlocked(c, r"읽히지 않았다\(1개\): caption", {"caption": ""}, url=w.API + "/media/901")
        # 읽지 않은 그림에는 설명을 달 수 없다
        c.op.files[w.API + "/media/903"] = json.dumps({"source_url": COVER}).encode()
        self.assertBlocked(c, "고치는 그림 cover.jpg", {"alt_text": "첫 그림 설명"}, url=w.API + "/media/903")
        self.assertBlocked(c, "media/<번호>", {"alt_text": "첫 그림 설명"}, url=w.API + "/media")

    def test_record_cli_keeps_media_texts_by_image_hash(self):
        out = self.dir / "r2.json"
        subprocess.run([sys.executable, str(Path(review_gate.__file__)), "record", str(out), "--model", "m",
                        "--findings", str(self.dir / "findings.md"), "--post", "299",
                        "--media-text", str(self.dir / "flow.png"), "alt_text=첫 그림",
                        "--media-text", str(self.dir / "flow.png"), "caption=첫 캡션",
                        str(self.dir / "본문.html"), str(self.dir / "flow.png")], check=True, capture_output=True)
        texts = json.loads(out.read_text(encoding="utf-8"))["texts"]
        self.assertEqual(texts["media:" + review_gate.sha(self.img)], {"alt_text": "첫 그림", "caption": "첫 캡션"})

    def test_images_are_fetched_only_from_our_https_site(self):
        self.record("본문.html", "flow.png", "cover.jpg")
        c = self.client()
        for src in ("file:///etc/hosts", "http://sobaeklaw.co.kr/wp-content/uploads/x.png",
                    "https://evil.example/x.png", "https://sobaeklaw.co.kr.evil.example/x.png",
                    "https://user@sobaeklaw.co.kr/x.png", "/wp-content/uploads/x.png"):
            self.assertBlocked(c, "우리 사이트", {"content": f'<img src="{src}">'})

    def test_recorded_post_id_must_match_the_target(self):
        self.record("본문.html", "flow.png", "cover.jpg", post=299)
        c = self.client()
        self.assertBlocked(c, "검수 기록은 글 299용이다. 글 300", {"content": self.body}, url=w.API + "/posts/300")
        rm = w.BASE + "/wp-json/rankmath/v1/updateMeta"
        self.assertBlocked(c, "검수 기록은 글 299용이다.*objectID=300",
                           {"objectType": "post", "objectID": 300, "meta": {"rank_math_description": "x"}}, url=rm)
        st, _ = self.post(c, {"content": self.body})
        self.assertEqual(st, 200)

    def test_upload_meta_is_checked_against_the_uploaded_bytes_not_a_scaled_copy(self):
        self.record("본문.html", "flow.png", media_texts={"flow.png": {"alt_text": "읽은 설명", "caption": "캡션"}})
        scaled = "https://sobaeklaw.co.kr/wp-content/uploads/2026/11/flow-scaled.png"
        c = self.client()
        c.op.post[w.API + "/media"] = json.dumps({"id": 901}).encode()
        c.op.files.update({scaled: b"SCALED-different", w.API + "/media/901": json.dumps({"source_url": scaled}).encode()})
        with redirect_stdout(io.StringIO()):
            c.upload(self.dir / "flow.png", "읽은 설명", "캡션", 299)
        self.assertEqual([u for _, u in c.op.sent], [w.API + "/media", w.API + "/media/901"])
        c2 = self.client()  # 설명이 기록과 다르면 그 그림 바이트의 기록과 다르다고 막힌다
        c2.op.post[w.API + "/media"] = json.dumps({"id": 902}).encode()
        with self.assertRaisesRegex(ReviewMissing, "alt_text"):
            with redirect_stdout(io.StringIO()):
                c2.upload(self.dir / "flow.png", "틀린 설명", "캡션", 299)


    def test_rank_math_objecttype_must_be_post(self):
        self.record("본문.html", "flow.png", "cover.jpg")
        c = self.client()
        rm = w.BASE + "/wp-json/rankmath/v1/updateMeta"
        self.assertBlocked(c, "objectType=post만", {"objectType": "term", "objectID": 299,
                                                    "meta": {"rank_math_description": "x"}}, url=rm)

    def test_media_cannot_attach_an_image_to_another_post(self):
        self.record("본문.html", "flow.png", "cover.jpg")
        c = self.client()
        self.assertBlocked(c, r"검수 기록은 글 299용이다.*글 300", {"alt_text": "x", "post": 300},
                           url=w.API + "/media/901")

    def test_record_without_a_post_refuses_post_and_rank_math_writes(self):
        self.record("본문.html", "flow.png", "cover.jpg", post=None)
        c = self.client()
        self.assertBlocked(c, "검수 기록에 글 번호", {"content": self.body})
        rm = w.BASE + "/wp-json/rankmath/v1/updateMeta"
        self.assertBlocked(c, "검수 기록에 글 번호", {"objectType": "post", "objectID": 299,
                                                    "meta": {"rank_math_description": "x"}}, url=rm)

    def test_rank_math_share_image_ids_are_checked_like_featured_media(self):
        self.record("본문.html", "flow.png", "cover.jpg")
        c = self.client()
        unread = "https://sobaeklaw.co.kr/wp-content/uploads/2026/11/unread.png"
        c.op.files[w.API + "/media/999"] = json.dumps({"source_url": unread}).encode()
        c.op.files[unread] = b"PNG-unread"
        rm = w.BASE + "/wp-json/rankmath/v1/updateMeta"
        for k in ("rank_math_facebook_image_id", "rank_math_twitter_image_id"):
            self.assertBlocked(c, rf"{k} unread\.png", {"objectType": "post", "objectID": 299,
                                                        "meta": {"rank_math_title": self.title, k: 999}}, url=rm)
        st, _ = self.post(c, {"objectType": "post", "objectID": 299,
                              "meta": {"rank_math_facebook_image": COVER, "rank_math_facebook_image_id": 843}}, url=rm)
        self.assertEqual(st, 200)

    def test_bad_media_id_or_answer_names_the_field(self):
        self.record("본문.html", "flow.png", "cover.jpg")
        c = self.client()
        c.op.files[w.API + "/media/7"] = b'{"id": 7}'
        c.op.files[w.API + "/media/8"] = b"not json"
        self.assertBlocked(c, r"대표 그림\(featured_media='x'\)", {"featured_media": "x"})
        self.assertBlocked(c, r"대표 그림\(featured_media=7\).*KeyError", {"featured_media": 7})
        self.assertBlocked(c, r"대표 그림\(featured_media=8\)", {"featured_media": 8})

    def test_status_other_than_draft_is_refused_and_brand_guard_runs_on_direct_open(self):
        self.record("본문.html", "flow.png", "cover.jpg")
        c = self.client()
        self.assertBlocked(c, "status는 draft만", {"content": self.body, "status": "publish"}, url=w.API + "/posts")
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
                     "<style>p{background:url(x)}</style>", f'<svg><image href="{other}"/></svg>',
                     f'<svg><image xlink:href="{other}"/></svg>', f'<object data="{other}"></object>',
                     f'<link rel="stylesheet" href="{other}">', f'<table background="{other}"></table>',
                     f'<picture srcset="{other}"></picture>',
                     # 네 번째 리뷰: 이 파서와 브라우저가 다르게 읽는 모양, 서버가 그림을 넣는 모양
                     f'<!--><img src="{other}"> -->', f'<!---><img src="{other}"> -->', "<!-- 그냥 주석 -->",
                     '[gallery ids="901,902"]', '<p>[caption id="a"]x[/caption]</p>',
                     '<!-- wp:latest-posts {"displayFeaturedImage":true} /-->', '<!-- wp:image {"id":901} -->',
                     '<!-- wp:gallery -->', '<!-- wp:paragraph {"style":{"background":"url(x)"}} -->',
                     '<!-- wp:paragraph {"x":"--><img src=x>"} -->',
                     f'<iframe srcdoc="&lt;img src={other}&gt;"></iframe>', f'<p srcdoc="x">a</p>',
                     f'<script>document.write("<img src={other}>")</script>',
                     '<script type="application/ld+json">{"image":"x"}</script>',
                     f"<p style=\"background-image:image-set('{other}' 1x)\">a</p>",
                     f'<p style="background:u\\72l({other})">a</p>', "<embed src=x>", "<form action=x></form>",
                     "<a href=\"javascript:alert(1)\">a</a>", "<a href=\"//evil.example/x\">a</a>",
                     '<a href="/\\evil.example/x">a</a>',
                     "https://www.youtube.com/watch?v=abc", "<p>https://twitter.com/x/status/1</p>",
                     '<p class="embed">https://www.youtube.com/watch?v=abc</p>',
                     '<p>앞 문장</p><p>https://www.youtube.com/watch?v=a</p>',
                     "<p>a</p>\nhttps://www.youtube.com/watch?v=dQw4W9WgXcQ&t=(1)\n",
                     '<p class="x">https://www.youtube.com/watch?v=dQw4W9WgXcQ&t=(1)</p>',
                     "<p>a</p>\nhttps://www.youtube.com/watch?v=dQw4W9WgXcQ&a=\u00a0b\n",
                     "<p>a <![CDATA[x]]> b</p>", "<?php echo 1 ?>"):
            self.assertBlocked(c, "확인할 수 없는", {"content": body})

    def test_ordinary_post_shapes_still_go_through(self):
        body = ('<!-- wp:heading {"level":3} -->\n<h3 id="a">제목</h3>\n<!-- /wp:heading -->\n'
                '<!-- wp:paragraph -->\n<p>본문 <a href="https://www.law.go.kr/x" rel="noopener" target="_blank">법령</a>'
                ' <a href="#a">위로</a> <a href="/contact/">문의</a> 1 &lt; 2, 85[dB(A)] [별표 3]</p>\n<!-- /wp:paragraph -->\n'
                '<!-- wp:table {"className":"is-style-stripes"} -->\n<figure class="wp-block-table"><table><thead><tr>'
                '<th scope="col">칸</th></tr></thead><tbody><tr><td data-label="칸">값</td></tr></tbody></table>'
                '<figcaption>표</figcaption></figure>\n<!-- /wp:table -->\n'
                f'<figure><img src="{IMG}" alt="순서" loading="lazy" decoding="async" width="800" height="600"'
                ' style="max-width:100%;height:auto"></figure>\n'
                '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="1,2 3,4" fill="none" stroke="#000"'
                ' stroke-width="2"/></svg>\n<details><summary>더 보기</summary><p>내용</p></details>\n')
        (self.dir / "본문3.html").write_text(body, encoding="utf-8")
        self.record("본문3.html", "flow.png")
        st, _ = self.post(self.client(), {"content": body})
        self.assertEqual(st, 200)

    def test_a_body_ending_mid_tag_is_refused_not_finished_by_the_theme(self):
        self.record("본문.html", "flow.png", "cover.jpg")
        c = self.client()
        other = "https://evil.example/x.png"
        for body in (f'<p>a</p>\n<img src="{other}" alt="x',  # 리뷰 표의 그대로: close()가 버리는 조각
                     '<p>a</p>\n<img src="x',                 # 주소가 다 닿지 않아도 태그 안에서 끝난다
                     '<p>마지막 문장</p>\n<p'):
            self.assertBlocked(c, "확인할 수 없는", {"content": body})

    def test_svg_paint_attributes_cannot_point_outside(self):
        self.record("본문.html", "flow.png", "cover.jpg")
        c = self.client()
        for body in ('<svg><polyline fill="url(https://evil.example/x.png#a)" points="1,2"/></svg>',
                     '<svg><path stroke="u\\72l(https://evil.example/x.png)" d="M0 0"/></svg>',
                     '<svg><circle fill="url( #a )" cx="1" cy="1" r="1"/></svg>'):
            self.assertBlocked(c, "확인할 수 없는", {"content": body})
        st, _ = self.post(c, {"content": self.body})
        self.assertEqual(st, 200)

    def test_redirects_stay_on_our_sites_and_drop_the_nonce(self):
        req = urllib.request.Request(IMG, headers={"X-WP-Nonce": "n123"})
        with self.assertRaisesRegex(ReviewMissing, "리다이렉트는 따라가지 않는다"):
            w._GateRedirect().redirect_request(req, None, 302, "", {}, "https://evil.example/x.png")
        with self.assertRaisesRegex(ReviewMissing, "리다이렉트는 따라가지 않는다"):
            w._GateRedirect().redirect_request(req, None, 302, "", {}, "http://sobaeklaw.co.kr/x.png")
        r = w._GateRedirect().redirect_request(req, None, 302, "", {}, COVER)
        self.assertFalse(r.has_header("X-wp-nonce"))

    def test_attacker_shapes_cannot_smuggle_a_resource(self):
        """리드 요청: 파서가 다르게 읽을 수 있는 모양을 공격자처럼 직접 찔러 본다."""
        self.record("본문.html", "flow.png", "cover.jpg")
        c = self.client()
        other = "https://sobaeklaw.co.kr/wp-content/uploads/2026/11/other.png"
        c.op.files[other] = b"PNG-unread"
        # 엔티티로 숨겼다 브라우저에서 풀어 읽는 바깥 주소 → 호스트 대조에 걸린다
        for body in ('<img src="&#104;ttps://evil.example/x.png">',
                     '<img src="https&#58;//evil.example/x.png">',
                     '<audio src="https://evil.example/x.mp3">'):
            self.assertBlocked(c, "우리 사이트", {"content": body})
        # 우리 사이트 안의 '검수 안 된 그림' 주소 — 받아 보고 나서 바이트 대조에 걸린다
        for body in (f'<IMG SRC="{other}">',
                     f'<video><source src="{other}"/></video>',
                     f'<track src="{other}">',
                     f'<img src="{IMG}" srcset="  {other}  2x">',
                     f'<img srcset="{other} 1x, {IMG} 2x">',
                     f'<picture><source srcset="{other} 2x"></picture>',
                     f'<audio src="{other}"></audio>'):
            self.assertBlocked(c, r"본문 그림 other\.png", {"content": body})
        # 아예 못 쓰는 태그·속성·선언, 풀어진 css url( → 모양 자체가 거부된다
        for body in (f'<p style="background:&u&#114;l({other})">a</p>',
                     f'<p style="@import url({other})">a</p>',
                     f'<use href="{other}">',
                     f'<svg><use href="{other}"/></svg>',
                     '<base href="https://evil.example/">',
                     '<meta http-equiv="refresh" content="0;url=https://evil.example/">',
                     '<SCRIPT>x=1</SCRIPT>', '<STYLE>p{x:1}</STYLE>',
                     '<?xml-stylesheet href="https://evil.example/x.css"?>',
                     '<!DOCTYPE html>',
                     '<a href="javascript&colon;alert(1)">a</a>'):
            self.assertBlocked(c, "확인할 수 없는", {"content": body})
        # title 속성 값에 태그 모양이 들어가도 브라우저는 도구 설명 글자로만 읽는다 — 자원이 아니니 그냥 간다

    def test_links_are_not_images_and_nonce_stays_home(self):
        (self.dir / "본문2.html").write_text(self.body + '<a href="https://www.law.go.kr/">법령</a>', encoding="utf-8")
        self.record("본문2.html", "flow.png", "cover.jpg")
        c = self.client()
        c.nonce = "abcdef0123"
        seen = []
        opener_open = c.op.open
        c.op.open = lambda req, timeout=60: (seen.append((req.full_url, req.get_header("X-wp-nonce"))), opener_open(req))[1]
        st, _ = self.post(c, {"content": (self.dir / "본문2.html").read_text(encoding="utf-8")})
        self.assertEqual(st, 200)
        self.assertIn((IMG, None), seen)
        st, _ = self.post(c, {"featured_media": 843})
        self.assertIn((w.API + "/media/843", "abcdef0123"), seen)

    def test_reads_need_no_review(self):
        c = w.WP()
        c.op = FakeOpener({w.API + "/posts/299?context=edit": b"{}"})
        c._open(urllib.request.Request(w.API + "/posts/299?context=edit"))
        with self.assertRaisesRegex(ReviewMissing, r"WP\(reviewed=...\)"):
            self.post(c, {"content": "x"})
        self.assertEqual(c.op.sent, [])

    def test_record_cli_keeps_texts(self):
        out = self.dir / "r.json"
        subprocess.run([sys.executable, str(Path(review_gate.__file__)), "record", str(out), "--model", "m",
                        "--findings", str(self.dir / "findings.md"), "--text", f"title={self.title}",
                        "--text", "excerpt=a=b", "--post", "299", str(self.dir / "본문.html")], check=True, capture_output=True)
        self.assertEqual(json.loads(out.read_text(encoding="utf-8"))["texts"], {"post": {"title": self.title, "excerpt": "a=b"}})
        self.assertEqual(json.loads(out.read_text(encoding="utf-8")).get("post"), 299)


    def test_block_comment_attributes_are_decoded_before_checking(self):
        """블록 주석 속성은 풀린 JSON으로 검사한다 — \\uXXXX·\\/ 이스케이프로 단어를 숨겨도 소용없다."""
        self.record("본문.html", "flow.png", "cover.jpg")
        c = self.client()
        # 리뷰 표의 그대로: 이스케이프로 숨긴 backgroundIm\\u0061ge.\\u0075rl
        for body in ('<!-- wp:group {"style":{"background":{"backgroundIm\\u0061ge":{"\\u0075rl":"https:\\/\\/evil.example\\/x.png",'
                     '"source":"file"}}}} -->\n<div class="wp-block-group"><p>a</p></div>\n<!-- /wp:group -->',
                     '<!-- wp:group {"style":{"background":{"backgroundImage":{"url":"https:\\/\\/evil.example\\/x.png"}}}} -->',
                     '<!-- wp:group {"style":{"background":"#fff"}} -->',  # 풀어도 background 키 자체를 못 쓰게
                     '<!-- wp:paragraph {"metadata":{"bindings":{"content":{"source":"core/post-meta"}}}} -->',
                     '<!-- wp:paragraph {"metadata":{"n\\u0061me":"x","bindings":{"content":{}}}} -->',
                     '<!-- wp:heading {"level":3,} -->',   # JSON 이 아니다
                     '<!-- wp:heading [1,2] -->',           # 객체가 아니다
                     '<!-- wp:paragraph {"customKey":"1"} -->',  # 허용 목록 밖 키
                     '<!-- wp:block {"ref":123} /-->',      # 재사용 블록 참조 — 무엇이 들어올지 알 수 없다
                     '<!-- wp:pattern /-->'):
            self.assertBlocked(c, "확인할 수 없는", {"content": body})
        # 무해한 속성은 이스케이프로 적혀도 그대로 지나간다
        self.assertEqual(w._body_images('<!-- wp:heading {"l\\u0065vel":3} -->\n<h3>제목</h3>\n<!-- /wp:heading -->', "x"), [])
        self.assertEqual(w._body_images('<!-- wp:paragraph {"metadata":{"name":"머리말"}} -->\n<p>a</p>\n<!-- /wp:paragraph -->', "x"), [])

    def test_a_refused_redirect_still_lands_in_the_log(self):
        self.record("본문.html", "flow.png", "cover.jpg", texts={"title": "읽은 제목"})
        c = self.client()

        class Boom:
            def open(self, req, timeout=None):
                raise w.ReviewMissing("다른 곳으로 가는 리다이렉트는 따라가지 않는다: x")

        c.op = Boom()
        with redirect_stdout(io.StringIO()), self.assertRaisesRegex(ReviewMissing, "리다이렉트"):
            self.post(c, {"title": "읽은 제목"})
        log = json.loads((self.dir / "publish_log.jsonl").read_text(encoding="utf-8").splitlines()[0])
        self.assertIn("리다이렉트", log["status"])

    def test_checking_never_fetches_rest_or_override_urls(self):
        """열 번째 리뷰: 검수 안 된 본문이 가리키는 REST 주소를 검사하면서 받으면(nonce까지 실어) 그 자체가 삭제·쓰기가 된다."""
        self.record("본문.html", "flow.png", "cover.jpg")
        c = self.client()
        c.nonce = "abcdef0123"
        for bad in (w.API + "/posts/299?_method=DELETE",
                    w.BASE + "/?rest_route=/wp/v2/posts/299&_method=DELETE",
                    w.BASE + "/wp-json/wp/v2/posts/299",
                    w.BASE + "/wp-admin/admin-ajax.php?action=x",
                    IMG + "?_method=DELETE", IMG + "?x=1",
                    "https://sobaeklaw.co.kr/wp-content/uploads/../../wp-json/wp/v2/posts/299",
                    "https://sobaeklaw.co.kr/wp-content/uploads/%2e%2e/%2e%2e/wp-json/wp/v2/posts/299"):
            # 받을 수 있는 그림이 앞에 있어도 아무것도 받기 전에 멈춘다
            for body in (f'<img src="{bad}">', f'<img src="{IMG}"><img src="{bad}">', f'<img src="{IMG}" srcset="{bad} 2x">'):
                self.assertBlocked(c, "올린 그림 자리|우리 사이트", {"content": body})
            self.assertBlocked(c, "올린 그림 자리|우리 사이트", {"objectType": "post", "objectID": 299,
                                                         "meta": {"rank_math_facebook_image": bad}},
                               url=w.BASE + "/wp-json/rankmath/v1/updateMeta")
        self.assertEqual(c.op.got, [])
        # 첨부 번호가 알려 준 source_url이 REST 주소여도 받지 않는다 — 읽는 것은 고정 /media/<번호> 하나뿐
        c.op.files[w.API + "/media/950"] = json.dumps({"source_url": w.API + "/posts/299?_method=DELETE"}).encode()
        self.assertBlocked(c, "올린 그림 자리", {"featured_media": 950})
        self.assertBlocked(c, "확인하지 못했다", {"featured_media": "950?_method=DELETE"})
        self.assertEqual(c.op.got, [w.API + "/media/950"])

    def test_reads_with_a_method_override_are_refused(self):
        c = self.client()
        c.nonce = "abcdef0123"
        for path in ("/posts/299?_method=DELETE", "/posts/299?_method=POST&status=trash", "/posts/299?_METHOD=DELETE",
                     "/posts/299?context=edit&_Method=DELETE", "/posts/299?_method%5B%5D=DELETE", "/posts/299?.method=DELETE",
                     "/posts/299?+_method=DELETE", "/posts/299?%20_method=DELETE", "/posts/299?context=edit&%20%20_method=DELETE",
                     "/posts/299?+_method=POST&status=draft&title=x", "/posts/299?%09method=DELETE"):
            with self.assertRaisesRegex(ReviewMissing, "방법 바꾸기"):
                c.get(path)
        for method in ("GET", "HEAD"):
            for name in ("X-HTTP-Method-Override", "x_http_method_override"):
                req = urllib.request.Request(w.API + "/posts/299", method=method, headers={name: "DELETE"})
                with self.assertRaisesRegex(ReviewMissing, "방법 바꾸기"):
                    c._open(req)
        self.assertEqual((c.op.got, c.op.sent), ([], []))
        with self.assertRaisesRegex(ReviewMissing, "방법 바꾸기"):
            c._open(urllib.request.Request(w.BASE + "/?rest_route=/wp/v2/posts/299&%20_method=DELETE"))
        # 관리 화면 GET(휴지통 보내기 따위)과 우리 자리 밖 읽기는 보내지 않는다
        for url in (w.BASE + "/wp-admin/post.php?post=299&action=trash&_wpnonce=abc",
                    w.BASE + "/wp-admin/post.php?post=299&action=edit", w.BASE + "/wp-admin/admin-ajax.php?action=x",
                    w.BASE + "/?rest_route=/wp/v2/posts/299", w.API + "/users/1", w.API + "/posts/299/revisions",
                    w.BASE + "/wp-json/rankmath/v1/getHead?url=x&action=y", "https://evil.example/x.png"):
            with self.assertRaisesRegex(ReviewMissing, "읽기는 REST"):
                c._open(urllib.request.Request(url))
        self.assertEqual((c.op.got, c.op.sent), ([], []))
        # 그냥 읽기는 그대로 된다
        c.op.files[w.API + "/posts/299?context=edit"] = b"{}"
        self.assertEqual(c.get("/posts/299?context=edit"), {})
        # 레인이 실제로 쓰는 읽기 자리는 그대로 열린다
        for url in (w.BASE + "/sbk-entrance", w.BASE + "/wp-admin/admin-ajax.php?action=rest-nonce",
                    w.BASE + "/wp-json/rankmath/v1/getHead?url=https%3A%2F%2Fsobaeklaw.co.kr%2Fx",
                    w.BASE + "/?p=299&preview=true", w.BASE + "/x/?preview_id=299&preview_nonce=ab&preview=true",
                    w.API + "/media/843?context=edit", w.API + "/pages", IMG):
            c.op.files[url] = b"{}"
            self.assertEqual(c._open(urllib.request.Request(url))[0], 200)

    def test_odd_tag_shapes_still_have_their_images_checked(self):
        """열한 번째 리뷰: 파서와 브라우저가 달리 읽는 모양도 그 안 그림은 우리 사이트 확인을 지난다."""
        self.record("본문.html", "flow.png", "cover.jpg")
        c = self.client()
        off = "https://evil.example/wp-content/uploads/x.png"
        for body in (f'<img/src="{off}">', f'<p>글</p ><img src="{off}">',
                     f'<svg><p>글</p><img src="{off}"></svg>'):
            self.assertBlocked(c, "우리 사이트", {"content": body})
            with self.assertRaisesRegex(ReviewMissing, "우리 사이트"):
                for s in w._body_images(body, "x"):
                    w._image_url_ok(s)
        self.assertEqual(c.op.got, [])

    def test_tags_in_text_fields_are_refused(self):
        tag = f'제목<img src="{IMG}">'
        self.record("본문.html", "flow.png", "cover.jpg", texts={"title": tag, "rank_math_description": tag})
        c = self.client()
        self.assertBlocked(c, "title에 태그 글자", {"title": tag})
        self.assertBlocked(c, "rank_math_description에 태그 글자", {"objectType": "post", "objectID": 299,
                                                              "meta": {"rank_math_description": tag}},
                           url=w.BASE + "/wp-json/rankmath/v1/updateMeta")
        self.assertBlocked(c, "caption에 태그 글자", {"caption": "<p>x</p>"}, url=w.API + "/media/843")
        self.assertEqual(c.op.got, [])

    def test_split_headers_and_odd_bodies_are_refused(self):
        """열두 번째 리뷰: urllib은 unredirected 헤더를 headers 위에 덮어 보낸다 — JSON으로 검사하고 form으로 가지 않게."""
        self.record("본문.html", "flow.png", "cover.jpg", texts={"title": self.title})
        c = self.client()
        rm = w.BASE + "/wp-json/rankmath/v1/updateMeta"
        for url, payload in ((w.API + "/posts/299", {"title": self.title}),
                             (rm, {"objectType": "post", "objectID": 299,
                                   "meta": {"rank_math_title": self.title, "rank_math_twitter_use_facebook": "on"}})):
            req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST",
                                         headers={"Content-Type": "application/json"})
            req.add_unredirected_header("Content-type", "application/x-www-form-urlencoded")
            with self.assertRaisesRegex(ReviewMissing, "add_unredirected_header"):
                c._open(req)
        for data in (io.BytesIO(json.dumps({"title": self.title}).encode()), [b"{}"], bytearray(b"{}"), None):
            req = urllib.request.Request(w.API + "/posts/299", data=data, method="POST",
                                         headers={"Content-Type": "application/json"})
            with self.assertRaisesRegex(ReviewMissing, "bytes만"):
                c._open(req)
        self.assertEqual(c.op.sent, [])

    def test_plain_fields_take_only_their_shape(self):
        self.record("본문.html", "flow.png", "cover.jpg", texts={"title": self.title, "rank_math_title": self.title})
        c = self.client()
        for bad in ("299", 0, -1, True, 299.0, {"a": 1}, '<img src="x">'):
            self.assertBlocked(c, "post는 양의 정수", {"alt_text": "", "post": bad}, url=w.API + "/media/843")
        rm = w.BASE + "/wp-json/rankmath/v1/updateMeta"
        for bad in ("&objectType=post&objectID=1&meta[rank_math_title]=x&z=", {"a": 1}, "yes", 1, None):
            self.assertBlocked(c, "'on'·'off'", {"objectType": "post", "objectID": 299,
                                                "meta": {"rank_math_twitter_use_facebook": bad}}, url=rm)
        for good in ("on", "off", True, False):
            with redirect_stdout(io.StringIO()):
                st, _ = self.post(c, {"objectType": "post", "objectID": 299,
                                      "meta": {"rank_math_title": self.title, "rank_math_twitter_use_facebook": good}},
                                  url=rm)
            self.assertEqual(st, 200)

    def test_shortcodes_starting_with_underscore_or_digit_are_refused(self):
        for body in ("<p>[_x id=1]</p>", "<p>[3d model=1]</p>", "<p>[[_x]]</p>", "<p>[/_x]</p>"):
            with self.assertRaisesRegex(ReviewMissing, "단축코드|\\["):
                w._body_images(body, "x")
        w._body_images("<p>소음 85[dB(A)] 이상</p>", "x")

    def test_login_forms_cannot_be_used_to_skip_the_gate(self):
        import inspect
        self.assertNotIn("_login_form", inspect.signature(w.WP._open).parameters)
        self.record("본문.html", "flow.png", "cover.jpg")
        c = self.client()
        with self.assertRaises(TypeError):
            c._open(urllib.request.Request(w.API + "/posts/299", data=b"{}", method="POST"), _login_form=True)
        for url in (w.API + "/posts/299", "https://evil.example/sbk-entrance", w.BASE + "/sbk-entrance?_method=DELETE",
                    w.BASE + "/sbk-entrance?rest_route=/wp/v2/posts/299", "http://wp.sobaeklaw.co.kr/sbk-entrance",
                    w.BASE + "/wp-admin/post.php"):
            with self.assertRaisesRegex(ReviewMissing, "로그인 폼"):
                c._login_post(url, {"content": "x"}, url)
        self.assertEqual(c.op.sent, [])
        c._login_post(w.BASE + "/wp-login.php?action=validate_2fa", {"authcode": "123456"}, w.BASE)
        self.assertEqual(c.op.sent, [("POST", w.BASE + "/wp-login.php?action=validate_2fa")])

    def test_redirects_from_images_stay_on_uploaded_files(self):
        req = urllib.request.Request(IMG)
        for to in (w.API + "/posts/299", w.BASE + "/?rest_route=/wp/v2/posts/299", IMG + "?_method=DELETE",
                   w.BASE + "/wp-admin/admin-ajax.php"):
            with self.assertRaisesRegex(ReviewMissing, "리다이렉트|올린 그림 자리"):
                w._GateRedirect().redirect_request(req, None, 302, "", {}, to)
        media = urllib.request.Request(w.API + "/media/843", headers={"X-WP-Nonce": "n"})
        for to in (w.API + "/posts/299?_method=DELETE", w.BASE + "/?rest_route=/wp/v2/posts/299"):
            with self.assertRaisesRegex(ReviewMissing, "리다이렉트"):
                w._GateRedirect().redirect_request(media, None, 302, "", {}, to)
        self.assertIsNotNone(w._GateRedirect().redirect_request(req, None, 302, "", {}, COVER))


if __name__ == "__main__":
    unittest.main()
