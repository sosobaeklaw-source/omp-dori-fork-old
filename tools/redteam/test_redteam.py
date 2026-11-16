"""Safety lines of redteam.py, with every network call faked: python3 -m unittest discover tools/redteam"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import redteam


def model(mid, efforts=None, owned_by="x"):
    return {"id": mid, "owned_by": owned_by, "capabilities": {"reasoning": {"effort": efforts}} if efforts else {}}


class FakeHttp:
    def __init__(self, routes):
        self.routes, self.calls = routes, []

    def __call__(self, url, headers, body=None, timeout=60):
        self.calls.append((url, body))
        for prefix, reply in self.routes.items():
            if url.startswith(prefix):
                if isinstance(reply, Exception):
                    raise reply
                return reply(body) if callable(reply) else reply
        raise AssertionError("unexpected call " + url)


class RedteamTest(unittest.TestCase):
    def setUp(self):
        self.out = Path(tempfile.mkdtemp())
        key = self.out / "home/.omp/agent/tokenmaxx.key"
        key.parent.mkdir(parents=True)
        key.write_text("k\n")
        self.home = mock.patch.object(redteam, "HOME", self.out / "home")
        self.home.start()
        self.addCleanup(self.home.stop)

    def test_google_models_are_skipped_and_order_is_high_effort_first(self):
        listed = {"data": [model("low-one", ["low"]), model("gemini-3-pro", ["max"]), model("plain"),
                           model("vendor/x", ["high"], owned_by="google"), model("top", ["max", "low"])]}
        fake = FakeHttp({"https://oc.hyeon.space/v1/models": listed,
                         "https://opencode.ai/": OSError("paidlock"),
                         "https://oc.hyeon.space/v1/chat/completions": {"choices": [{"message": {"content": "지적 없음"}}]}})
        with mock.patch.object(redteam, "http_json", fake):
            results = redteam.run_pirates(self.out, "p", "public")
        called = [b["model"] for u, b in fake.calls if u.endswith("/chat/completions")]
        self.assertEqual(sorted(called), ["low-one", "plain", "top"])
        self.assertEqual([r["branch"] for r in results],
                         ["pirate__tokenmaxx__top", "pirate__tokenmaxx__low-one", "pirate__tokenmaxx__plain"])
        order = (self.out / "pirates_order.md").read_text()
        self.assertIn("- tokenmaxx/gemini-3-pro", order.split("Google")[1])
        self.assertIn("opencode-go: 목록을 읽지 못함", order)

    def test_client_material_makes_no_http_call(self):
        fake = FakeHttp({})
        with mock.patch.object(redteam, "http_json", fake):
            self.assertEqual(redteam.run_pirates(self.out, "p", "client"), [])
        self.assertEqual(fake.calls, [])
        self.assertTrue((self.out / "pirates_skipped.md").exists())

    def test_model_file_round_trip(self):
        f = self.out / "pirate__s__m.md"
        redteam.write_model_file(f, {"branch": "pirate", "status": "ok", "model_shown": "m-1", "chars": 4}, "지적 하나")
        self.assertEqual(redteam.read_back(f), {"branch": "pirate__s__m", "status": "ok", "model": "m-1",
                                                "chars": 4, "text": "지적 하나"})
        redteam.write_model_file(f, {"branch": "pirate", "status": "error", "chars": 0}, "boom")
        self.assertEqual(redteam.read_back(f)["text"], "")
        self.assertEqual(redteam.read_back(self.out / "none.md")["status"], "missing")

    def test_merge_counts_only_real_branches(self):
        reply = [{"location": "1장", "problem": "a", "evidence": "e", "models": ["gpt_web", "pirate__s__m", "ghost"]},
                 {"location": "2장", "problem": "b", "evidence": "e", "models": ["gpt_web", "gpt_web"]}]
        fake = FakeHttp({redteam.OCX: {"model": "opus", "choices": [{"message": {"content": "앞말 " + json.dumps(reply)}}]}})
        results = [{"branch": "gpt_web", "text": "x"}, {"branch": "pirate__s__m", "text": "y"}, {"branch": "carbon_web", "text": ""}]
        with mock.patch.object(redteam, "http_json", fake):
            self.assertEqual(redteam.merge(self.out, results), 2)
        merged = (self.out / "merged.md").read_text().splitlines()
        self.assertTrue(merged[2].startswith("1. [2개 모델] 위치: 1장"))
        self.assertIn("모르는 이름(세지 않음): ghost", merged[2])
        self.assertTrue(merged[3].startswith("2. [1개 모델] 위치: 2장"))

    def test_merge_with_no_answers_calls_nothing(self):
        fake = FakeHttp({})
        with mock.patch.object(redteam, "http_json", fake):
            self.assertEqual(redteam.merge(self.out, [{"branch": "gpt_web", "text": ""}]), 0)
        self.assertEqual(fake.calls, [])

    def test_unparseable_merge_reply_raises(self):
        fake = FakeHttp({redteam.OCX: {"choices": [{"message": {"content": "no json"}}]}})
        with mock.patch.object(redteam, "http_json", fake), self.assertRaises(ValueError):
            redteam.merge(self.out, [{"branch": "gpt_web", "text": "x"}])


if __name__ == "__main__":
    unittest.main()
