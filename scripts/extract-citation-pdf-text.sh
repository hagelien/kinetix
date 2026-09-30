#!/usr/bin/env bash
#
# Extract plain text from a stored citation PDF, for the paper-review action
# of the drug-db maintenance agent (agents/drug-db-maintainer.md §11).
#
# It fetches the stored PDF through scripts/download-citation-pdf.sh, which
# authenticates the Kinetix request and safely follows the short-lived
# presigned redirect used for PDFs too large for a function response. The
# agent credential is never forwarded to the Blob host. It then runs Poppler's
# `pdftotext`.
#
# This is a *fallback* text-extraction path. A runner whose model can read
# PDFs natively (e.g. the Claude Code Read tool) should prefer that on the
# downloaded PDF — it also reads scanned / image-only pages, which
# `pdftotext` cannot. See the note under exit code 44 below.
#
# Usage:
#   scripts/extract-citation-pdf-text.sh <citationId>
#
# On success: prints the path to a non-empty extracted .txt file on stdout
# and exits 0.
#
# Exit codes:
#   1   — usage error (no citationId; from the ${1:?…} guard below)
#   42  — pdftotext is not installed (install poppler-utils in the runner
#         environment BEFORE the cycle starts; never install during a cycle)
#   43  — the stored PDF download was empty (no stored PDF / unavailable)
#   44  — pdftotext produced no text. The PDF may be scanned / image-only or
#         otherwise have no text layer. This does NOT by itself mean the paper
#         is unreadable: a runner with native visual PDF reading can often
#         still read it from the downloaded file ("$pdf", printed on stderr).
#         Only treat the paper as not reviewable when native reading also
#         fails — then skip and log no_change (see §11).
#
set -euo pipefail

citation_id="${1:?usage: scripts/extract-citation-pdf-text.sh <citationId>}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v pdftotext >/dev/null 2>&1; then
  echo "ERROR: pdftotext unavailable; install poppler-utils in the routine environment before the agent cycle starts (do not install during a cycle)" >&2
  exit 42
fi

pdf="/tmp/kinetix-citation-${citation_id}.pdf"
txt="/tmp/kinetix-citation-${citation_id}.txt"

"${script_dir}/download-citation-pdf.sh" "$citation_id" "$pdf"

if [[ ! -s "$pdf" ]]; then
  echo "ERROR: stored PDF download was empty for citationId=${citation_id} (no stored PDF, or it is unavailable)" >&2
  exit 43
fi

pdftotext -layout "$pdf" "$txt"

if [[ ! -s "$txt" ]]; then
  echo "ERROR: extracted PDF text is empty for citationId=${citation_id}; PDF may be scanned/image-only or have no text layer. The downloaded PDF is at ${pdf} — a runner with native PDF reading can still try to read it before skipping." >&2
  exit 44
fi

echo "$txt"
