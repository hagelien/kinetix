#!/usr/bin/env bash
# Create or update the repository's labels from .github/labels.json.
#
# Labels are not repository content — they live in GitHub's own store — so
# nothing in a clone can guarantee they exist. This script is the one place that
# declares them, so a label set is reviewable in a pull request instead of being
# hand-made in the web UI and quietly diverging.
#
# `gh label create --force` creates a missing label and updates the colour and
# description of one that already exists. It never deletes: a label that is not
# listed here is left untouched, because a stray label costs nothing while
# deleting one strips it off every issue that carries it, irreversibly.
#
# Usage: npm run labels:sync            (needs `gh auth login`)
#        GH_REPO=owner/name ./scripts/sync-labels.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
definitions="$root/.github/labels.json"

if ! command -v gh >/dev/null 2>&1; then
  echo "sync-labels: the GitHub CLI (gh) is required" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "sync-labels: jq is required" >&2
  exit 1
fi

# Tab-separated so a description containing spaces survives the read loop.
jq -r '.labels[] | [.name, .color, .description] | @tsv' "$definitions" |
  while IFS=$'\t' read -r name color description; do
    echo "sync-labels: $name"
    gh label create "$name" --color "$color" --description "$description" --force
  done
