#!/usr/bin/env bash
#
# Download one stored citation PDF for an authenticated Kinetix agent.
#
# The first request goes to Kinetix with the kxat_ agent credential. Small
# PDFs are returned directly. Large PDFs receive a short-lived 302 to a
# presigned private Blob URL. That second request is deliberately made WITHOUT
# the agent cookie, so the Kinetix credential is never forwarded off-origin.
#
# Usage:
#   scripts/download-citation-pdf.sh <citationId> [output-path]
#
# With no output path, writes the PDF bytes to stdout.
#
set -euo pipefail

citation_id="${1:?usage: scripts/download-citation-pdf.sh <citationId> [output-path]}"
output_path="${2:-}"

: "${KINETIX_BASE_URL:?KINETIX_BASE_URL is required}"
: "${KINETIX_TOKEN:?KINETIX_TOKEN is required (a kxat_ agent token; see npm run seed:agent-token)}"

url="${KINETIX_BASE_URL%/}/api/citation-pdf?citationId=${citation_id}"

if [[ "${KINETIX_AGENT_DRY_RUN:-0}" == "1" ]]; then
  echo "[dry-run] GET ${url} (agent PDF download; follows presigned redirect without auth)" >&2
  exit 0
fi

headers="$(mktemp)"
body="$(mktemp)"
cleanup() {
  rm -f "$headers" "$body"
}
trap cleanup EXIT

status="$(
  curl -sS \
    -D "$headers" \
    -o "$body" \
    -w '%{http_code}' \
    -H "Cookie: __Host-kinetix-auth=${KINETIX_TOKEN}" \
    "$url"
)"

emit() {
  if [[ -n "$output_path" ]]; then
    cat > "$output_path"
  else
    cat
  fi
}

# True only when $1 is an https URL whose HOSTNAME is a private Blob host.
#
# This has to parse the authority rather than glob the whole URL. A bash `case`
# pattern's `*` matches `/` as well, so `https://*.blob.vercel-storage.com/*`
# also accepts `https://evil.example/x.blob.vercel-storage.com/payload`, whose
# host is `evil.example` — the helper would have downloaded attacker-chosen
# bytes and handed them to the extraction agents as the stored paper.
#
# Fails closed: anything that does not parse as an https URL on a
# `*.blob.vercel-storage.com` host is rejected.
is_blob_redirect() {
  local url="$1" rest authority host

  [[ "$url" == https://* ]] || return 1
  rest="${url#https://}"

  # The authority ends at the first '/', '?' or '#'.
  authority="${rest%%[/?#]*}"
  [[ -n "$authority" ]] || return 1

  # Reject embedded credentials outright. A presigned Blob URL never carries
  # any, and `https://x.blob.vercel-storage.com@evil.example/p` would otherwise
  # read as an allowed host while curl resolves `evil.example`.
  [[ "$authority" != *@* ]] || return 1

  # Drop an optional ':port'. An IPv6 literal is left as '[' and rejected below.
  host="${authority%%:*}"
  host="${host,,}"

  # A non-empty label is required in front of the suffix, so the bare domain
  # and a leading-dot host do not pass.
  [[ "$host" == ?*.blob.vercel-storage.com ]] || return 1

  return 0
}

case "$status" in
  200)
    emit < "$body"
    ;;
  302)
    location="$(awk 'tolower($1) == "location:" { sub(/^[^:]+:[[:space:]]*/, ""); sub(/\r$/, ""); print; exit }' "$headers")"
    if ! is_blob_redirect "$location"; then
      echo "ERROR: Kinetix returned an invalid PDF redirect" >&2
      exit 22
    fi

    # No KINETIX_TOKEN header/cookie is present on this request. The presigned
    # URL itself is the short-lived credential for this one Blob object.
    if [[ -n "$output_path" ]]; then
      curl -sS --fail-with-body "$location" -o "$output_path"
    else
      curl -sS --fail-with-body "$location"
    fi
    ;;
  *)
    cat "$body" >&2
    echo "ERROR: Kinetix PDF request failed with HTTP ${status}" >&2
    exit 22
    ;;
esac
