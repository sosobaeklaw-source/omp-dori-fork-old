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
# 5) 독후감·독서메모 written on the MacBook → the macmini's ~/sobaegi-lead/results/, -u instead of --ignore-existing: a note
#    rewritten after its last upload goes up again, while a file the macmini already holds newer than the MacBook copy is kept
#    (never overwritten). Two sources: the MacBook's own ~/sobaegi-lead/results/ and each omp lane's
#    DORI_HOME/results/<lane>/독후감*.md (top level of the lane folder only; copies kept deeper as references stay). The ontology
#    refresh (macmini 04:30) reads only the macmini's results folder, so a note written here reached it only after going up. sync-up-1117.
# 5) ~/.omp-dori/독후감/소화본/ (the digests) → macmini ~/.omp-dori/독후감/소화본/. The MacBook copy is the only one anyone edits; copies go one way,
#    so an edit made on the macmini is overwritten. There is no --delete: a digest retired on the MacBook must also be removed on the macmini by hand.
# The log gets a line only when something was copied, the kept-as-newer list changed, or a step failed.
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
[ -d "$H/독후감/소화본" ] && { out=$("$RSYNC" -rti -e "$SSH" --rsync-path='mkdir -p ~/.omp-dori/독후감/소화본 && rsync' "$H/독후감/소화본/" macmini:.omp-dori/독후감/소화본/ 2>&1) || out="FAILED $out"; say 소화본 "$out"; }
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
UP=(-rtiu -e "$SSH" --exclude='_bak*' --exclude='*.bak*' --exclude='evidence/' --exclude='_failed_run*/' --exclude='_tools/')
out=$("$RSYNC" "${UP[@]}" --include='*/' --include='*독후감*.md' --include='독서메모.md' --exclude='*' --prune-empty-dirs \
  "$HOME/sobaegi-lead/results/" macmini:sobaegi-lead/results/ 2>&1) || out="FAILED $out"
say 독후감올림 "$(printf '%s\n' "$out" | grep -E '^<f|^FAILED|rsync' | head -40)"
if [ -d "$H/results" ]; then
  out=$("$RSYNC" "${UP[@]}" --include='/*/' --include='/*/독후감*.md' --exclude='*' --prune-empty-dirs \
    "$H/results/" macmini:sobaegi-lead/results/ 2>&1) || out="FAILED $out"
  say 독후감올림 "$(printf '%s\n' "$out" | grep -E '^<f|^FAILED|rsync' | head -40)"
fi
