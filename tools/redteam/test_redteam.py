"""Safety lines of redteam.py, with every network call faked: python3 -m unittest discover tools/redteam"""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import redteam

ANSWER = "지적: 위치=1장 | 문제=단정 | 근거=추정"


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


class FakeRunner:
    """Stands in for `node run.js`, recording the lock owner line it runs under."""

    def __init__(self, test, meta, answer=ANSWER, pid=4242):
        self.test, self.meta, self.answer, self.pid = test, meta, answer, pid
        self.cmd, self.owner_while_running = None, None

    def __call__(self, cmd, **kw):
        self.cmd = cmd
        proceed = mock.Mock(pid=self.pid, returncode=0, stdout="", stderr="")
        meta_path, out_path = Path(cmd[cmd.index("--meta") + 1]), Path(cmd[cmd.index("--out") + 1])

        def communicate():
            owner = redteam.lock_dir(self.test.acct) / "owner"
            self.owner_while_running = owner.read_text().strip() if owner.exists() else None
            if self.meta is not None:
                meta_path.write_text(json.dumps(self.meta) if not isinstance(self.meta, str) else self.meta)
            if self.answer is not None:
                out_path.write_text(self.answer)
            return "", ""

        proceed.communicate = communicate
        return proceed


class RedteamTest(unittest.TestCase):
    acct = "u0"

    def setUp(self):
        self.out = Path(tempfile.mkdtemp())
        key = self.out / "home/.omp/agent/tokenmaxx.key"
        key.parent.mkdir(parents=True)
        key.write_text("k\n")
        self.home = mock.patch.object(redteam, "HOME", self.out / "home")
        self.home.start()
        self.addCleanup(self.home.stop)
        self.runner = self.out / "home/sobaegi-lead/results/gpt-web/run.js"

    def use_runner(self, meta, answer=ANSWER, pid=4242):
        self.runner.parent.mkdir(parents=True, exist_ok=True)
        self.runner.write_text("// fake runner")
        fake = FakeRunner(self, meta, answer, pid)
        patcher = mock.patch.object(redteam.subprocess, "Popen", fake)
        patcher.start()
        self.addCleanup(patcher.stop)
        return fake

    def gpt(self, acct="u0:p"):
        self.acct = acct.split(":")[0]
        return redteam.run_gpt(self.out, self.out / "p.txt", acct, "lane", "-")

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

    def test_unparseable_merge_reply_raises(self):
        fake = FakeHttp({redteam.OCX: {"choices": [{"message": {"content": "no json"}}]}})
        with mock.patch.object(redteam, "http_json", fake), self.assertRaises(ValueError):
            redteam.merge(self.out, [{"branch": "carbon_web", "text": "x"}])

    def test_gpt_branch_records_not_received_without_waiting(self):
        def boom(*a, **k):
            raise AssertionError("the runner must not be called when no account is given")
        with mock.patch.object(redteam.subprocess, "Popen", boom):
            r = redteam.run_gpt(self.out, self.out / "p.txt", None, "lane", "no account")
        self.assertEqual(r["status"], redteam.NOT_GOT)
        self.assertEqual(r["chars"], 0)
        self.assertIn("돌리지 않았다", (self.out / "gpt6pro_web.md").read_text())

    def test_gpt_accepts_an_answer_only_from_gpt_6_pro(self):
        self.use_runner({"status": "ok", "model_shown": "GPT-6 Pro", "finished_at": "2026-11-19T05:00:00Z",
                         "chat_url": "https://chatgpt.com/c/x"})
        got = self.gpt()
        self.assertEqual(got["status"], redteam.GOT)
        self.assertEqual(got["chars"], len(ANSWER))
        head = (self.out / "gpt6pro_web.md").read_text()
        self.assertIn("model_shown: GPT-6 Pro", head)
        self.assertIn("finished_at: 2026-11-19T05:00:00Z", head)

    def test_gpt_model_shown_is_matched_without_case(self):
        self.use_runner({"status": "ok", "model_shown": "gpt-6 pro"})
        self.assertEqual(self.gpt()["status"], redteam.GOT)

    def test_gpt_rejects_near_miss_model_labels(self):
        fake = self.use_runner({"status": "ok", "model_shown": "GPT-6 Pro"})
        for label in ("GPT-5.6 Pro", "GPT-16 Pro", "GPT-6 Pro mini", "GPT-6.1 Pro"):
            with self.subTest(label=label):
                fake.meta = {"status": "ok", "model_shown": label}
                result = self.gpt()
                self.assertEqual(result["status"], redteam.NOT_GOT)
                self.assertEqual(result["chars"], 0)

    def test_gpt_rejects_legacy_model_key_without_contract_field(self):
        self.use_runner({"status": "ok", "modelShown": "GPT-6 Pro"})
        self.assertEqual(self.gpt()["status"], redteam.NOT_GOT)

    def test_claim_does_not_overwrite_live_holder(self):
        claim = self.out / "claim"
        claim.write_text(f"pid={os.getpid()}")
        self.assertFalse(redteam.take_claim(claim))
        self.assertEqual(claim.read_text(), f"pid={os.getpid()}")

    def test_gpt_answer_from_a_lower_model_is_not_received(self):
        self.use_runner({"status": "ok", "model_shown": "GPT-6"})
        r = self.gpt()
        self.assertEqual(r["status"], redteam.NOT_GOT)
        self.assertEqual(r["chars"], 0)
        self.assertIn("GPT 6 Pro가 아니다", (self.out / "gpt6pro_web.md").read_text())

    def test_gpt_limit_notice_with_an_answer_is_not_received(self):
        self.use_runner({"status": "limit", "model_shown": "GPT-6 Pro", "reason": "사용 한도에 도달했습니다"})
        r = self.gpt()
        self.assertEqual(r["status"], redteam.NOT_GOT)
        self.assertIn("사용 한도", (self.out / "gpt6pro_web.md").read_text())

    def test_gpt_empty_answer_is_not_received(self):
        self.use_runner({"status": "ok", "model_shown": "GPT-6 Pro"}, answer="")
        r = self.gpt()
        self.assertEqual(r["status"], redteam.NOT_GOT)
        self.assertIn("답이 비었다", (self.out / "gpt6pro_web.md").read_text())

    def test_gpt_missing_meta_is_not_received(self):
        self.use_runner(None, answer=None)
        r = self.gpt()
        self.assertEqual(r["status"], redteam.NOT_GOT)
        self.assertIn("meta.json 없음", (self.out / "gpt6pro_web.md").read_text())

    def test_gpt_runs_the_runner_directly_not_through_the_lock(self):
        fake = self.use_runner({"status": "ok", "model_shown": "GPT-6 Pro"})
        self.assertEqual(self.gpt()["status"], redteam.GOT)
        self.assertEqual(fake.cmd[0], "node")
        self.assertNotIn("carbon-lock.sh", " ".join(fake.cmd))
        self.assertFalse(redteam.lock_dir("u0").exists())

    def test_gpt_lock_names_the_runner_process(self):
        fake = self.use_runner({"status": "ok", "model_shown": "GPT-6 Pro"}, pid=4242)
        self.gpt()
        self.assertIn("pid=", fake.owner_while_running)
        self.assertIn("cmd=4242", fake.owner_while_running)

    def test_gpt_does_not_wait_when_account_lock_is_held(self):
        self.acct = "u0"
        owner = redteam.lock_dir("u0") / "owner"
        owner.parent.mkdir(parents=True)
        owner.write_text(f"live-lane {redteam.stamp()} pid={os.getpid()}\n")
        def boom(*a, **k):
            raise AssertionError("the runner must not be called while the account lock is held")
        with mock.patch.object(redteam.subprocess, "Popen", boom):
            busy = redteam.run_gpt(self.out, self.out / "p.txt", "u0:p", "lane", "-")
        self.assertEqual(busy["status"], redteam.NOT_GOT)
        self.assertIn("기다리지 않고", (self.out / "gpt6pro_web.md").read_text())
        self.assertTrue(owner.exists())

    def test_gpt_releases_lock_and_clears_dead_one(self):
        self.use_runner(None, answer="")
        self.runner.unlink()
        missing = self.gpt()
        self.assertEqual(missing["status"], redteam.NOT_GOT)
        self.assertIn("runner missing", (self.out / "gpt6pro_web.md").read_text())
        self.assertFalse(redteam.lock_dir("u0").exists())
        dead = redteam.lock_dir("u9") / "owner"
        dead.parent.mkdir(parents=True)
        dead.write_text(f"old-lane {redteam.stamp()} pid=999999999\n")
        self.assertEqual(self.gpt("u9:p")["status"], redteam.NOT_GOT)
        self.assertFalse(redteam.lock_dir("u9").exists())

    def test_ownerless_fresh_lock_is_not_stolen(self):
        d = redteam.lock_dir("u0")
        d.mkdir(parents=True)
        self.assertIsNone(redteam.try_lock("u0", "lane"))
        self.assertTrue(d.exists())

    def test_stale_lock_is_left_alone_once_its_owner_line_changed(self):
        d = redteam.lock_dir("u0")
        d.mkdir(parents=True)
        seen = f"dead {redteam.stamp()} pid=999999999"
        (d / "owner").write_text(f"taker {redteam.stamp()} pid={os.getpid()}\n")
        self.assertFalse(redteam.clear_stale(d, seen))
        self.assertTrue(d.exists())

    def test_same_account_for_both_branches_is_refused(self):
        self.assertIn("different Aside accounts", redteam.same_account_error("u0:a", "u0:b"))
        self.assertIsNone(redteam.same_account_error("u0:a", "u1:b"))
        self.assertIsNone(redteam.same_account_error(None, "u1:b"))
        argv = ["redteam.py", "--target", "t", "--kind", "card", "--material", "public", "--out", str(self.out),
                "--carbon-account", "u0:a", "--gpt-account", "u0:b"]
        with mock.patch.object(redteam.sys, "argv", argv), self.assertRaises(SystemExit):
            redteam.main()

    def test_runner_contract_is_written_down(self):
        readme = (Path(redteam.__file__).parent / "README.md").read_text()
        for field in ("status", "model_shown", "finished_at", "answer_path"):
            self.assertIn(f"`{field}`", readme)
        self.assertIn("gpt-web/run.js", readme)
        gpt = redteam.__doc__.split("(c) gpt6pro_web.md")[1].split("No GPT API branch")[0]
        self.assertIn("directly", gpt)
        self.assertNotIn("under carbon-lock", gpt)

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


if __name__ == "__main__":
    unittest.main()
