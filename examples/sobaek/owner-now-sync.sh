#!/bin/bash
# Every 2 min (launchd com.sobaek.ompdori-owner-sync, Nice 10 / Background / LowPriorityIO). sync-all-1116, macmini od395.
# 1) macmini canonical owner-now.md → ~/.omp-dori/owner-now.md (read-only 444). Only the macmini lead writes the canonical one.
# 2) ~/.omp-dori/반복지적.md (the MacBook writes it) → macmini ~/.omp-dori/반복지적.md. Skipped while the file does not exist.
# 3) New owner Discord messages → appended as original words to macmini inbox/ompdori/owner-direct.md (owner-direct-forward.py).
# 4) macmini ~/sobaegi-lead/results/ 독후감·단어장(어휘표) md/txt → same path on the MacBook, files read-only (444), no delete.
#    -p re-applies 444 to files that already existed. -u keeps a MacBook file that is newer than the macmini one (a MacBook edit that never went back);
#    --info=skip1 puts each such skipped file in the log ("… is newer"). Backups, evidence/ and json are left out.
#    The writer case lists (~/.omp-dori/writer-cases/*.txt) point at these paths, so a passage opens the same sentence on both Macs. rootfix-pr4-1116.
# The log gets a line only when something was copied, kept as newer, or failed.
set -uo pipefail
SSH='ssh -o ControlMaster=no -o ControlPath=none -o ConnectTimeout=10 -o BatchMode=yes'
CANON=/Users/son-won-il/.omo/memory/agents/sanjai-agent-1e565cbf/repo/system/owner-now.md
H=$HOME/.omp-dori
RSYNC=/opt/homebrew/bin/rsync
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
  macmini:sobaegi-lead/results/ "$HOME/sobaegi-lead/results/" 2>&1) || out="FAILED $out"
say 독후감 "$out"
