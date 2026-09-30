#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# `npm ci` installs exactly what the lockfile pins and never rewrites it.
# `npm install` reconciles the lockfile against package.json and can emit a
# one-line metadata drift on every boot, which leaves a dirty working tree at
# the start of each session — noise that read-only maintenance routines cannot
# commit and that no session should be committing on their behalf.
npm ci --no-audit --no-fund
