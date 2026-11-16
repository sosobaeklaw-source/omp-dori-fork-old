#!/bin/bash
# 사용: [REPLY_TO=원글ID] [DISCORD_CHANNEL=채널ID] dori-send-file.sh "본문" [파일1 ... 최대 10]
#   → 회장님 방(기본 #소백이-옴프도리)에 첨부와 함께 올리고 `SENT <메시지 ID>`를 찍는다. REPLY_TO면 그 원글의 답글이다.
#   원글이 그 방에 없으면 답글 없이 새 글로 가지 않고 FAIL로 끝난다(fail_if_not_exists).
# 설치: DORI_HOME/bin/dori-send-file.sh. tools/ready_reply.ts(READY 답글)가 이걸 부른다.
# 토큰은 DORI_HOME/discord-token(옴프도리 봇). 토큰은 출력하지 않는다.
set -euo pipefail
home="${DORI_HOME:-$HOME/.omp-dori}"
token_file="$home/discord-token"
[ -r "$token_file" ] || { echo "FAIL no-token $token_file"; exit 1; }
ch="${DISCORD_CHANNEL:-1571013138764140544}"
api="${DISCORD_API:-https://discord.com/api/v10}"
text="$1"; shift
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
# payload_json goes in from a file: with -F "payload_json=<text>" curl reads any ; in the text as a field parameter
# separator and cuts the message there. allowed_mentions:[] keeps @everyone or <@id> in a result from pinging.
python3 -c 'import json,sys;d={"content":sys.argv[1],"allowed_mentions":{"parse":[]}};r=sys.argv[2]
if r: d["message_reference"]={"message_id":r,"fail_if_not_exists":True}
open(sys.argv[3],"w").write(json.dumps(d))' "$text" "${REPLY_TO:-}" "$tmp/payload.json"
args=(-F "payload_json=<$tmp/payload.json;type=application/json")
# A " or ; in a path would break curl's quoted form, so each file goes in through a plain-named link.
i=0; for f in "$@"; do ln -s "$(cd "$(dirname "$f")" && pwd)/$(basename "$f")" "$tmp/f$i"; args+=(-F "files[$i]=@$tmp/f$i;filename=file$i.${f##*.}"); i=$((i+1)); done
# The token goes in through a header file, not argv, so it never shows in ps.
printf 'Authorization: Bot %s\n' "$(cat "$token_file")" > "$tmp/auth"; chmod 600 "$tmp/auth"
r=$(curl -s -m 120 -X POST "$api/channels/$ch/messages" -H @"$tmp/auth" "${args[@]}")
printf '%s' "$r" | python3 -c "import json,sys
raw=sys.stdin.read()
try: d=json.loads(raw)
except ValueError: print('FAIL non-json',raw[:80].replace(chr(10),' ')); sys.exit(1)
print('SENT',d['id']) if isinstance(d,dict) and 'id' in d else (print('FAIL',d.get('code') if isinstance(d,dict) else '-',d.get('message') if isinstance(d,dict) else raw[:80]),sys.exit(1))"
