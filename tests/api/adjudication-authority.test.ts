/**
 * Source-level guarantees for the T3 tier
 * (docs/plans/2026-09-18-t3-adjudication-backend.md §5 "Append-only",
 * "Authority"): no code path updates or deletes an opinion — the database
 * trigger refuses it too — and nothing in this feature resolves a dispute or
 * touches the capability matrix. T3 records recommendations; the closing act
 * is elsewhere.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
    return /\.ts$/.test(name) ? [path] : [];
  });
}

const T3_FILES = [
  ...sources('api/_lib/adjudication'),
  'api/agent-adjudication-queue.ts',
  'api/agent-adjudication-opinions.ts',
];

describe('T3 authority and append-only guarantees', () => {
  it('never updates or deletes an opinion anywhere in the API', () => {
    const offenders = sources('api').filter((file) =>
      /\.(update|delete)\(\s*adjudicationOpinions\b/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('resolves no dispute and grants no capability', () => {
    const offenders = T3_FILES.filter((file) =>
      /resolveDisputeById|withdrawOpenDispute|withdrawAgentDisputesForTarget|dispute\.resolve|CAP\[['"]dispute\.resolve/.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
