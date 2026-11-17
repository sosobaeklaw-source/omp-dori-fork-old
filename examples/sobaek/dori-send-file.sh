#!/bin/bash
# 사용: [REPLY_TO=원글ID] [DISCORD_CHANNEL=채널ID] dori-send-file.sh [--passed 교열폴더 | --send-without-desk-review] "본문" [파일1 ... 최대 10]
#   → 회장님 방(기본 #소백이-옴프도리)에 첨부와 함께 올리고 `SENT <메시지 ID>`를 찍는다. REPLY_TO면 그 원글의 답글이다.
#   원글이 그 방에 없으면 답글 없이 새 글로 가지 않고 FAIL로 끝난다(fail_if_not_exists).
# 파일을 붙이면 그 파일이 교열 데스크가 통과시킨 바로 그 판이어야 한다. --passed 의 교열 라운드 폴더(review.py --out 폴더)에서
#   verdict.txt 첫 줄이 `나가도 됩니다`이고, 보내는 파일마다 sha256이 그 verdict.txt 의 `경로 sha256` 줄에 있어야 한다. 바이트만
#   비교한다. 하나라도 어긋나면 아무것도 올리지 않고 `REFUSED <파일> is not the passed copy: …` 한 줄을 stderr 에 찍고 65 로 끝난다.
#   교열이 보지 않는 파일(회장님이 달라 한 화면 캡처나 로그)만 --send-without-desk-review 로 보내고, 올라가는 글에 그 사실이 적히며
#   DORI_HOME/state/send-without-desk-review.log 에 남는다. 파일 없이 글만 보내는 호출은 이 점검과 상관없다.
# 설치: DORI_HOME/bin/dori-send-file.sh. tools/ready_reply.ts(READY 답글)가 이걸 부른다.
# 토큰은 DORI_HOME/discord-token(옴프도리 봇). 토큰은 출력하지 않는다.
set -euo pipefail
home="${DORI_HOME:-$HOME/.omp-dori}"
token_file="$home/discord-token"
[ -r "$token_file" ] || { echo "FAIL no-token $token_file"; exit 1; }
ch="${DISCORD_CHANNEL:-1571013138764140544}"
api="${DISCORD_API:-https://discord.com/api/v10}"
passed=""; unreviewed=""
while :; do
  case "${1:-}" in
    --passed) [ -n "${2:-}" ] && [ -z "$passed" ] || { echo "REFUSED --passed needs one review round folder" >&2; exit 64; }; passed="$2"; shift 2 ;;
    --send-without-desk-review) unreviewed=1; shift ;;
    *) break ;;
  esac
done
text="$1"; shift
[ -z "$passed" ] || [ -z "$unreviewed" ] || { echo "REFUSED --passed and --send-without-desk-review exclude each other" >&2; exit 64; }
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
# Each file is copied once, and the copy is what is checked and what goes up, so the bytes sent are the bytes compared.
i=0; for f in "$@"; do cp -- "$f" "$tmp/f$i" 2>/dev/null || { echo "FAIL cannot read $f"; exit 1; }; i=$((i+1)); done
if [ $# -gt 0 ] && [ -z "$unreviewed" ]; then
  python3 -X utf8 -c 'import hashlib,os,sys
folder,tmp,names=sys.argv[1],sys.argv[2],sys.argv[3:]
def refuse(name,why): print("REFUSED %s is not the passed copy: %s" % (name,why),file=sys.stderr); sys.exit(65)
if not folder: refuse(names[0],"no --passed review round folder was named")
verdict=os.path.join(folder,"verdict.txt")
try: lines=open(verdict,encoding="utf-8").read().splitlines()
except OSError: refuse(names[0],"%s cannot be read" % verdict)
if not lines or lines[0].strip()!="나가도 됩니다": refuse(names[0],"%s does not say 나가도 됩니다 on its first line" % verdict)
listed={l.split()[-1] for l in lines[1:] if l.split()}
for i,name in enumerate(names):
    if hashlib.sha256(open(os.path.join(tmp,"f%d" % i),"rb").read()).hexdigest() not in listed: refuse(name,"its sha256 is not listed in %s" % verdict)' "$passed" "$tmp" "$@"
fi
[ $# -eq 0 ] || [ -z "$unreviewed" ] || text="$text"$'\n\n'"(첨부한 파일은 교열 데스크를 거치지 않았습니다)"
# payload_json goes in from a file: with -F "payload_json=<text>" curl reads any ; in the text as a field parameter
# separator and cuts the message there. allowed_mentions:[] keeps @everyone or <@id> in a result from pinging.
python3 -c 'import json,sys;d={"content":sys.argv[1],"allowed_mentions":{"parse":[]}};r=sys.argv[2]
if r: d["message_reference"]={"message_id":r,"fail_if_not_exists":True}
open(sys.argv[3],"w").write(json.dumps(d))' "$text" "${REPLY_TO:-}" "$tmp/payload.json"
args=(-F "payload_json=<$tmp/payload.json;type=application/json")
# A " or ; in a path would break curl's quoted form, so each file goes in through its plain-named copy.
i=0; for f in "$@"; do args+=(-F "files[$i]=@$tmp/f$i;filename=file$i.${f##*.}"); i=$((i+1)); done
# The token goes in through a header file, not argv, so it never shows in ps.
printf 'Authorization: Bot %s\n' "$(cat "$token_file")" > "$tmp/auth"; chmod 600 "$tmp/auth"
r=$(curl -s -m 120 -X POST "$api/channels/$ch/messages" -H @"$tmp/auth" "${args[@]}")
printf '%s' "$r" | python3 -c "import json,sys
raw=sys.stdin.read()
try: d=json.loads(raw)
except ValueError: print('FAIL non-json',raw[:80].replace(chr(10),' ')); sys.exit(1)
print('SENT',d['id']) if isinstance(d,dict) and 'id' in d else (print('FAIL',d.get('code') if isinstance(d,dict) else '-',d.get('message') if isinstance(d,dict) else raw[:80]),sys.exit(1))" | tee "$tmp/out"
# A post that skipped the desk is logged with the id Discord answered, one line per file; a log fault never hides SENT.
if [ $# -gt 0 ] && [ -n "$unreviewed" ]; then
  { mkdir -p "$home/state" && for f in "$@"; do printf '%s %s channel=%s reply=%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(cut -d' ' -f2 "$tmp/out")" "$ch" "${REPLY_TO:--}" "$f"; done >> "$home/state/send-without-desk-review.log"; } || true
fi
