/**
 * Check a `kinetix-conversation-ingestion-v1` bundle before it goes anywhere.
 *
 *   npm run validate:ingestion -- bundle.json
 *   pbpaste | npm run validate:ingestion
 *   npx tsx scripts/validate-conversation-ingestion.ts bundle.json --json
 *
 * The `kinetix` skill (`.claude/skills/kinetix/SKILL.md`) runs in a chat window
 * with no connection to Kinetix, so its only output is JSON that a human carries
 * across. This script is the gate on that hand-off: it is the difference between
 * "the model emitted something JSON-shaped" and "this bundle would survive the
 * write path". Everything it enforces is enforced by `parseConversationIngestion`
 * — the script only does I/O and formatting.
 *
 * Exit codes: 0 = valid (warnings allowed), 1 = invalid or unreadable input.
 *
 * NOTE: a valid bundle is not an applied bundle. There is no ingestion endpoint
 * yet (see docs/superpowers/plans/2026-08-05-conversation-to-kinetix-skill.md,
 * phases 1-3); passing here means the JSON is well-formed, verified and
 * de-identified, not that Kinetix has accepted anything.
 */
import { readFileSync } from 'node:fs';
import {
  parseConversationIngestion,
  type IngestionItem,
} from '../src/lib/conversationIngestion.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const file = args.find((a) => !a.startsWith('--'));

function readInput(): string {
  if (file) return readFileSync(file, 'utf8');
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function fail(message: string): never {
  if (asJson) {
    console.log(JSON.stringify({ ok: false, errors: [message], warnings: [] }));
  } else {
    console.error(`✗ ${message}`);
  }
  process.exit(1);
}

const raw = readInput().trim();
if (!raw) {
  fail(
    'No input. Pass a file path (npm run validate:ingestion -- bundle.json) or pipe JSON on stdin.',
  );
}

let parsedJson: unknown;
try {
  parsedJson = JSON.parse(raw);
} catch (err) {
  fail(
    `Input is not valid JSON: ${err instanceof Error ? err.message : String(err)}. ` +
      'If you copied it out of a chat window, make sure the surrounding prose and ``` fences are gone.',
  );
}

const result = parseConversationIngestion(parsedJson);

if (asJson) {
  console.log(
    JSON.stringify(
      result.ok
        ? { ok: true, warnings: result.warnings, data: result.data }
        : { ok: false, errors: result.errors, warnings: result.warnings },
      null,
      2,
    ),
  );
  process.exit(result.ok ? 0 : 1);
}

function countByType(items: IngestionItem[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
  }
  return [...counts]
    .map(([type, n]) => `${n} × ${type}`)
    .join(', ');
}

if (!result.ok) {
  console.error(`✗ Invalid bundle — ${result.errors.length} error(s):\n`);
  for (const error of result.errors) console.error(`  • ${error}`);
  if (result.warnings.length) {
    console.error(`\n  ${result.warnings.length} warning(s):`);
    for (const warning of result.warnings) console.error(`  ~ ${warning}`);
  }
  console.error('');
  process.exit(1);
}

const { data, warnings } = result;
console.log('✓ Valid kinetix-conversation-ingestion-v1 bundle\n');
console.log(`  mode              ${data.mode}`);
console.log(`  idempotencyKey    ${data.idempotencyKey}`);
console.log(`  created           ${data.createdAt}`);
console.log(`  sources           ${data.sources.length}`);
console.log(
  `  items             ${data.items.length}${data.items.length ? ` (${countByType(data.items)})` : ''}`,
);
console.log(`  blockedCandidates ${data.blockedCandidates.length}`);

if (data.blockedCandidates.length) {
  console.log('\n  Blocked (verified to no standard — NOT proposals):');
  for (const candidate of data.blockedCandidates) {
    console.log(`  · ${candidate.summary}`);
    console.log(`      blocker: ${candidate.blocker}`);
  }
}

if (warnings.length) {
  console.log(`\n  ${warnings.length} warning(s):`);
  for (const warning of warnings) console.log(`  ~ ${warning}`);
}

console.log(
  '\n  Not applied. No ingestion endpoint exists yet — this only confirms the JSON is\n' +
    '  well-formed, source-verified and de-identified.\n',
);
