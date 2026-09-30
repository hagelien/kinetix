"""Check the Codex gate's concurrency routing against the invariants it relies on.

.github/workflows/codex-gate.yml decides two things about every event twice,
in two places that cannot share code: the job-level `if` decides whether the
job runs at all, and the `concurrency.group` suffix decides which group the run
occupies. GitHub resolves concurrency when a run is *created*, before the `if`
is evaluated, so a run that is about to skip every job still evicts whatever
shares its group. The two expressions therefore have to agree, and nothing in
Actions checks that they do — a drift between them is silent, and shows up as a
PR that merges hours late rather than as a failure.

This reads both expressions out of the workflow as shipped, evaluates them
under GitHub's expression semantics, and asserts:

  A. nothing routed to `-noop` may actually run the job. Erring this way puts
     two live runs on one PR, which is the billed-minutes cost the grouping
     exists to remove. (The opposite error — a skipped event left in a live
     group — is merely one wasted cancel, so the conditions are deliberately a
     strict subset rather than an exact complement.)
  B. nothing that skips the job may land in `sweep-live`. That group is shared
     with the cron and workflow_dispatch, so a skipped run there evicts a real
     sweep and leaves its PRs for the next cron.
  C. an event that runs the job but can never poll — `should_wait` refuses
     workflow_run and check_suite — must not sit in a `-live` group, or a green
     CI result would cancel a poller and replace it with a run that cannot wait
     for the 👍 that raises no webhook.

Positive controls run alongside, so the invariants cannot pass by the `if`
evaluating false for everything.

Usage:  python tools/codex-gate/check_concurrency_routing.py
        (needs pyyaml; exits non-zero on any violation)
"""
from __future__ import annotations

import itertools
import math
import re
import sys
from pathlib import Path

import yaml

WORKFLOW = Path(".github/workflows/codex-gate.yml")

# These mirror the workflow's own values. They are duplicated on purpose: if
# one is changed there without being changed here, the controls below fail.
OVERRIDE_LABEL = "merge-when-green"
CODEX = "chatgpt-codex-connector[bot]"
CANNOT_POLL = {"workflow_run", "check_suite"}


# --- a small evaluator for the subset of GitHub expressions used here --------

class Ctx:
    """Context object whose absent keys read as null, as GitHub's do."""

    def __init__(self, d: object = None) -> None:
        self._d = d if isinstance(d, dict) else {}

    def __getattr__(self, k: str) -> object:
        v = self._d.get(k)
        if isinstance(v, dict):
            return Ctx(v)
        if isinstance(v, list):
            return Lst(v)
        return MISSING if v is None else v

    def __getitem__(self, i: int) -> object:
        return MISSING

    def __bool__(self) -> bool:
        return bool(self._d)


class Lst:
    """Indexing past the end yields null in GitHub expressions, not an error."""

    def __init__(self, items: list) -> None:
        self._items = items

    def __getitem__(self, i: int) -> object:
        if i >= len(self._items):
            return MISSING
        v = self._items[i]
        return Ctx(v) if isinstance(v, dict) else v


MISSING = Ctx()


def num(v: object) -> float:
    """GitHub casts operands to numbers for comparison. null and false both
    become 0; a present object becomes NaN, which is why `object == null` is
    false while `absent == null` is true."""
    if v is None or v is MISSING:
        return 0
    if isinstance(v, (Ctx, Lst)):
        return math.nan
    if v is True:
        return 1
    if v is False:
        return 0
    if isinstance(v, str):
        try:
            return float(v)
        except ValueError:
            return math.nan
    return v


def gh_eq(a: object, b: object) -> bool:
    """Loose equality: strings compare case-insensitively, everything else by
    the numeric cast above."""
    if isinstance(a, str) and isinstance(b, str):
        return a.lower() == b.lower()
    x, y = num(a), num(b)
    if isinstance(x, float) and math.isnan(x):
        return False
    if isinstance(y, float) and math.isnan(y):
        return False
    return x == y


def contains(haystack: object, needle: object) -> bool:
    """GitHub's contains() is documented as case-insensitive, which is what
    lets the workflow match both `codex` and `chatgpt-codex-connector[bot]`."""
    if haystack is None or haystack is MISSING or isinstance(haystack, Ctx):
        return False
    return str(needle).lower() in str(haystack).lower()


