#!/usr/bin/env bash
#
# Thin curl wrapper for the Kinetix API, used by the drug-db maintenance
# agent. Auto-attaches the agent session cookie and the JSON content type.
#
# Required env:
#   KINETIX_BASE_URL  — e.g. https://kinetix.app
#
# Auth:
#   KINETIX_TOKEN     — required. A persistent, revocable agent token
#                       (prefix "kxat_") issued via `npm run seed:agent-token`
#                       or Admin → Agents → Tokens. Agent-backed users can no
#                       longer authenticate with a bare JWT, so a kxat_ token
#                       is the only accepted credential here.
#
# Optional env:
#   KINETIX_AGENT_DRY_RUN — when "1", prints the request it would send and
#                           exits 0 without hitting the network.
#
# Usage:
#   scripts/kinetix-api.sh <METHOD> <PATH> [@body.json | -]
#
# Examples:
#   scripts/kinetix-api.sh GET  '/api/drugs?limit=20'
#   scripts/kinetix-api.sh POST '/api/drug-discussions?drugId=12' @/tmp/body.json
#   echo '{"body":"…"}' | scripts/kinetix-api.sh POST '/api/drug-discussions?drugId=12' -

set -euo pipefail

METHOD="${1:-}"
PATH_ARG="${2:-}"
BODY_ARG="${3:-}"

if [[ -z "$METHOD" || -z "$PATH_ARG" ]]; then
  echo "usage: kinetix-api.sh <METHOD> <PATH> [@body.json | -]" >&2
  exit 2
fi

: "${KINETIX_BASE_URL:?KINETIX_BASE_URL is required}"

# Auth is a persistent kxat_ token carried in KINETIX_TOKEN. Unlike the old
# bare-JWT flow there's nothing to mint per-run: issue the token once with
# `npm run seed:agent-token` and set it in the scheduler's environment.
: "${KINETIX_TOKEN:?KINETIX_TOKEN is required (a kxat_ agent token; see npm run seed:agent-token)}"

URL="${KINETIX_BASE_URL%/}${PATH_ARG}"

BODY_DESCR="none"
BODY_FILE=""

if [[ -n "$BODY_ARG" ]]; then
  if [[ "$BODY_ARG" == "@"* ]]; then
    BODY_FILE="${BODY_ARG:1}"
    if [[ ! -f "$BODY_FILE" ]]; then
      echo "body file not found: $BODY_FILE" >&2
      exit 2
    fi
    BODY_DESCR="file:${BODY_FILE}"
  elif [[ "$BODY_ARG" == "-" ]]; then
    BODY_DESCR="stdin"
  else
    echo "body argument must be @path/to/file.json or - (stdin)" >&2
    exit 2
  fi
fi

if [[ "${KINETIX_AGENT_DRY_RUN:-0}" == "1" ]]; then
  echo "[dry-run] ${METHOD} ${URL}  body=${BODY_DESCR}" >&2
  if [[ -n "$BODY_ARG" ]]; then
    printf '[dry-run-body] ' >&2
    if [[ -n "$BODY_FILE" ]]; then
      cat < "$BODY_FILE" >&2
    else
      cat >&2
    fi
    printf '\n' >&2
  fi
  exit 0
fi

CURL_ARGS=(
  -sS
  --fail-with-body
  -X "$METHOD"
  -H "Content-Type: application/json; charset=utf-8"
  -H "Cookie: __Host-kinetix-auth=${KINETIX_TOKEN}"
)

if [[ -n "$BODY_ARG" ]]; then
  # Keep JSON out of argv. Git Bash -> native Windows curl converts argv to
  # the Windows code page (e.g. UTF-8 ø becomes byte F8, invalid in UTF-8).
  # stdin preserves the original bytes, including Norwegian and PK symbols,
  # and avoids Windows' command-line length limit for full paper reviews.
  CURL_ARGS+=(--data-binary @-)
fi

if [[ -n "$BODY_FILE" ]]; then
  curl "${CURL_ARGS[@]}" "$URL" < "$BODY_FILE"
else
  curl "${CURL_ARGS[@]}" "$URL"
fi
