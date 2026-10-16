// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Drives scripts/agent-credit-burst.sh against a stub `claude` that either
// succeeds, reports an API error, or dies without printing its result JSON.
const script = path.resolve(__dirname, "../scripts/agent-credit-burst.sh");
const gitBin = path.join(
  process.env.ProgramFiles ?? "C:/Program Files", "Git", "bin",
);
const bash =
  process.platform === "win32" && existsSync(path.join(gitBin, "bash.exe"))
    ? path.join(gitBin, "bash.exe")
    : "bash";
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "credit-burst-"));
  const stub = path.join(dir, "claude");
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
echo "scrub=\${CLAUDE_CODE_SUBPROCESS_ENV_SCRUB:-unset} $*" >> "$STUB_LOG"
case "$STUB_MODE" in
  ok) echo '{"is_error":false,"result":"Did a cycle.","total_cost_usd":4}' ;;
  error) echo '{"is_error":true,"result":"Credit balance is too low","total_cost_usd":0}' ;;
  crash)
    echo "error: bubblewrap is required for subprocess env scrubbing" >&2
    exit 1 ;;
esac
`,
  );
  chmodSync(stub, 0o755);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(mode: string, budget: number) {
  const log = path.join(dir, `${mode}.log`);
  const summary = path.join(dir, `${mode}.md`);
  writeFileSync(log, "");
  writeFileSync(summary, "");
  const result = spawnSync(bash, [script.replaceAll("\\", "/")], {
    encoding: "utf8",
    env: {
      PATH: [
        dir,
        process.env.PATH ?? process.env.Path,
        ...(process.platform === "win32" ? [path.join(gitBin, "../usr/bin")] : []),
      ].join(path.delimiter),
      STUB_MODE: mode,
      STUB_LOG: log,
      GITHUB_STEP_SUMMARY: summary,
      ROLE: "reviewer",
      BUDGET: String(budget),
      HOURS: "1",
      TOKEN_PRODUCER: "",
      TOKEN_REVIEWER: "kxat_test",
      TOKEN_ADJ_A: "",
      TOKEN_ADJ_B: "",
      PRODUCER_MODEL: "claude-sonnet-5-5",
      REVIEWER_MODEL: "claude-opus-5-5",
      ADJ_A_MODEL: "claude-opus-5-5",
      ADJ_B_MODEL: "claude-fable-5-1",
    },
  });
  const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  return {
    status: result.status,
    stdout: result.stdout,
    calls,
    summary: readFileSync(summary, "utf8"),
  };
}

describe("agent-credit-burst.sh", () => {
  it("stops at the budget and caps the last cycle at what remains", () => {
    const { status, calls, summary } = run("ok", 10);
    expect(status).toBe(0);
    expect(calls).toHaveLength(3);
    expect(calls[2]).toContain("--max-budget-usd 2.00");
    expect(summary).toContain("reviewer: 3 cycles, $12.00 spent");
  });

  // Scrubbing strips KINETIX_TOKEN from Bash too, so the helpers would fail,
  // and it refuses to start without bubblewrap. It must be switched off
  // explicitly because Claude Code turns it on under GitHub Actions.
  it("keeps the Kinetix token visible to the agent's helpers", () => {
    const { calls } = run("ok", 5);
    expect(calls[0]).toMatch(/^scrub=0 /);
    expect(calls[0]).toContain("--allowedTools Bash Read WebSearch WebFetch");
  });

  it("counts a cycle that died without reporting its cost as its full cap", () => {
    const { calls, summary, stdout } = run("crash", 20);
    expect(calls).toHaveLength(2);
    expect(stdout).toContain("error: bubblewrap is required");
    expect(summary).toContain("reviewer: 2 cycles, $20.00 spent");
  });

  it("fails the job after three failed cycles in a row", () => {
    const { status, calls } = run("error", 100);
    expect(status).toBe(1);
    expect(calls).toHaveLength(3);
  });
});
