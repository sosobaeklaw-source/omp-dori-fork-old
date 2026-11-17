#!/bin/bash
# Every 2 min (launchd com.sobaek.ompdori-owner-sync, Nice 10 / Background / LowPriorityIO). sync-all-1116, macmini od395.
# 1) macmini canonical owner-now.md → ~/.omp-dori/owner-now.md (read-only 444). Only the macmini lead writes the canonical one.
# 2) ~/.omp-dori/반복지적.md (the MacBook writes it) → macmini ~/.omp-dori/반복지적.md. Skipped while the file does not exist.
# 3) New owner Discord messages → appended as original words to macmini inbox/ompdori/owner-direct.md (owner-direct-forward.py).
# 4) macmini ~/sobaegi-lead/results/ 독후감·단어장(어휘표) md/txt → same path on the MacBook, files read-only (444), no delete.
#    -p re-applies 444 to files that already existed. -u keeps a MacBook file that is newer than the macmini one (a MacBook edit that never went back);
#    --info=skip1 reports each such skipped file ("… is newer"); the sorted list goes to $H/state/owner-sync.newer and the log gets one count line
#    only when that list changes. Backups, evidence/ and json are left out.
#    The writer case lists (~/.omp-dori/writer-cases/*.txt) point at these paths, so a passage opens the same sentence on both Macs. rootfix-pr4-1116.
# 5) 독후감·독서메모 written on the MacBook → the macmini's ~/sobaegi-lead/results/, new files only (--ignore-existing: a file the
#    macmini already has is never overwritten). Two sources: the MacBook's own ~/sobaegi-lead/results/ and each omp lane's
#    DORI_HOME/results/<lane>/독후감*.md (top level of the lane folder only; copies kept deeper as references stay). The ontology
#    refresh (macmini 04:30) reads only the macmini's results folder, so a note written here reached it only after going up. sync-up-1117.
# 6) Records between the Macs, one way each, record files only (no case folder, no lane report text). macmini → MacBook,
#    from ~/sobaegi-lead/state/ to $H/state/macmini/: open-orders.json, reply.log, lead-alive.json (a file the macmini does not have yet is skipped).
# 7) `dori lead-pulse` (src/lead-pulse.ts): is the lead's pane there, start it after two dead checks in a row, tell the room once
#    when the macmini's lead-alive.json above has not been renewed for 15 minutes. It runs after 6 so it reads the macmini's newest file,
#    under PULSE_TIMEOUT seconds (default 90), and a failed or hung pulse never stops the copies that follow. launchd's PATH has no
#    ~/.local/bin, where herdr lives, so it is added here.
# 8) MacBook → macmini, into ~/sobaegi-lead/state/macbook/: tools/open_orders.ts of $DORI_REPO (default ~/src/omp-dori), the state
#    files inbound.log, discord-sent.log, ready-reply.log, to-macmini.log, orders-closed.log, lead-alive.json (the pulse of 7), and
#    lanes/<key>.json made here from the lane records: the key, the status, lastActivityAt and the order ids the lane or its brief
#    names, nothing else. The lanes folder there is replaced as a whole; nothing else is deleted. sync-records-1117.
# The log gets a line only when something was copied, the kept-as-newer list changed, or a step failed.
set -uo pipefail
SSH='ssh -o ControlMaster=no -o ControlPath=none -o ConnectTimeout=10 -o BatchMode=yes'
CANON=/Users/son-won-il/.omo/memory/agents/sanjai-agent-1e565cbf/repo/system/owner-now.md
H=$HOME/.omp-dori
RSYNC=${RSYNC:-/opt/homebrew/bin/rsync}
REPO=${DORI_REPO:-$HOME/src/omp-dori}
say() { [ -n "$2" ] && printf '%s %s %s\n' "$(date '+%F %T')" "$1" "$2"; return 0; }

out=$("$RSYNC" -ti --chmod=F444 -e "$SSH" "macmini:$CANON" "$H/owner-now.md" 2>&1) || out="FAILED $out"
say owner-now "$out"
if [ -f "$H/반복지적.md" ]; then
  out=$("$RSYNC" -ti -e "$SSH" --rsync-path='mkdir -p ~/.omp-dori && rsync' "$H/반복지적.md" macmini:.omp-dori/ 2>&1) || out="FAILED $out"
  say 반복지적 "$out"
fi
out=$(/usr/bin/python3 "$H/bin/owner-direct-forward.py" 2>&1) || out="FAILED $out"
say owner-direct "$out"
out=$("$RSYNC" -rtpiu --info=skip1 --chmod=F444 -e "$SSH" --exclude='_bak*' --exclude='*.bak*' --exclude='evidence/' --exclude='_failed_run*/' \
  --include='*/' --include='*독후감*.md' --include='*독후감*.txt' --include='*반영대목*.md' --include='기자팁원리.md' \
  --include='어휘표*.md' --include='*단어*.md' --include='*어휘*.md' --exclude='*' --prune-empty-dirs \
  macmini:sobaegi-lead/results/ "$HOME/sobaegi-lead/results/" 2>&1); rc=$?
