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

# Keep ANTHROPIC_API_KEY out of the agent's Bash and hook subprocesses, so a
# prompt injection in fetched or database content cannot read it. The Kinetix
# token stays visible to Bash because the helpers need it — the same exposure
# the Routines have (agents/drug-db-maintainer.md §0).
export CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1

# A cycle may not spend more than this; it guards against a runaway cycle, not
# the total, which the loop below tracks.
cycle_cap=15
deadline=$(( $(date +%s) + $(awk -v h="$HOURS" 'BEGIN { if (h > 5.5) h = 5.5; print int(h * 3600) }') ))
spent=0; cycle=0; failures=0; status=0

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
    --output-format json 2>/dev/null)

  # A killed or crashed cycle reports no cost, but may already have spent up
  # to its cap. Count the whole cap so the total stays an upper bound.
  cost=$(jq -r 'if (.total_cost_usd | type) == "number" then .total_cost_usd else empty end' <<<"$out" 2>/dev/null)
  [ -n "$cost" ] || cost=$cap
  spent=$(awk -v s="$spent" -v c="$cost" 'BEGIN { printf "%.2f", s + c }')

  echo "::group::Cycle $cycle — \$$cost (total \$$spent of \$$BUDGET)"
  jq -r '.result // "(no final message)"' <<<"$out" 2>/dev/null || echo "(cycle produced no result)"
  echo "::endgroup::"

  # Out of credits, a revoked token or an API outage fails every cycle the
  # same way; stop rather than retry it for six hours.
  if [ "$(jq -r '.is_error == false' <<<"$out" 2>/dev/null)" = true ]; then
    failures=0
  else
    failures=$((failures + 1))
    if [ "$failures" -ge 3 ]; then
      echo "::error::Three failed cycles in a row; stopping."
      status=1
      break
    fi
  fi
done

echo "### $ROLE: $cycle cycles, \$$spent spent" >> "$GITHUB_STEP_SUMMARY"
exit "$status"