_VALUE = r"('[^']*'|True|False|None|[\w\.\[\]]+)"
_OPERAND = r"([\w\.\[\]]+(?:\([^()]*\))?)"


def to_python(expr: str) -> str:
    expr = re.sub(r"\bnull\b", "None", expr.strip())
    expr = re.sub(r"\btrue\b", "True", expr)
    expr = re.sub(r"\bfalse\b", "False", expr)
    expr = expr.replace("&&", " and ").replace("||", " or ")
    expr = re.sub(r"!(?!=)", " not ", expr)
    # route ==/!= through gh_eq so the loose-equality rules above apply
    expr = re.sub(rf"{_OPERAND}\s*==\s*{_VALUE}", r"gh_eq(\1, \2)", expr)
    expr = re.sub(rf"{_OPERAND}\s*!=\s*{_VALUE}", r"(not gh_eq(\1, \2))", expr)
    return expr


def evaluate(expr: str, event_name: str, payload: dict) -> object:
    env = {
        "gh_eq": gh_eq,
        "contains": contains,
        "github": Ctx({"event_name": event_name, "event": payload}),
        "inputs": Ctx({}),
    }
    return eval(to_python(expr), env)  # noqa: S307 - fixed input, from the repo


# --- the expressions, read out of the workflow as shipped --------------------

def load_expressions() -> tuple[str, str, str, str]:
    wf = yaml.safe_load(WORKFLOW.read_text())
    job_if = wf["jobs"]["gate"]["if"]
    group = wf["concurrency"]["group"]
    key = re.search(r"^codex-gate-\$\{\{(.*?)\}\}-\$\{\{", group, re.S).group(1)
    suffix = re.search(r"\}\}-\$\{\{(.*)\}\}$", group, re.S).group(1)
    noop = re.search(r"^(.*?)&& 'noop'", suffix, re.S).group(1)
    return job_if, key, suffix, noop


JOB_IF, KEY, SUFFIX, NOOP = load_expressions()


def runs_job(event_name: str, payload: dict) -> bool:
    return bool(evaluate(JOB_IF, event_name, payload))


def group_of(event_name: str, payload: dict) -> str:
    key = evaluate(KEY, event_name, payload)
    if key is MISSING or isinstance(key, (Ctx, Lst)) or not key:
        key = "sweep"
    return f"codex-gate-{key}-{evaluate(SUFFIX, event_name, payload)}"


# --- the event matrix --------------------------------------------------------

def build_cases() -> list[tuple[str, dict]]:
    authors = ["hagelien", CODEX, "Codex", "dependabot[bot]"]
    bools = [True, False]
    conclusions = ["success", "failure", "cancelled", None]
    # a push build carries no PR; a PR build carries one
    pr_lists = [[], [{"number": 42}]]

    cases: list[tuple[str, dict]] = []
    for author, draft in itertools.product(authors, bools):
        cases.append(("pull_request_review", {
            "review": {"user": {"login": author}},
            "pull_request": {"number": 42, "draft": draft},
        }))
    for author, is_pr, state in itertools.product(authors, bools, ["open", "closed"]):
        cases.append(("issue_comment", {
            "comment": {"user": {"login": author}},
            "issue": {"number": 42, "state": state,
                      "pull_request": {"url": "x"} if is_pr else None},
        }))
    actions = ["opened", "synchronize", "reopened", "ready_for_review", "labeled"]
    labels = [OVERRIDE_LABEL, "codex-approved", None]
    for action, draft, label in itertools.product(actions, bools, labels):
        cases.append(("pull_request", {
            "action": action,
            "label": {"name": label} if label else None,
            "pull_request": {"number": 42, "draft": draft},
        }))
    for concl, event, prs in itertools.product(conclusions, ["pull_request", "push"], pr_lists):
        cases.append(("workflow_run", {
            "workflow_run": {"conclusion": concl, "event": event, "pull_requests": prs},
        }))
    for concl, prs in itertools.product(conclusions, pr_lists):
        cases.append(("check_suite", {"check_suite": {"conclusion": concl, "pull_requests": prs}}))
    cases.append(("schedule", {}))
    cases.append(("workflow_dispatch", {}))
    return cases


# --- positive controls -------------------------------------------------------
# Without these the invariants could pass by the `if` refusing everything.

