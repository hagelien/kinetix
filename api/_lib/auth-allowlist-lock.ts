import { sql } from 'drizzle-orm';
import { getDb, inTransaction } from './db.js';

// Two-key advisory locks have a separate keyspace from per-drug bigint locks.
const AUTH_ALLOWLIST_NAMESPACE = 0x414c4c53;

/** Hold eligibility stable from its first read through storing the new code. */
export function withAuthAllowlistReadLock<T>(fn: () => Promise<T>): Promise<T> {
  return inTransaction(async () => {
    await getDb().execute(sql`SELECT pg_advisory_xact_lock_shared(${AUTH_ALLOWLIST_NAMESPACE}::int, 1)`);
    return fn();
  });
}

/** Acquire first inside allowlist-removal or force-logout transactions. */
export async function lockAuthAllowlistRemoval(): Promise<void> {
  await getDb().execute(sql`SELECT pg_advisory_xact_lock(${AUTH_ALLOWLIST_NAMESPACE}::int, 1)`);
}
