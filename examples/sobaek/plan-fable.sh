#!/usr/bin/env bash
# Planning (lane briefs, priorities, plans) is written by Fable 5.2; the lead (Opus) only reviews.
# Owner 2026-11-14 (discord 1571093421471567943): "뭔가 기획하고 하는건 opus가 하지말고 fable5.2가 해야함."
# Usage: plan-fable.sh <out-file> < request.md   (request = goal, inputs, facts, constraints)
# Installed as DORI_HOME/bin/plan-fable.sh.
#
# A parukuri request (the request says 파쿠리/parukuri, or PARUKURI=1) gets two more things:
#   - the brief opens with 붙일 자리와 지금 숫자: which of our running jobs this attaches to and that job's number now,
#     or, with no number yet, measuring it once as the lane's first step;
#   - one finished lane's whole 결과.md as the shape of the result (PARUKURI_EXAMPLE, default
#     DORI_HOME/results/parksilro-build-1116/결과.md, a copy is examples/sobaek/parukuri-result-example.md).
#     It is a real example, not a rule list.
#
# PUBLIC_REPLY_TO=<owner message id>: the lead sets it only for public-material work that came from an owner Discord
# message (never for case work). The brief then opens with the two lines `public: true` and `원글: <id>`, written here,
# not by the model, so tools/ready_reply.ts answers that message when the lane is READY. Unset, the brief has neither.
#
# Ontology material: when DORI_HOME/onto-host names the ssh host that holds the ontology (the macmini), the request's
#   first words are asked there (scripts.ontology.brief_materials, public study notes only) and what comes back is given
#   to the planner after the request, as material and not as rules. No file, an unreachable host or no hit: the brief is
#   planned without it. PLAN_ONTO=0 turns it off for one run.
set -euo pipefail
out=${1:?usage: plan-fable.sh <out-file> < request.md}
model=${PLAN_MODEL:-anthropic/claude-fable-5-2}
home=${DORI_HOME:-$HOME/.omp-dori}
reply_to=${PUBLIC_REPLY_TO:-}
if [ -n "$reply_to" ] && ! [[ "$reply_to" =~ ^1[0-9]{17,19}$ ]]; then
  echo "plan-fable: PUBLIC_REPLY_TO is not a Discord message id: $reply_to" >&2
  exit 1
fi
req=$(cat)
parukuri=${PARUKURI:-}
if [ -z "$parukuri" ] && printf '%s' "$req" | grep -qiE '파쿠리|parukuri'; then parukuri=1; fi
example=""
if [ "$parukuri" = 1 ]; then
  example_file=${PARUKURI_EXAMPLE:-$home/results/parksilro-build-1116/결과.md}
  example=$(cat "$example_file") || { echo "plan-fable: no result example at $example_file" >&2; exit 1; }
