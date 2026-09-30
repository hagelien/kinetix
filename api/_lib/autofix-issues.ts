/**
 * Auto-fix pipeline (issues side).
 *
 * Turns build and runtime errors into labeled GitHub issues that a Claude
 * Code GitHub trigger picks up to open fix PRs. See agents/error-fixer.md
 * (what the fix agent does) and agents/autofix-setup.md (how to wire the
 * Vercel log drain + deployment webhook + GitHub PAT + trigger).
 *
 * Best-effort by design, mirroring api/_lib/agentHooks.ts: every entry point
 * runs inside a request or webhook path, so nothing here ever throws —
 * failures are logged and swallowed. Config is env-only:
 *
 * - `GITHUB_AUTOFIX_TOKEN` — fine-grained PAT, Issues: write on the repo.
 * - `GITHUB_REPO`          — e.g. `hagelien/kinetix`.
 * - `AUTOFIX_DISABLED=1`   — pause without removing secrets.
 * - `AUTOFIX_DRY_RUN=1`    — log what would be filed, create nothing.
 *
 * Dedup is stateless: each issue body embeds a hidden `autofix-fp:<hash>`
 * marker; before filing we search open issues for that marker. An in-memory
 * cooldown (reusing rate-limit.ts) collapses repeats of the same fingerprint
 * within a single function instance so a flapping error can't storm GitHub.
 */
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { consumeRateLimit } from './rate-limit.js';

/** Prefix the response.ts choke point writes so the drain can find error
 *  lines in the firehose. Kept in sync with api/_lib/response.ts. */
export const ERROR_LOG_MARKER = 'KINETIX_ERROR';

/**
 * Don't refile the same fingerprint more than once per window (per instance).
 * GitHub-side dedup still catches cross-instance repeats.
 *
 * Per source, because the two sources have opposite risks. The runtime drain
 * is a firehose — one bad deploy can emit the same error thousands of times a
 * minute — so a long window is what keeps a flapping route from hammering the
 * GitHub search API.
 *
 * Build failures arrive at most one per deployment, from a signature-verified
 * webhook, and since they are now keyed on the branch (see
 * api/vercel-deploy-hook.ts) repeats DO share a fingerprint. A six-hour window
 * there suppresses the case this pipeline most needs to catch: a branch that
 * is fixed, its issue closed, and broken again the same afternoon. The
 * cooldown runs before `openIssueExists`, so a warm instance would drop that
 * second failure without ever noticing the issue had closed. Short enough to
 * still absorb a webhook retry-storm, short enough that GitHub state — which
 * is the authority for dedup — gets consulted for anything slower.
 */
const COOLDOWN_MS: Record<ErrorReport['source'], number> = {
  runtime: 6 * 60 * 60 * 1000,
  build: 60 * 1000,
};

const GH_API = 'https://api.github.com';
const AUTOFIX_LABEL = 'auto-fix';

export interface ErrorReport {
  source: 'runtime' | 'build';
  title: string;
  fingerprint: string;
  /** Markdown body (the fingerprint marker is prepended automatically). */
  body: string;
}

/**
 * Verify Vercel's `x-vercel-signature`, which is the hex HMAC-SHA1 of the
 * raw request body keyed by the drain / webhook secret. Constant-time
 * compare; returns false on any shape mismatch.
 */
