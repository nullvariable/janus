Weekly keyword analysis task. Runs Mondays via janus heartbeat (see `heartbeats.json`).

1. Read all research files from the past 7 days in `workspace/research/`.
2. Analyze the content to identify emerging themes, frequently mentioned concepts, and relevant topics that relate to your product's positioning (replace this with your own focus area).
3. **Classify each candidate keyword against history.** Pull the last ~4 weekly reports for trend context:

   ```
   mcp__qmd__multi_get(
     pattern="marketing-workspace/reports/keyword-analysis-*.md",
     maxBytes=20480
   )
   ```

   Match keyword text, not section headings — prior reports may use varying section names (`Recommended Keywords`, `Recommended New Keywords`, `Top Recommended New Keywords`, etc.). For every keyword you're about to recommend, tag it with one of:

   - **NEW** — no prior report mentions it
   - **RECURRING (Nx)** — appeared in N prior reports
   - **STALE (Nx, no action)** — recurring 3+ weeks but never added to your seed-keyword list. Recommend retiring it from future analysis OR escalate ("repeated 4+ weeks without action — kill or commit").

   This tag is non-optional. A recommendation without a history tag is incomplete.
4. Create a report at `workspace/reports/keyword-analysis-YYYY-MM-DD.md` (today's date) with:
   - Date range analyzed
   - Current keyword focus (replace with your own seed keyword)
   - Up to 10 recommended new keywords to consider, each with:
     - The keyword/phrase
     - **History tag** (NEW / RECURRING Nx / STALE Nx)
     - Why it's relevant (what you observed in the research)
     - Estimated search intent alignment with your product
5. Keep recommendations actionable and specific to your space.

## Final post (Mattermost)

After the report file is written, post a **single one-line saved-notice** to your team channel via the `post` tool. Format exactly:

```
📊 Weekly keyword report saved → workspace/reports/keyword-analysis-YYYY-MM-DD.md
```

Example task file. Replace the placeholders above with your own product/keyword focus before deploying.
