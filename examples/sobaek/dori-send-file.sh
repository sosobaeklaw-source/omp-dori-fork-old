#!/bin/bash
# 사용: [REPLY_TO=원글ID] [DISCORD_CHANNEL=채널ID] dori-send-file.sh [--passed 교열폴더 | --send-without-desk-review] "본문" [파일1 ... 최대 10]
#   → 회장님 방(기본 #소백이-옴프도리)에 첨부와 함께 올리고 `SENT <메시지 ID>`를 찍는다. REPLY_TO면 그 원글의 답글이다.
#   원글이 그 방에 없으면 답글 없이 새 글로 가지 않고 FAIL로 끝난다(fail_if_not_exists).
# 파일을 붙이면 그 파일이 교열 데스크가 통과시킨 바로 그 판이어야 한다. --passed 의 교열 라운드 폴더(review.py --out 폴더)에서
#   verdict.txt 첫 줄이 `나가도 됩니다`이고, 보내는 파일마다 sha256이 그 verdict.txt 의 `경로 sha256` 줄에 있어야 한다. 바이트만
#   비교한다. 통과한 판이라도 같은 상위 폴더의 형제 라운드 가운데 같은 결과물(이 판 해시 줄과 같은 경로, 또는 그 파일의
#   sha256; verdict.txt 수정시각과, 접두사가 같으면 이름 끝 숫자로 가린다)을 본 더 최신 라운드의 판정이 있으면 그 판은 못 보낸다.
#   한 폴더에 여러 계열이 함께 검수되면 다른 결과물의 라운드는 이 파일을 건드리지 않는다. 검수 모델이 읽지 않은 파일(`읽지 않고 함께 나가는 파일`
#   줄에 글 폴더 기준 상대 경로로 오르고 해시도 함께 오른다; 해시로 가린다)도 통과 판이 아니므로 --send-without-desk-review
#   로만 나간다. 하나라도 어긋나면 아무것도 올리지 않고
#   `REFUSED <파일> is not the passed copy: …` 한 줄을 stderr 에 찍고 65 로 끝난다.
#   교열이 보지 않는 파일(회장님이 달라 한 화면 캡처나 로그)만 --send-without-desk-review 로 보내고, 올라가는 글에 그 사실이 적히며
#   DORI_HOME/state/send-without-desk-review.log 에 남는다. 파일 없이 글만 보내는 호출은 이 점검과 상관없다.
# --supports passed|send-without-desk-review: 이 깃발을 아는 판인지 0 으로 돌려준다. tools/ready_reply.ts 가 옛 설치판 감지에 쓴다.
# 설치: dori-send-file.sh 와 passed-check.sh 를 함께 DORI_HOME/bin/ 에 놓는다.
# --passed 발송만 ORDER_ID(없으면 REPLY_TO)와 파일 해시로 중복을 막는다. 미검수 첨부는 재발송할 수 있다.
# 토큰은 DORI_HOME/discord-token(옴프도리 봇). 토큰은 출력하지 않는다.
set -euo pipefail
# --supports 는 토큰·채널과 상관없이 먼저 답한다: 옛 판은 이 깃발을 본문으로 오해하니, 호응 못 하는 호출자는 보내기 전에 멈춘다.
if [ "${1:-}" = "--supports" ]; then
  case "${2:-}" in
    passed) [ -r "$(dirname "$0")/passed-check.sh" ] || { echo "UNSUPPORTED missing passed-check.sh" >&2; exit 64; }; echo "SUPPORTED $2"; exit 0 ;;
    send-without-desk-review|end-of-options) echo "SUPPORTED $2"; exit 0 ;;
    *) echo "UNSUPPORTED ${2:-}" >&2; exit 64 ;;
  esac
fi
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
    --) shift; break ;;
    --[a-zA-Z]*) echo "REFUSED unknown option $1" >&2; exit 64 ;;
    *) break ;;
  esac
done
text="$1"; shift
[ -z "$passed" ] || [ -z "$unreviewed" ] || { echo "REFUSED --passed and --send-without-desk-review exclude each other" >&2; exit 64; }
[ -z "$passed" ] || [ $# -gt 0 ] || { echo "REFUSED --passed requires an attachment" >&2; exit 65; }
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
# Each file is copied once, and the copy is what is checked and what goes up, so the bytes sent are the bytes compared.
i=0; for f in "$@"; do cp -- "$f" "$tmp/f$i" 2>/dev/null || { echo "FAIL cannot read $f"; exit 1; }; i=$((i+1)); done
if [ $# -gt 0 ] && [ -z "$unreviewed" ]; then
  copies=(); for ((i=0; i<$#; i++)); do copies+=("$tmp/f$i"); done
  printf '%s\0' "$@" > "$tmp/labels"
  PASSED_LABELS="$tmp/labels" bash "$(dirname "$0")/passed-check.sh" "${copies[@]}" --passed "$passed"
fi
order="${ORDER_ID:-${REPLY_TO:-}}"
receipt="$home/state/sent-files.log"
hashes=()
if [ $# -gt 0 ] && [ -n "$order" ] && [ -n "$passed" ]; then
  [[ "$order" =~ ^[0-9]+$ ]] || { echo 'REFUSED invalid order id' >&2; exit 64; }
  mkdir -p "$home/state"
  exec 9<> "$home/state/sent-files.lock"
  python3 -c 'import fcntl; fcntl.flock(9,fcntl.LOCK_EX)'
  for ((i=0; i<$#; i++)); do
    hash=$(shasum -a 256 "$tmp/f$i"); hash="${hash%% *}"; hashes+=("$hash")
    if [ -f "$receipt" ] && grep -Fxq "$order $hash" "$receipt"; then
      echo "REFUSED already sent order $order file $hash" >&2; exit 65
    fi
  done
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
if [ -n "$order" ] && [ ${#hashes[@]} -gt 0 ]; then
  for hash in "${hashes[@]}"; do printf '%s %s\n' "$order" "$hash" >> "$receipt"; done
fi
# A post that skipped the desk is logged with the id Discord answered, one line per file; the path is %q-escaped so a
# newline inside a file name cannot forge an extra log line; a log fault never hides SENT.
if [ $# -gt 0 ] && [ -n "$unreviewed" ]; then
  { mkdir -p "$home/state" && for f in "$@"; do printf '%s %s channel=%s reply=%s %q\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(cut -d' ' -f2 "$tmp/out")" "$ch" "${REPLY_TO:--}" "$f"; done >> "$home/state/send-without-desk-review.log"; } || true
fi