export function verifyVercelSignature(
  rawBody: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;
  const expected = createHmac('sha1', secret)
    .update(rawBody, 'utf8')
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Stable short hash for an error. Volatile bits (long numbers, hex
 * addresses, UUIDs) are normalised out so the same logical failure across
 * requests collapses onto one fingerprint — and therefore one issue.
 */
export function fingerprint(parts: ReadonlyArray<string>): string {
  const normalized = parts
    .filter(Boolean)
    .join('\n')
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      'UUID',
    )
    .replace(/0x[0-9a-f]+/gi, '0x#')
    .replace(/\b\d{4,}\b/g, '#')
    .toLowerCase();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Stable short hash for a key made of IDENTIFIERS rather than error text —
 * a project name, a git ref, a deployment id.
 *
 * `fingerprint()` above is built for error text, where collapsing volatile
 * bits is the whole point. Run an identifier through it and that collapsing
 * destroys exactly what the key exists to distinguish: `\b\d{4,}\b` → `#`
 * merges `release/2025` with `release/2026` and `fix/1234` with `fix/5678`,
 * and the `toLowerCase()` merges `Feature/X` with `feature/x` even though git
 * refs are case-sensitive. Two unrelated branches sharing a key means the
 * second one's failure is swallowed by the first one's open issue.
 *
 * Joined on NUL, which cannot occur in any of these identifiers, so no
 * rearrangement of the parts can produce the same input.
 */
export function fingerprintIdentity(parts: ReadonlyArray<string>): string {
  return createHash('sha256')
    .update(parts.filter(Boolean).join('\0'))
    .digest('hex')
    .slice(0, 16);
}

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/postgres(?:ql)?:\/\/[^\s"']+/gi, 'postgres://<redacted>'],
  [/(https?:\/\/)[^:\s/@]+:[^@\s/]+@/gi, '$1<credentials>@'],
  [
    /\b((?:(?:access_)?token|api[_-]?key|secret|password|passwd|pwd|authorization)=)[^&\s"']+/gi,
    '$1<redacted>',
  ],
  [/kxat_[A-Za-z0-9]+/g, 'kxat_<redacted>'],
  [/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer <redacted>'],
  // JWT tokens: eyJ is the base64url encoding of '{"', the start of every JWT
  // header. Match header.payload.signature (all base64url segments) so a JWT
  // that appears in a Cookie header or stack trace is redacted even when it is
  // not preceded by 'Bearer '.
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, 'eyJ<jwt-redacted>'],
  // GitHub PATs (classic ghp_/gho_/ghs_/ghu_/ghr_ and fine-grained github_pat_):
  [/\bgh[a-z]_[A-Za-z0-9_]{20,}\b/g, 'gh<type>_<redacted>'],
  [/\bgithub_pat_[A-Za-z0-9_]+\b/g, 'github_pat_<redacted>'],
  // Resend email-service API keys (re_<random>):
  [/\bre_[A-Za-z0-9]{20,}\b/g, 're_<redacted>'],
  // __Host- prefixed cookies are by definition security-sensitive (the prefix
  // requires Secure + no Domain attribute). Redact the full name=value pair so
  // auth session cookies don't leak into GitHub issue bodies.
  [/__Host-[^=\s;]+=\S+/g, '__Host-<cookie-redacted>'],
];

/** Strip credentials that can surface in stack traces / driver errors. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const [re, repl] of SECRET_PATTERNS) out = out.replace(re, repl);
  return out;
}

function issueTitle(title: string): string {
  return (
    scrubSecrets(title).replace(/\s+/g, ' ').trim().slice(0, 200) ||
    '[auto-fix] Error report'
  );
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'kinetix-autofix',
  };
}

async function openIssueExists(
  repo: string,
  token: string,
  fp: string,
): Promise<boolean> {
  const q = encodeURIComponent(
    `repo:${repo} is:issue is:open label:${AUTOFIX_LABEL} "autofix-fp:${fp}"`,
  );
  const res = await fetch(`${GH_API}/search/issues?q=${q}`, {
    headers: ghHeaders(token),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    // Don't know the state — proceed to create. The in-memory cooldown caps
    // this to at most one create per fingerprint per window, so a flaky
    // search can't cause a storm.
    console.warn(
      `[autofix] issue search returned ${res.status}; proceeding to file`,
    );
    return false;
  }
  const data = (await res.json()) as { total_count?: number };
  return (data.total_count ?? 0) > 0;
}

async function createIssue(
  repo: string,
  token: string,
  title: string,
  body: string,
): Promise<void> {
  const res = await fetch(`${GH_API}/repos/${repo}/issues`, {
    method: 'POST',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ title, body, labels: [AUTOFIX_LABEL] }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(
      `[autofix] create issue failed ${res.status}: ${text.slice(0, 200)}`,
    );
    return;
  }
  const issue = (await res.json()) as { number?: number };
  console.log(`[autofix] filed issue #${issue.number ?? '?'} for fingerprint`);
}

/**
 * File (or dedupe) a GitHub issue for one error. Never throws.
 */
export async function reportError(report: ErrorReport): Promise<void> {
  try {
    if (process.env.AUTOFIX_DISABLED === '1') return;

    const repo = process.env.GITHUB_REPO;
    const token = process.env.GITHUB_AUTOFIX_TOKEN;
    if (!repo || !token) {
      console.warn(
        '[autofix] GITHUB_REPO / GITHUB_AUTOFIX_TOKEN unset — skipping issue',
      );
      return;
    }

    const title = issueTitle(report.title);
    const body = `<!-- autofix-fp:${report.fingerprint} -->\n\n${scrubSecrets(report.body)}`;

    if (process.env.AUTOFIX_DRY_RUN === '1') {
      console.log(
        `[autofix][dry-run] would file: "${title}" (fp ${report.fingerprint})`,
      );
      return;
    }

    const { limited } = consumeRateLimit(
      'autofix-fp',
      report.fingerprint,
      1,
      COOLDOWN_MS[report.source],
    );
    if (limited) return;

    if (await openIssueExists(repo, token, report.fingerprint)) return;
    await createIssue(repo, token, title, body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[autofix] reportError failed: ${message}`);
  }
}
