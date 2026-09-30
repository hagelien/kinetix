/**
 * Append one row to verification_log through the Kinetix API — the required
 * audit trail step after every action the drug-db maintenance agent takes
 * (see agents/drug-db-maintainer.md §8).
 *
 * This helper intentionally does not read DATABASE_URL. Scheduled LLM
 * routines should carry only the revocable `kxat_…` API token, not direct
 * database credentials.
 *
 * Required env:
 *   KINETIX_BASE_URL  — e.g. https://kinetix.app
 *   KINETIX_TOKEN     — revocable agent token (prefix "kxat_")
 *
 * Optional env:
 *   KINETIX_AGENT_DRY_RUN — when "1", prints the row it would send and exits 0
 *                           without touching the API.
 *
 * Usage:
 *   npx tsx scripts/kinetix-log-verification.ts \
 *     --target-type <parameter|monograph_fact|discussion_sweep|rejection_review|paper_review|paper_extraction> \
 *     [--target-id <int>] \
 *     [--parameter <id>] \
 *     [--sources-count <N>] \
 *     [--concordance <strong|moderate|weak|absent>] \
 *     --outcome <submitted_pending|flagged|commented_only|no_change> \
 *     [--notes "<one line>"]
 *
 * `--target-id` and `--parameter` are optional in general but **required
 * together for `--target-type parameter --concordance absent`**, and the
 * parameter must be a registry id (`bioavailability`, not `half_life`). That
 * row is the one log entry that does something: the gap queue suppresses the
 * pair for ABSENT_RECHECK_DAYS by matching both columns, so a row missing
 * either matches nothing and the same gap is served again next cycle. The API
 * rejects it with a 400 rather than accepting a log line that cannot work.
 */
import 'dotenv/config';
import { kinetixApi } from './kinetix-http';

const TARGET_TYPES = [
  'parameter',
  'monograph_fact',
  'discussion_sweep',
  'rejection_review',
  'paper_review',
  // One row per paper fact-extraction run (agents/paper-fact-extractor.md §6).
  'paper_extraction',
] as const;
const CONCORDANCE_VALUES = ['strong', 'moderate', 'weak', 'absent'] as const;
const OUTCOMES = [
  'submitted_pending',
  'flagged',
  'commented_only',
  'no_change',
] as const;

type TargetType = (typeof TARGET_TYPES)[number];
type Concordance = (typeof CONCORDANCE_VALUES)[number];
type Outcome = (typeof OUTCOMES)[number];

function die(msg: string): never {
  console.error(`[kinetix-log-verification] ${msg}`);
  process.exit(1);
}

// Every flag in this script takes a value — there are no boolean/bare
// flags. If a `--foo` is followed by EOF or another `--bar`, that's a
// malformed invocation and we fail fast so an audit-trail row never gets
// written with a silently-dropped field.
function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (!tok.startsWith('--')) {
      die(`unexpected positional argument: ${tok}`);
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      die(`flag --${key} requires a value`);
    }
    out[key] = next;
    i++;
  }
  return out;
}

const flags = parseFlags(process.argv.slice(2));

const targetType = flags['target-type'] as TargetType;
if (!TARGET_TYPES.includes(targetType)) {
  die(`--target-type must be one of ${TARGET_TYPES.join('|')}`);
}

const outcome = flags['outcome'] as Outcome;
if (!OUTCOMES.includes(outcome)) {
  die(`--outcome must be one of ${OUTCOMES.join('|')}`);
}

const concordanceRaw = flags['concordance'];
let concordance: Concordance | null = null;
if (concordanceRaw) {
  if (!CONCORDANCE_VALUES.includes(concordanceRaw as Concordance)) {
    die(`--concordance must be one of ${CONCORDANCE_VALUES.join('|')}`);
  }
  concordance = concordanceRaw as Concordance;
}

const targetIdRaw = flags['target-id'];
let targetId: number | null = null;
if (targetIdRaw) {
  const n = Number(targetIdRaw);
  if (!Number.isInteger(n) || n <= 0)
    die('--target-id must be a positive integer');
  targetId = n;
}

const sourcesRaw = flags['sources-count'];
let sourcesConsultedCount = 0;
if (sourcesRaw) {
  const n = Number(sourcesRaw);
  if (!Number.isInteger(n) || n < 0)
    die('--sources-count must be a non-negative integer');
  sourcesConsultedCount = n;
}

const row = {
  targetType,
  targetId,
  parameter: flags['parameter'] || null,
  agentNotes: flags['notes'] || null,
  sourcesConsultedCount,
  concordance,
  outcome,
};

if (process.env.KINETIX_AGENT_DRY_RUN === '1') {
  console.error(`[dry-run] verification_log API request: ${JSON.stringify(row)}`);
  process.exit(0);
}

const baseUrl = process.env.KINETIX_BASE_URL;
if (!baseUrl) die('KINETIX_BASE_URL is required');

const token = process.env.KINETIX_TOKEN;
if (!token) die('KINETIX_TOKEN is required (a kxat_ agent token)');

// Delegate the HTTP to scripts/kinetix-api.sh (curl) so the request uses the
// same proxied egress path as the rest of the routine — see scripts/kinetix-http.ts.
const result = kinetixApi('POST', '/api/agent-verification-log', row);
if (!result.ok) {
  die(`error: ${result.body}`);
}
let parsed: { id?: number };
try {
  parsed = JSON.parse(result.body) as { id?: number };
} catch {
  die(`unexpected non-JSON response: ${result.body.slice(0, 200)}`);
}
console.log(`verification_log.id=${parsed.id}`);
