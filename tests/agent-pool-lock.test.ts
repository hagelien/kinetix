/**
 * Every documented way to create an agent takes the agent-pool advisory lock
 * a consensus re-check shares (issue #1357). A path that skips it could add an
 * agent while a two-agent pool is being counted and let an edit publish on the
 * degraded one-approval quorum.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AGENT_POOL_LOCK_KEY,
  AGENT_POOL_LOCK_NAMESPACE,
} from '../src/lib/agentPoolLock';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('agent pool lock', () => {
  it('wraps every agents INSERT in the provisioning doc in the lock', () => {
    const doc = read('agents/adding-a-new-agent.md');
    const blocks = doc.match(/```sql\n[\s\S]*?```/g) ?? [];
    const inserts = blocks.filter((b) => /INSERT INTO agents/.test(b));
    expect(inserts.length).toBeGreaterThan(0);
    for (const block of inserts) {
      expect(block).toMatch(/^```sql\nBEGIN;/);
      expect(block).toContain(
        `SELECT pg_advisory_xact_lock(${AGENT_POOL_LOCK_NAMESPACE}, ${AGENT_POOL_LOCK_KEY});`,
      );
      expect(block).toMatch(/COMMIT;\n```$/);
    }
  });

  it('takes the lock in the seed script and the admin create path', () => {
    const script = read('scripts/seed-agent-user.ts');
    expect(script).toMatch(/db\.batch\(\[\s*db\.execute\(\s*sql`SELECT pg_advisory_xact_lock\(\$\{AGENT_POOL_LOCK_NAMESPACE\}/);
    const admin = read('api/admin.ts');
    expect(admin).toMatch(/withAgentPoolGrowthLock\(async \(\) => \{\s*const \[created\] = await getDb\(\)\s*\.insert\(agents\)/);
  });

  it('finds no agent-creation path outside the lock', () => {
    // Every tracked file outside tests and migrations that inserts an agents
    // row must take the pool lock; a new seed or doc recipe fails here until
    // it does.
    const files = execFileSync(
      'git',
      ['grep', '-liE', 'insert into agents|\\.insert\\(agents\\)', '--', '.', ':!tests', ':!drizzle', ':!migrations'],
      { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(0);
    const unlocked = files.filter((file) => {
      const text = read(file);
      return !(
        text.includes(`pg_advisory_xact_lock(${AGENT_POOL_LOCK_NAMESPACE}, ${AGENT_POOL_LOCK_KEY})`) ||
        text.includes('withAgentPoolGrowthLock(') ||
        text.includes('pg_advisory_xact_lock(${AGENT_POOL_LOCK_NAMESPACE}')
      );
    });
    expect(unlocked).toEqual([]);
  });

  it('takes the lock inside the Codex seed transaction, before the insert', () => {
    const seed = read('scripts/seed-codex-agent.sql');
    const begin = seed.indexOf('BEGIN;');
    const lock = seed.indexOf(`SELECT pg_advisory_xact_lock(${AGENT_POOL_LOCK_NAMESPACE}, ${AGENT_POOL_LOCK_KEY});`);
    const insert = seed.indexOf('INSERT INTO agents');
    expect(begin).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(begin);
    expect(insert).toBeGreaterThan(lock);
  });
});
