#!/usr/bin/env bash
# Runs one agent identity's cycles back-to-back on Anthropic API credits until
# its budget or time runs out. Called by .github/workflows/agent-credit-burst.yml;
# see that file for the secrets and variables it reads.
#
# Env: ROLE, BUDGET (USD), HOURS, the TOKEN_* / *_MODEL values for the roles,
# and GITHUB_STEP_SUMMARY. Exits 1 after three failed cycles in a row.
set -uo pipefail

case "$ROLE" in
  producer)
    export KINETIX_TOKEN="$TOKEN_PRODUCER"; model="$PRODUCER_MODEL"; effort=high
    prompt='Read agents/drug-db-maintainer.md end-to-end, then run exactly one cycle and emit its end-of-cycle paragraph (§9). Output only that paragraph.' ;;
  reviewer)
    export KINETIX_TOKEN="$TOKEN_REVIEWER"; model="$REVIEWER_MODEL"; effort=high
    prompt='Read agents/drug-db-escalation.md end-to-end, then run exactly one cycle and emit its end-of-cycle paragraph (§5). Output only that paragraph.' ;;
  adjudicator-a)
    export KINETIX_TOKEN="$TOKEN_ADJ_A"; model="$ADJ_A_MODEL"; effort=xhigh
    prompt='Read agents/drug-db-adjudication.md end-to-end, then run exactly one cycle as it specifies. Emit a one-paragraph summary of what you did as your final message, nothing more.' ;;
  adjudicator-b)
    export KINETIX_TOKEN="$TOKEN_ADJ_B"; model="$ADJ_B_MODEL"; effort=xhigh
    prompt='Read agents/drug-db-adjudication.md end-to-end, then run exactly one cycle as it specifies. Emit a one-paragraph summary of what you did as your final message, nothing more.' ;;
  *)
    echo "::error::Unknown ROLE '$ROLE'." >&2; exit 1 ;;
esac
unset TOKEN_PRODUCER TOKEN_REVIEWER TOKEN_ADJ_A TOKEN_ADJ_B

# Claude Code scrubs subprocess env by default under GitHub Actions. That strips
# every *TOKEN* variable from Bash, including KINETIX_TOKEN, which the helpers
# need (agents/drug-db-maintainer.md §0), and it will not start without
# bubblewrap. So scrubbing is off, and ANTHROPIC_API_KEY is visible to the
# agent's Bash just as KINETIX_TOKEN already is in the Routines. Owner decision:
# use a dedicated API key for this workflow and delete it after the burst.
export CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0

# A cycle may not spend more than this; it guards against a runaway cycle, not
# the total, which the loop below tracks.
cycle_cap=15
deadline=$(( $(date +%s) + $(awk -v h="$HOURS" 'BEGIN { if (h > 5.5) h = 5.5; print int(h * 3600) }') ))
spent=0; cycle=0; failures=0; status=0
errlog=$(mktemp)

# Claude Code already requires Node. Use that installed runtime to inspect its
# JSON result rather than requiring a separate jq binary on Windows workers.
read_result() {
  node -e '
    try {
      const result = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      const field = process.argv[1];
      if (field === "cost") {
        if (typeof result.total_cost_usd === "number") console.log(result.total_cost_usd);
      } else if (field === "message") {
        console.log(result.result ?? "(no final message)");
      } else if (field === "success") {
        console.log(result.is_error === false);
      } else process.exit(1);
    } catch { process.exit(1); }
  ' "$1"
}

while :; do
  remaining=$(awk -v b="$BUDGET" -v s="$spent" 'BEGIN { printf "%.2f", b - s }')
  if awk -v r="$remaining" 'BEGIN { exit !(r < 1) }'; then echo "Budget reached."; break; fi
  if [ "$(date +%s)" -ge "$deadline" ]; then echo "Time limit reached."; break; fi
  cap=$(awk -v r="$remaining" -v c="$cycle_cap" 'BEGIN { printf "%.2f", (r < c ? r : c) }')
  cycle=$((cycle + 1))

  out=$(timeout 75m claude -p "$prompt" \
    --model "$model" --effort "$effort" \
    --permission-mode dontAsk \
    --allowedTools Bash Read WebSearch WebFetch \
    --disallowedTools Edit Write NotebookEdit \
    --max-budget-usd "$cap" \
    --output-format json 2>"$errlog")

  # A killed or crashed cycle reports no cost, but may already have spent up
  # to its cap. Count the whole cap so the total stays an upper bound.
  cost=$(read_result cost <<<"$out" 2>/dev/null)
  [ -n "$cost" ] || cost=$cap
  spent=$(awk -v s="$spent" -v c="$cost" 'BEGIN { printf "%.2f", s + c }')

  echo "::group::Cycle $cycle — \$$cost (total \$$spent of \$$BUDGET)"
  read_result message <<<"$out" 2>/dev/null || echo "(cycle produced no result)"
  echo "::endgroup::"

  # Out of credits, a revoked token or an API outage fails every cycle the
  # same way; stop rather than retry it for six hours.
  if [ "$(read_result success <<<"$out" 2>/dev/null)" = true ]; then
    failures=0
  else
    failures=$((failures + 1))
    # Show why. stderr carries CLI errors, not agent output, and the Actions
    # log masks any secret value that appears in it.
    grep -v -e '\$bunfs' -e '^ *[0-9]* |' "$errlog" | tail -n 15
    if [ "$failures" -ge 3 ]; then
      echo "::error::Three failed cycles in a row; stopping."
      status=1
      break
    fi
  fi
done

echo "### $ROLE: $cycle cycles, \$$spent spent" >> "$GITHUB_STEP_SUMMARY"
exit "$status"
