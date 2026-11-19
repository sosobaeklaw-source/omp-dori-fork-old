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
            self.assertEqual(redteam.run_pirates(self.out, "p", "client"),
                         [{"branch": "pirates", "status": "skipped", "model": "-", "chars": 0}])
        self.assertEqual(fake.calls, [])
        self.assertTrue((self.out / "pirates_skipped.md").exists())

    def test_timeout_retries_once_one_effort_lower(self):
        def reply(body):
            if body["model"] == "slow" and body["reasoning_effort"] == "high":
                raise TimeoutError("The read operation timed out")
            if body["model"] == "never":
                raise TimeoutError("The read operation timed out")
            return {"model": body["model"], "choices": [{"message": {"content": "지적 없음"}}]}
        listed = {"data": [model("slow", ["low", "high", "medium"]), model("never", ["high", "medium"]),
                           model("only", ["high"])]}
        fake = FakeHttp({"https://oc.hyeon.space/v1/models": listed, "https://opencode.ai/": OSError("paidlock"),
                         "https://oc.hyeon.space/v1/chat/completions": reply})
        with mock.patch.object(redteam, "http_json", fake):
            results = {r["branch"].split("__")[-1]: r for r in redteam.run_pirates(self.out, "p", "public")}
        efforts = [(b["model"], b["reasoning_effort"]) for u, b in fake.calls if u.endswith("/chat/completions")]
        self.assertEqual(sorted(efforts), [("never", "high"), ("never", "medium"), ("only", "high"),
                                           ("slow", "high"), ("slow", "medium")])
        self.assertEqual([(a["effort"], a["status"]) for a in results["slow"]["attempts"]],
                         [("high", "timeout"), ("medium", "ok")])
        self.assertEqual(results["slow"]["status"], "ok")
        self.assertEqual([a["status"] for a in results["never"]["attempts"]], ["timeout", "timeout"])
        self.assertEqual(len(results["only"]["attempts"]), 1)
        self.assertIn("attempts", (self.out / "pirate__tokenmaxx__slow.md").read_text())

    def test_model_file_round_trip(self):
        f = self.out / "pirate__s__m.md"
        redteam.write_model_file(f, {"branch": "pirate", "status": "ok", "model_shown": "m-1", "chars": 4}, "지적 하나")
        self.assertEqual(redteam.read_back(f), {"branch": "pirate__s__m", "status": "ok", "model": "m-1",
                                                "chars": 4, "text": "지적 하나"})
        redteam.write_model_file(f, {"branch": "pirate", "status": "error", "chars": 0}, "boom")
        self.assertEqual(redteam.read_back(f)["text"], "")
        self.assertEqual(redteam.read_back(self.out / "none.md")["status"], "missing")

    def test_merge_counts_only_real_branches(self):
        reply = [{"location": "1장", "problem": "a", "evidence": "e", "models": ["carbon_web", "pirate__s__m", "ghost"]},
                 {"location": "2장", "problem": "b", "evidence": "e", "models": ["carbon_web", "carbon_web"]}]
        fake = FakeHttp({redteam.OCX: {"model": "opus", "choices": [{"message": {"content": "앞말 " + json.dumps(reply)}}]}})
        results = [{"branch": "carbon_web", "text": "x"}, {"branch": "pirate__s__m", "text": "y"}, {"branch": "pirate__s__n", "text": ""}]
        with mock.patch.object(redteam, "http_json", fake):
            self.assertEqual(redteam.merge(self.out, results), 2)
        merged = (self.out / "merged.md").read_text().splitlines()
        self.assertTrue(merged[2].startswith("1. [2개 모델] 위치: 1장"))
        self.assertIn("모르는 이름(세지 않음): ghost", merged[2])
        self.assertTrue(merged[3].startswith("2. [1개 모델] 위치: 2장"))

    def test_merge_with_no_answers_calls_nothing(self):
        fake = FakeHttp({})
        with mock.patch.object(redteam, "http_json", fake):
            self.assertEqual(redteam.merge(self.out, [{"branch": "carbon_web", "text": ""}]), 0)
        self.assertEqual(fake.calls, [])


    def test_gpt_branch_records_not_received_without_waiting(self):
        def boom(*a, **k):
            raise AssertionError("gpt runner must not be called when no account is given")
        with mock.patch.object(redteam.subprocess, "run", boom):
            r = redteam.run_gpt(self.out, self.out / "p.txt", None, "lane", "no account")
        self.assertEqual(r["status"], redteam.NOT_GOT)
        self.assertEqual(r["chars"], 0)
        self.assertIn("돌리지 않았다", (self.out / "gpt6pro_web.md").read_text())

    def test_gpt_branch_records_received_and_not_received(self):
        runner = self.out / "home/sobaegi-lead/results/gpt-web/run.js"
        runner.parent.mkdir(parents=True)
        runner.write_text("// fake runner")
        def fake_run(cmd, capture_output, text):
            meta = Path(cmd[cmd.index("--meta") + 1])
            raw = Path(cmd[cmd.index("--out") + 1])
            if "limit" in cmd[cmd.index("--account") + 1]:
                meta.write_text(json.dumps({"status": "limit", "reason": "사용 한도"}))
            else:
                meta.write_text(json.dumps({"status": "ok", "modelLabel": "GPT-6 Pro", "chatUrl": "https://chatgpt.com/c/x"}))
                raw.write_text("지적: 위치=1장 | 문제=단정 | 근거=추정")
            return mock.Mock(returncode=0, stdout="", stderr="")
        with mock.patch.object(redteam.subprocess, "run", fake_run):
            got = redteam.run_gpt(self.out, self.out / "p.txt", "u0:p", "lane", "-")
            miss = redteam.run_gpt(self.out, self.out / "p.txt", "u0:limit", "lane", "-")
        self.assertEqual(got["status"], redteam.GOT)
        self.assertEqual(got["chars"], len("지적: 위치=1장 | 문제=단정 | 근거=추정"))
        self.assertEqual(miss["status"], redteam.NOT_GOT)
        self.assertEqual(miss["chars"], 0)
        self.assertIn("사용 한도", (self.out / "gpt6pro_web.md").read_text())

    def test_merge_marks_received_and_not_received_branches(self):
        reply = [{"location": "1장", "problem": "a", "evidence": "e", "models": ["carbon_web"]}]
        fake = FakeHttp({redteam.OCX: {"model": "opus", "choices": [{"message": {"content": json.dumps(reply)}}]}})
        results = [{"branch": "carbon_web", "status": redteam.GOT, "text": "x"},
                   {"branch": "gpt6pro_web", "status": redteam.NOT_GOT, "text": ""}]
        with mock.patch.object(redteam, "http_json", fake):
            redteam.merge(self.out, results)
        head = (self.out / "merged.md").read_text().splitlines()[0]
        self.assertIn("받음: carbon_web", head)
        self.assertIn("못 받음: gpt6pro_web", head)

    def test_read_back_keeps_received_answer_into_merge(self):
        redteam.write_model_file(self.out / "carbon_web.md",
                                 {"branch": "carbon_web", "status": redteam.GOT, "model_shown": "Gemini 카본", "chars": 4},
                                 "지적 하나")
        back = redteam.read_back(self.out / "carbon_web.md")
        self.assertEqual(back["text"], "지적 하나")
        self.assertEqual(back["chars"], 4)
        reply = [{"location": "1장", "problem": "a", "evidence": "e", "models": ["carbon_web"]}]
        fake = FakeHttp({redteam.OCX: {"model": "opus", "choices": [{"message": {"content": json.dumps(reply)}}]}})
        with mock.patch.object(redteam, "http_json", fake):
            redteam.merge(self.out, [back, {"branch": "gpt6pro_web", "status": redteam.NOT_GOT, "text": ""}])
        head = (self.out / "merged.md").read_text().splitlines()[0]
        self.assertIn("답 1개", head)
        self.assertIn("받음: carbon_web", head)

    def test_merge_tally_counts_pirate_error_as_missed(self):
        reply = [{"location": "1장", "problem": "a", "evidence": "e", "models": ["pirate__s__m"]}]
        fake = FakeHttp({redteam.OCX: {"model": "opus", "choices": [{"message": {"content": json.dumps(reply)}}]}})
        results = [{"branch": "pirate__s__m", "status": "ok", "text": "지적"},
                   {"branch": "pirate__s__n", "status": "error", "text": ""},
                   {"branch": "pirate__s__t", "status": "timeout", "text": ""},
                   {"branch": "carbon_web", "status": "error", "text": ""}]
        with mock.patch.object(redteam, "http_json", fake):
            redteam.merge(self.out, results)
        head = (self.out / "merged.md").read_text().splitlines()[0]
        self.assertIn("받음: pirate__s__m", head)
        for missed in ("pirate__s__n", "pirate__s__t", "carbon_web"):
            self.assertIn(missed, head.split("못 받음: ")[1])

    def test_gpt_does_not_wait_when_account_lock_is_held(self):
        import os
        def boom(*a, **k):
            raise AssertionError("runner must not be called while the account lock is held")
        owner = redteam.lock_dir("u0") / "owner"
        owner.parent.mkdir(parents=True)
        owner.write_text(f"live-lane pid={os.getpid()}\n")
        with mock.patch.object(redteam.subprocess, "run", boom):
            busy = redteam.run_gpt(self.out, self.out / "p.txt", "u0:p", "lane", "-")
        self.assertEqual(busy["status"], redteam.NOT_GOT)
        self.assertIn("기다리지 않고", (self.out / "gpt6pro_web.md").read_text())
        self.assertTrue(owner.exists())  # a live owner's lock is left untouched

    def test_gpt_releases_lock_and_clears_dead_one(self):
        def boom(*a, **k):
            raise AssertionError("runner must not be called")
        with mock.patch.object(redteam.subprocess, "run", boom):
            missing = redteam.run_gpt(self.out, self.out / "p.txt", "u0:p", "lane", "-")
        self.assertEqual(missing["status"], redteam.NOT_GOT)
        self.assertFalse(redteam.lock_dir("u0").exists())  # released even though the runner is missing
        dead = redteam.lock_dir("u9") / "owner"
        dead.parent.mkdir(parents=True)
        dead.write_text("old-lane pid=999999999\n")
        with mock.patch.object(redteam.subprocess, "run", boom):
            cleared = redteam.run_gpt(self.out, self.out / "p.txt", "u9:p", "lane", "-")
        self.assertIn("runner missing", (self.out / "gpt6pro_web.md").read_text())
        self.assertEqual(cleared["status"], redteam.NOT_GOT)
        self.assertFalse(redteam.lock_dir("u9").exists())

    def test_ownerless_fresh_lock_is_not_stolen(self):
        d = redteam.lock_dir("u0")
        d.mkdir(parents=True)  # no owner file, just created: a live job still writing it
        self.assertFalse(redteam.try_lock("u0", "lane"))
        self.assertTrue(d.exists())


    def test_gpt_runs_the_runner_directly_not_through_the_lock(self):
        seen = {}
        def fake_run(cmd, capture_output, text):
            seen["cmd"] = cmd
            Path(cmd[cmd.index("--meta") + 1]).write_text(json.dumps({"status": "ok", "modelLabel": "GPT-6 Pro"}))
            Path(cmd[cmd.index("--out") + 1]).write_text("지적 하나")
            return mock.Mock(returncode=0, stdout="", stderr="")
        runner = self.out / "home/sobaegi-lead/results/gpt-web/run.js"
        runner.parent.mkdir(parents=True, exist_ok=True)
        runner.write_text("// fake")
        with mock.patch.object(redteam.subprocess, "run", fake_run):
            r = redteam.run_gpt(self.out, self.out / "p.txt", "u0:p", "lane", "-")
        self.assertEqual(r["status"], redteam.GOT)
        self.assertEqual(seen["cmd"][0], "node")
        self.assertNotIn("carbon-lock.sh", " ".join(seen["cmd"]))
        self.assertFalse(redteam.lock_dir("u0").exists())

    def test_unparseable_merge_reply_raises(self):
        fake = FakeHttp({redteam.OCX: {"choices": [{"message": {"content": "no json"}}]}})
        with mock.patch.object(redteam, "http_json", fake), self.assertRaises(ValueError):
            redteam.merge(self.out, [{"branch": "carbon_web", "text": "x"}])


if __name__ == "__main__":
    unittest.main()