fi
onto=""
onto_host=$(cat "$home/onto-host" 2>/dev/null || true)
if [ -n "$onto_host" ] && [ "${PLAN_ONTO:-1}" != 0 ]; then
  caller="plan:$(basename "$out" .md | tr -cd 'A-Za-z0-9_.-')"
  # Identifier-shaped numbers are cut from the question; the lookup refuses a question that holds one.
  onto=$(printf '%s' "$req" | python3 -c 'import re, sys
t = re.sub(r"\s+", " ", sys.stdin.read())
print(re.sub(r"\d{6}-?\d{7}|\d{2,4}-\d{3,4}-\d{4}", " ", t)[:600])' \
    | ssh -o BatchMode=yes -o ConnectTimeout=8 -o ControlMaster=no -o ControlPath=none "$onto_host" \
      'q=$(cat); f=$(mktemp); cd ~/sanjai-agent && .venv/bin/python3 -m scripts.ontology.brief_materials --question "$q" --caller '"$caller"' -n 6 --out "$f" >/dev/null 2>&1 && cat "$f"; rm -f "$f"' 2>/dev/null) || onto=""
fi
body=$(REQ="$req" MODEL="$model" EXAMPLE="$example" ONTO="$onto" python3 -c '
import json, os
system = ("You write lane briefs for a coding/writing agent harness. Output one Markdown brief in Korean with sections: "
          "목표, 입력, 순서, 산출물, 멈춤 조건, 제약. Concrete paths and observable stop conditions; no checklists or score tables; "
          "keep every constraint given in the request verbatim.")
user = os.environ["REQ"]
if os.environ["EXAMPLE"]:
    system += (" This is a parukuri request: take something someone else made apart, attach it to one of our running jobs, "
               "run it there and keep what got better as our default. The brief opens, before 목표, with a section "
               "\"붙일 자리와 지금 숫자\": which of our running jobs this attaches to (its path or command) and that job\x27s number "
               "today, with where the number comes from. When the request gives no number, say so, and make measuring it once "
               "the first step of 순서, before anything is taken apart. If nothing of ours fits, the brief says the lane may close "
               "with a written reason instead. 산출물 is one 결과.md shaped like the example below: its first paragraph says "
               "what changed for the owner, because it is posted as the reply to the owner\x27s message.")
    user += ("\n\n---\n결과 모양 예시: 끝난 레인 하나의 결과.md 전문이다. 규칙 목록이 아니라 잘 된 실물 하나다.\n\n"
             + os.environ["EXAMPLE"])
if os.environ["ONTO"].strip():
    # Each fact keeps the first 1,200 characters of its quote; the whole quote is at the source path it names.
    kept, used = [], 0
    for line in os.environ["ONTO"].split("\n"):
        if line.startswith("## "):
            used = 0
        if line.startswith("> "):
            if used > 1200:
                continue
            used += len(line)
            if used > 1200:
                line = line[:max(40, len(line) - (used - 1200))] + " …"
        kept.append(line)
    user += ("\n\n---\n온톨로지에서 꺼낸 공개 자료: 이 요청과 낱말이 겹치는, 우리가 공부해 둔 독후감·사실표 발췌다. 규칙 목록이 아니라 재료다. "
             "이 일에 맞는 대목만 브리프의 입력에 출처 경로와 함께 옮기고, 맞지 않는 것은 옮기지 않는다.\n\n" + "\n".join(kept))
print(json.dumps({"model": os.environ["MODEL"], "max_tokens": 32000, "reasoning_effort": os.environ.get("PLAN_EFFORT", "xhigh"),
                  "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}))')
if [ -n "${PLAN_DRY_RUN:-}" ]; then printf '%s\n' "$body" > "$out"; echo "$out"; exit 0; fi
resp=$(curl -sS -m 600 -H 'authorization: Bearer opencodex-loopback' -H 'content-type: application/json' \
  http://127.0.0.1:10100/v1/chat/completions -d "$body")
RESP="$resp" REPLY_TO="$reply_to" python3 -c '
import json, os, re, sys
d = json.loads(os.environ["RESP"])
if "choices" not in d:
    sys.exit("plan-fable: no completion: " + json.dumps(d)[:400])
c = d["choices"][0]
text = (c.get("message") or {}).get("content")
if not text or not text.strip():
    sys.exit("plan-fable: empty plan (finish_reason=%s)" % c.get("finish_reason"))
# Only the lead sets the marker: any public:/원글: line the model wrote is dropped, then PUBLIC_REPLY_TO (if given)
# is written once on top.
text = "\n".join(l for l in text.split("\n") if not re.match(r"\s*(public|원글)\s*:", l, re.I))
if os.environ["REPLY_TO"]:
    text = "public: true\n원글: %s\n\n%s" % (os.environ["REPLY_TO"], text)
print(text)' > "$out"
printf '\n<!-- planner: %s · reviewed by lead (Opus) before start -->\n' "$model" >> "$out"
echo "$out"
