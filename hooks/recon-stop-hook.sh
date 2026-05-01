#!/bin/bash
# Temporary recon hook — captures Stop hook input JSON + transcript head
# to /tmp/hook-recon.log so we can discover the JSONL schema.
# Remove after inspection.
set -e
INPUT=$(cat)
echo "=== HOOK INPUT $(date -Iseconds) ===" >> /tmp/hook-recon.log
echo "$INPUT" | jq . >> /tmp/hook-recon.log 2>&1 || echo "$INPUT" >> /tmp/hook-recon.log
TPATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
if [[ -n "$TPATH" && -f "$TPATH" ]]; then
  echo "=== TRANSCRIPT TAIL (last 40 lines) ===" >> /tmp/hook-recon.log
  tail -40 "$TPATH" >> /tmp/hook-recon.log
fi
exit 0