CONTROLS: list[tuple[str, str, dict, bool]] = [
    ("codex review, non-draft", "pull_request_review",
     {"review": {"user": {"login": CODEX}},
      "pull_request": {"number": 42, "draft": False}}, True),
    ("codex review, draft", "pull_request_review",
     {"review": {"user": {"login": CODEX}},
      "pull_request": {"number": 42, "draft": True}}, False),
    ("human review, non-draft", "pull_request_review",
     {"review": {"user": {"login": "hagelien"}},
      "pull_request": {"number": 42, "draft": False}}, False),
    ("codex comment on open PR", "issue_comment",
     {"comment": {"user": {"login": CODEX}},
      "issue": {"number": 42, "state": "open", "pull_request": {"url": "x"}}}, True),
    ("codex comment on plain issue", "issue_comment",
     {"comment": {"user": {"login": CODEX}},
      "issue": {"number": 42, "state": "open", "pull_request": None}}, False),
    ("synchronize, non-draft", "pull_request",
     {"action": "synchronize", "pull_request": {"number": 42, "draft": False}}, True),
    ("opened, draft", "pull_request",
     {"action": "opened", "pull_request": {"number": 42, "draft": True}}, False),
    (f"labeled {OVERRIDE_LABEL}", "pull_request",
     {"action": "labeled", "label": {"name": OVERRIDE_LABEL},
      "pull_request": {"number": 42, "draft": False}}, True),
    ("labeled codex-approved", "pull_request",
     {"action": "labeled", "label": {"name": "codex-approved"},
      "pull_request": {"number": 42, "draft": False}}, False),
    ("workflow_run success on PR", "workflow_run",
     {"workflow_run": {"conclusion": "success", "event": "pull_request",
                       "pull_requests": [{"number": 42}]}}, True),
    ("workflow_run green push build", "workflow_run",
     {"workflow_run": {"conclusion": "success", "event": "push", "pull_requests": []}}, False),
    ("check_suite success with PR", "check_suite",
     {"check_suite": {"conclusion": "success", "pull_requests": [{"number": 42}]}}, True),
    ("check_suite success, no PR", "check_suite",
     {"check_suite": {"conclusion": "success", "pull_requests": []}}, False),
    ("schedule sweep", "schedule", {}, True),
    ("workflow_dispatch", "workflow_dispatch", {}, True),
]


def main() -> int:
    cases = build_cases()
    violations: list[str] = []
    tally: dict[str, int] = {}

    for event_name, payload in cases:
        runs = runs_job(event_name, payload)
        group = group_of(event_name, payload)
        suffix = group.rsplit("-", 1)[1]
        tally[suffix] = tally.get(suffix, 0) + 1

        if suffix == "noop" and runs:
            violations.append(f"A: routed noop but the job runs: {event_name} {payload}")
        if not runs and group == "codex-gate-sweep-live":
            violations.append(f"B: skips but sits in sweep-live: {event_name} {payload}")
        if runs and event_name in CANNOT_POLL and suffix == "live":
            violations.append(f"C: runs, cannot poll, but sits in -live: {event_name} {payload}")

    routed = ", ".join(f"{n} -> {s}" for s, n in sorted(tally.items()))
    print(f"{len(cases)} synthetic events routed: {routed}")

    control_failures = 0
    ran = 0
    for label, event_name, payload, expected in CONTROLS:
        got = runs_job(event_name, payload)
        ran += got
        if got != expected:
            control_failures += 1
            print(f"  CONTROL FAILED  {label}: job runs={got}, expected {expected}")
    print(f"{len(CONTROLS)} positive controls, {ran} of which run the job")

    # Skipped events left in a live group are safe only because their key can
    # collide with nothing. Print them so that stops being an unexamined claim.
    residual = sorted({
        group_of(e, p) for e, p in cases
        if not runs_job(e, p) and group_of(e, p).endswith("-live")
    })
    if residual:
        print("skipped events still routed live (each must be harmless): "
              + ", ".join(residual))

    for v in violations:
        print(f"  VIOLATION {v}")
    if violations or control_failures:
        print(f"FAILED: {len(violations)} violation(s), {control_failures} control failure(s)")
        return 1
    print("OK: all invariants hold")
    return 0


if __name__ == "__main__":
    sys.exit(main())
