#!/bin/bash
# 옴프도리 → 맥미니 소백이 보고: to-macmini.sh [--order 회장님글ID] "제목 한 줄" < 본문(선택)
# 보고는 파일 한 길로만 간다: 맥미니 ~/sobaegi-lead/inbox/ompdori/<시각>.md. 맥미니 리드가 이 폴더를 감시해 읽는다.
# 2026-11-16 맥미니 od400: 예전에는 같은 보고를 dori-sa send lead 로도 보냈는데, 리드가 늘 바빠 수신함에 쌓이기만 하고
# (리드는 이미 파일로 읽음) 두 길이 겹쳐 '못 받음'처럼 보였다. 그 줄을 뺐다.
# --order: 이 보고가 어느 회장님 글(지시)의 결과인지. 제목 아래 `지시: <ID>` 줄로 싣는다.
# 보낼 때마다 DORI_HOME/state/to-macmini.log 에 `<시각> order=<ID|-> <DELIVERED|NOT_DELIVERED> <파일>` 한 줄(tools/open_orders.ts 가 읽음).
# 설치: DORI_HOME/bin/to-macmini.sh.
set -euo pipefail
order=-
if [ "${1:-}" = "--order" ]; then
  [[ "${2:-}" =~ ^[1-9][0-9]{15,21}$ ]] || { echo "--order must be a Discord message id (16 to 22 digits)" >&2; exit 64; }
  order="$2"; shift 2
fi
TS=$(date +%Y%m%d-%H%M%S); T="$1"; BODY="$(cat 2>/dev/null || true)"
F="sobaegi-lead/inbox/ompdori/$TS.md"
LOG="${DORI_HOME:-$HOME/.omp-dori}/state/to-macmini.log"
head="# $T"; [ "$order" = - ] || head="$head"$'\n\n'"지시: $order"
printf '%s\n\n%s\n' "$head" "$BODY" | ssh -o ConnectTimeout=10 -o ControlMaster=no -o ControlPath=none macmini "mkdir -p ~/sobaegi-lead/inbox/ompdori && cat > ~/$F && wc -c < ~/$F" | {
  read -r bytes || bytes=0
  mkdir -p "$(dirname "$LOG")"
  if [ "${bytes:-0}" -gt 0 ]; then
    printf '%s order=%s DELIVERED ~/%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$order" "$F" >> "$LOG"
    printf 'DELIVERED lead file ~/%s %s bytes\n' "$F" "$bytes"
  else
    printf '%s order=%s NOT_DELIVERED ~/%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$order" "$F" >> "$LOG"
    printf 'NOT_DELIVERED lead file ~/%s (empty or ssh failed)\n' "$F"; exit 2
  fi
}
