/**
 * Source-level guarantees for the T3 tier
 * (docs/plans/2026-09-18-t3-adjudication-backend.md §5 "Append-only",
 * "Authority"): no code path updates or deletes an opinion — the database
 * trigger refuses it too — and nothing in this feature touches the capability
 * matrix. Exactly one module closes disputes: the automatic closure of a
 * converged agent-only case (api/_lib/adjudication/closure.ts, the owner's
 * governance decision), which closes `source = 'agent'` rows only, rules as
 * no identity (`resolvedBy: null`), and never withdraws.
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

  it('grants no capability, and resolves disputes in the closure module alone', () => {
    const grants = T3_FILES.filter((file) =>
      /dispute\.resolve|CAP\[['"]dispute\.resolve|withdrawOpenDispute|withdrawAgentDisputesForTarget/.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(grants).toEqual([]);
    const resolvers = T3_FILES.filter((file) => /resolveDisputeById/.test(readFileSync(file, 'utf8')));
    expect(resolvers).toEqual(['api/_lib/adjudication/closure.ts']);
  });

  it('closes agent disputes only, as no identity', () => {
    const closure = readFileSync('api/_lib/adjudication/closure.ts', 'utf8');
    expect(closure).toMatch(/eq\(disputes\.source, 'agent'\)/);
    const calls = closure.match(/resolveDisputeById\(\{[^}]*\}\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toMatch(/resolvedBy: null/);
  });
});
