#!/bin/bash
# 사용: [REPLY_TO=원글ID] [DISCORD_CHANNEL=채널ID] dori-send-file.sh "본문" [파일1 ... 최대 10]
#   → 회장님 방(기본 #소백이-옴프도리)에 첨부와 함께 올리고 `SENT <메시지 ID>`를 찍는다. REPLY_TO면 그 원글의 답글이다.
#   원글이 그 방에 없으면 답글 없이 새 글로 가지 않고 FAIL로 끝난다(fail_if_not_exists).
# 설치: DORI_HOME/bin/dori-send-file.sh. tools/ready_reply.ts(READY 답글)가 이걸 부른다.
# 토큰은 DORI_HOME/discord-token(옴프도리 봇). 토큰은 출력하지 않는다.
set -euo pipefail
home="${DORI_HOME:-$HOME/.omp-dori}"
DORI_DISCORD_TOKEN="$(cat "$home/discord-token")"
ch="${DISCORD_CHANNEL:-1571013138764140544}"
text="$1"; shift
args=(-F "payload_json=$(python3 -c 'import json,sys;d={"content":sys.argv[1]};r=sys.argv[2]
if r: d["message_reference"]={"message_id":r,"fail_if_not_exists":True}
print(json.dumps(d))' "$text" "${REPLY_TO:-}")")
i=0; for f in "$@"; do args+=(-F "files[$i]=@\"$f\""); i=$((i+1)); done
r=$(curl -s -m 120 -X POST "https://discord.com/api/v10/channels/$ch/messages" -H "Authorization: Bot $DORI_DISCORD_TOKEN" "${args[@]}")
printf '%s' "$r" | python3 -c "import json,sys;d=json.load(sys.stdin);print('SENT',d['id']) if 'id' in d else (print('FAIL',d.get('code'),d.get('message')),sys.exit(1))"