newer=$(printf '%s\n' "$out" | grep ' is newer$' | sort)
out=$(printf '%s\n' "$out" | grep -v ' is newer$')
if [ "$rc" -ne 0 ]; then
  say 독후감 "FAILED rc=$rc $out"
else
  say 독후감 "$out"
  NEWER=$H/state/owner-sync.newer
  if [ "$newer" != "$(cat "$NEWER" 2>/dev/null)" ]; then
    printf '%s\n' "$newer" > "$NEWER"
    say 독후감 "맥북이 더 새 것 $(printf '%s' "$newer" | grep -c .)개, 목록 $NEWER"
  fi
fi
UP=(-rti --ignore-existing -e "$SSH" --exclude='_bak*' --exclude='*.bak*' --exclude='evidence/' --exclude='_failed_run*/' --exclude='_tools/')
out=$("$RSYNC" "${UP[@]}" --include='*/' --include='*독후감*.md' --include='독서메모.md' --exclude='*' --prune-empty-dirs \
  "$HOME/sobaegi-lead/results/" macmini:sobaegi-lead/results/ 2>&1) || out="FAILED $out"
say 독후감올림 "$(printf '%s\n' "$out" | grep -E '^<f|^FAILED|rsync' | head -40)"
if [ -d "$H/results" ]; then
  out=$("$RSYNC" "${UP[@]}" --include='/*/' --include='/*/독후감*.md' --exclude='*' --prune-empty-dirs \
    "$H/results/" macmini:sobaegi-lead/results/ 2>&1) || out="FAILED $out"
  say 독후감올림 "$(printf '%s\n' "$out" | grep -E '^<f|^FAILED|rsync' | head -40)"
fi

mkdir -p "$H/state/macmini"
out=$("$RSYNC" -dti -e "$SSH" --include=open-orders.json --include=reply.log --include=lead-alive.json --exclude='*' \
  macmini:sobaegi-lead/state/ "$H/state/macmini/" 2>&1) || out="FAILED $out"
say 기록받음 "$(printf '%s\n' "$out" | grep -E '^[<>]f|^FAILED|rsync' | head -40)"

out=$(PATH="$HOME/.local/bin:$PATH" /usr/bin/perl -e 'alarm shift; exec @ARGV' "${PULSE_TIMEOUT:-90}" "$H/bin/dori" lead-pulse 2>&1) || out="FAILED $out"
say lead-pulse "$(printf '%s\n' "$out" | grep -v -E '^PULSE alive=true .* reviveFailed=false$' | head -20)"

lanes="$H/state/lanes-summary"
rm -rf "$lanes"; mkdir -p "$lanes"
out=$(/usr/bin/python3 - "$H" "$lanes" <<'PY' 2>&1
import glob, json, os, re, sys
home, dst = sys.argv[1:3]
for path in glob.glob(os.path.join(home, "lanes", "*.json")):
    try:
        lane = json.load(open(path))
        key, status = lane["key"], lane["status"]
    except (OSError, ValueError, KeyError):
        continue
    brief = os.path.join(home, "briefs", key + ".md")
    text = json.dumps(lane, ensure_ascii=False) + (open(brief, encoding="utf-8", errors="replace").read() if os.path.exists(brief) else "")
    summary = {"key": key, "status": status, "lastActivityAt": lane.get("lastActivityAt") or lane.get("createdAt") or 0,
               "orders": sorted(set(re.findall(r"\d{16,22}", text)))}
    json.dump(summary, open(os.path.join(dst, key + ".json"), "w"), ensure_ascii=False)
PY
) || out="FAILED $out"
say 일감요약 "$out"
send=()
for f in "$REPO/tools/open_orders.ts" "$H"/state/{inbound.log,discord-sent.log,ready-reply.log,to-macmini.log,orders-closed.log,lead-alive.json}; do
  [ -f "$f" ] && send+=("$f")
done
if [ "${#send[@]}" -gt 0 ]; then
  out=$("$RSYNC" -ti -e "$SSH" --rsync-path='mkdir -p ~/sobaegi-lead/state/macbook && rsync' "${send[@]}" macmini:sobaegi-lead/state/macbook/ 2>&1) || out="FAILED $out"
  say 기록보냄 "$(printf '%s\n' "$out" | grep -E '^<f|^FAILED|rsync' | head -40)"
fi
out=$("$RSYNC" -rti --delete -e "$SSH" --rsync-path='mkdir -p ~/sobaegi-lead/state/macbook/lanes && rsync' "$lanes/" macmini:sobaegi-lead/state/macbook/lanes/ 2>&1) || out="FAILED $out"
say 일감보냄 "$(printf '%s\n' "$out" | grep -E '^<f|^\*deleting|^FAILED|rsync' | head -40)"
