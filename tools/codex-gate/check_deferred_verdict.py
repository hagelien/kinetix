"""Exercise the Codex gate's deferred-finding sign-off against a mocked `gh`.

.github/workflows/codex-gate.yml signs off on a Codex review whose only
findings are P2/P3 once each has a reply, by someone who can push, linking an
open issue labelled review-debt (`deferred_verdict`). That is a merge decision, so
every way it can wrongly say yes is pinned down here: a P1 on the head, an
unbadged finding, an unfiled finding, a reply from a non-writer (including a
MEMBER who only holds read), a linked issue without the label, a closed one, and a link that
is really a pull request.

The function is read out of the workflow as shipped and run under bash with
`gh` replaced by a shell function serving fixtures, so nothing touches GitHub.

Usage:  python tools/codex-gate/check_deferred_verdict.py
        (needs pyyaml, bash and jq; exits non-zero on any failure)
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

WORKFLOW = Path(".github/workflows/codex-gate.yml")
REPO = "hagelien/kinetix"
BOT = "chatgpt-codex-connector[bot]"
HEAD = "abc123"


def load_function() -> str:
    run = yaml.safe_load(WORKFLOW.read_text())["jobs"]["gate"]["steps"][0]["run"]
    return re.search(r"^deferred_verdict\(\) \{.*?^\}$", run, re.S | re.M).group(0)


def badge(sev: str) -> str:
    return (f"**<sub><sub>![{sev} Badge](https://img.shields.io/badge/{sev}-yellow?style=flat)"
            "</sub></sub>  Thing**\n\nDetails.")


def finding(cid: int, body: str, review: int = 1) -> dict:
    return {"id": cid, "user": {"login": BOT}, "body": body,
            "pull_request_review_id": review, "in_reply_to_id": None,
            "author_association": "NONE"}


def reply(cid: int, to: int, body: str, user: str = "hagelien",
          assoc: str = "OWNER") -> dict:
    return {"id": cid, "user": {"login": user}, "body": body,
            "pull_request_review_id": 99, "in_reply_to_id": to,
            "author_association": assoc}


# Codex reviews: #1 is on the head, #2 on an older commit.
REVIEWS = [
    {"id": 1, "user": {"login": BOT}, "commit_id": HEAD},
    {"id": 2, "user": {"login": BOT}, "commit_id": "old"},
]

# Issues the mock serves: 70/71 are filed debt, 72 lacks the label, 73 is a PR,
# 74 is debt that has already been closed.
ISSUES = {
    70: {"pull_request": None, "state": "open", "labels": [{"name": "P2"}, {"name": "review-debt"}]},
    71: {"pull_request": None, "state": "open", "labels": [{"name": "P3"}, {"name": "review-debt"}]},
    72: {"pull_request": None, "state": "open", "labels": [{"name": "P2"}]},
    73: {"pull_request": {"url": "x"}, "state": "open", "labels": [{"name": "review-debt"}]},
    74: {"pull_request": None, "state": "closed", "labels": [{"name": "P2"}, {"name": "review-debt"}]},
}
PERMISSIONS = {"hagelien": "admin", "maintainer": "write", "triager": "read", "rando": "none"}

URL = f"https://github.com/{REPO}/issues"

# name -> (review comments, expected sign-off?)
CASES: dict[str, tuple[list[dict], bool]] = {
    "every P2/P3 filed (URL and #ref)": ([
        finding(10, badge("P2")), reply(11, 10, f"Filed as {URL}/70"),
        finding(12, badge("P3")), reply(13, 12, "Deferred: #71", user="maintainer", assoc="MEMBER"),
        finding(20, badge("P1"), review=2),  # older head: irrelevant
    ], True),
    "one P2 not yet filed": ([
        finding(10, badge("P2")), reply(11, 10, "#70"), finding(12, badge("P2")),
    ], False),
    "P1 on the head, even with an issue": ([
        finding(10, badge("P1")), reply(11, 10, "#70"),
    ], False),
    "P0 on the head": ([finding(10, badge("P0")), reply(11, 10, "#70")], False),
    "finding with no badge": ([finding(10, "A remark."), reply(11, 10, "#70")], False),
    "reply by an outsider": ([
        finding(10, badge("P2")), reply(11, 10, "#70", user="rando", assoc="NONE"),
    ], False),
    "reply by a MEMBER holding only read": ([
        finding(10, badge("P2")), reply(11, 10, "#70", user="triager", assoc="MEMBER"),
    ], False),
    "linked issue lacks review-debt": ([
        finding(10, badge("P2")), reply(11, 10, "#72"),
    ], False),
    "link is a pull request": ([
        finding(10, badge("P2")), reply(11, 10, "#73"),
    ], False),
    "linked review-debt issue is already closed": ([
        finding(10, badge("P2")), reply(11, 10, "#74"),
    ], False),
    "HTML entity is not an issue link": ([
        finding(10, badge("P2")), reply(11, 10, "see &#70;"),
    ], False),
    "no findings on the head": ([finding(20, badge("P1"), review=2)], False),
}

HARNESS = r"""
set -euo pipefail
REPO=__REPO__; PR=42; HEAD=__HEAD__; BOT_RE='^chatgpt-codex-connector\[bot\]$'
REVIEWS="$(cat "$FIX/reviews.json")"
gh() {
  local path="" q="" prev="" a
  for a in "$@"; do
    case "$a" in repos/*) path="$a" ;; esac
    [ "$prev" = "--jq" ] && q="$a"
    prev="$a"
  done
  case "$path" in
    */pulls/42/comments*) cat "$FIX/comments.json" ;;
    */collaborators/*/permission)
      local who="${path#*/collaborators/}"; who="${who%/permission}"
      jq -r --arg w "$who" '.[$w] // "none"' "$FIX/permissions.json" ;;
    */issues/*)
      local n="${path##*/}"
      jq -e --arg n "$n" 'has($n)' "$FIX/issues.json" >/dev/null || return 1
      jq --arg n "$n" '.[$n]' "$FIX/issues.json" | jq -r "$q" ;;
    *) return 1 ;;
  esac
}
source "$FIX/fn.sh"
deferred_verdict
"""


def main() -> int:
    fn = load_function()
    failures = 0
    with tempfile.TemporaryDirectory() as tmp:
        fix = Path(tmp)
        (fix / "fn.sh").write_text(fn + "\n")
        (fix / "reviews.json").write_text(json.dumps(REVIEWS))
        (fix / "issues.json").write_text(json.dumps({str(k): v for k, v in ISSUES.items()}))
        (fix / "permissions.json").write_text(json.dumps(PERMISSIONS))
        script = HARNESS.replace("__REPO__", REPO).replace("__HEAD__", HEAD)
        for name, (comments, expected) in CASES.items():
            (fix / "comments.json").write_text(json.dumps(comments))
            out = subprocess.run(["bash", "-c", script], env={"FIX": tmp, "PATH": "/usr/bin:/bin"},
                                 capture_output=True, text=True)
            signed = out.stdout.startswith("OK|")
            ok = out.returncode == 0 and signed == expected
            failures += not ok
            print(f"  {'ok  ' if ok else 'FAIL'}  {name}: "
                  f"{'sign-off' if signed else 'no sign-off'} (expected {'sign-off' if expected else 'none'})"
                  + ("" if ok else f"\n        stdout={out.stdout!r} stderr={out.stderr!r}"))
    if failures:
        print(f"FAILED: {failures} of {len(CASES)} cases")
        return 1
    print(f"OK: {len(CASES)} cases")
    return 0


if __name__ == "__main__":
    sys.exit(main())
