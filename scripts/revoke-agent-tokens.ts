/**
 * Bulk-revoke an agent's API tokens — cleanup for the token sprawl that builds
 * up because minting is additive and never auto-revokes (see
 * scripts/seed-agent-token.ts / Admin → Agents → Tokens).
 *
 * SAFE BY DEFAULT:
 *   - dry-run unless you pass --apply (prints exactly what it would revoke);
 *   - already-expired tokens are skipped (they can't authenticate anyway)
 *     unless you pass --include-expired;
 *   - it refuses to touch anything unless you tell it what to keep
 *     (--keep / --keep-last-used) or explicitly opt into --all-active.
 *
 * Required env:
 *   DATABASE_URL — same database the API reads.
 *
 * Usage:
 *   # see what WOULD be revoked, keeping the live token by prefix:
 *   npx tsx scripts/revoke-agent-tokens.ts --slug kinetix-agent --keep kxat_eiSisy
 *   # keep whichever active token was used most recently (the live one):
 *   npx tsx scripts/revoke-agent-tokens.ts --slug kinetix-agent --keep-last-used
 *   # actually perform it:
 *   npx tsx scripts/revoke-agent-tokens.ts --slug kinetix-agent --keep-last-used --apply
 *
 * Flags:
 *   --slug <agentSlug>     agent to clean up (default kinetix-agent)
 *   --keep <id|prefix>     preserve this token; repeatable / comma-separated
 *   --keep-last-used       additionally preserve the most-recently-used active token
 *   --include-expired      also revoke already-expired tokens (cosmetic)
 *   --all-active           allow revoking every active token (no keep required)
 *   --apply                perform the revokes (omit for a dry run)
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { getDb } from '../api/_lib/db';
import { revokeAgentToken } from '../api/_lib/agentHelpers';
import { agents, agentTokens } from '../db/schema';
import { fileURLToPath } from 'node:url';

export interface TokenRow {
  id: number;
  prefix: string;
  label: string | null;
  lastUsedAt: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface PartitionOpts {
  now: Date;
  keepIds: Set<number>;
  keepPrefixes: string[];
  keepLastUsed: boolean;
  includeExpired: boolean;
}

export interface Partition {
  revoke: TokenRow[];
  keep: TokenRow[];
  alreadyRevoked: TokenRow[];
  skippedExpired: TokenRow[];
}

function normalizePrefix(s: string): string {
  // Drop the trailing ellipsis the admin UI shows ("kxat_ab12cd…").
  return s.replace(/[….]+$/, '').trim();
}

function prefixMatch(tokenPrefix: string, keep: string): boolean {
  const a = normalizePrefix(tokenPrefix);
  const b = normalizePrefix(keep);
  if (!a || !b) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * Decide which tokens to revoke. Pure (no I/O) so it is unit-tested directly.
 * A token is kept when its id/prefix is in the keep set, or when it is the
 * single most-recently-used active token and --keep-last-used is on. Revoked
 * and (by default) expired tokens are never touched.
 */
export function partitionAgentTokens(
  tokens: TokenRow[],
  opts: PartitionOpts,
): Partition {
  const isExpired = (t: TokenRow) => t.expiresAt.getTime() <= opts.now.getTime();
  const isActive = (t: TokenRow) => t.revokedAt === null && !isExpired(t);

  // Resolve the "most recently used active token" id, if requested.
  let lastUsedKeepId: number | null = null;
  if (opts.keepLastUsed) {
    let best: TokenRow | null = null;
    for (const t of tokens) {
      if (!isActive(t) || t.lastUsedAt === null) continue;
      if (
        best === null ||
        t.lastUsedAt.getTime() > (best.lastUsedAt as Date).getTime() ||
        (t.lastUsedAt.getTime() === (best.lastUsedAt as Date).getTime() &&
          t.id > best.id)
      ) {
        best = t;
      }
    }
    lastUsedKeepId = best?.id ?? null;
  }

  const result: Partition = {
    revoke: [],
    keep: [],
    alreadyRevoked: [],
    skippedExpired: [],
  };

  for (const t of tokens) {
    if (t.revokedAt !== null) {
      result.alreadyRevoked.push(t);
      continue;
    }
    if (isExpired(t) && !opts.includeExpired) {
      result.skippedExpired.push(t);
      continue;
    }
    const kept =
      opts.keepIds.has(t.id) ||
      t.id === lastUsedKeepId ||
      opts.keepPrefixes.some((p) => prefixMatch(t.prefix, p));
    if (kept) result.keep.push(t);
    else result.revoke.push(t);
  }

  return result;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function die(msg: string): never {
  console.error(`[revoke-agent-tokens] ${msg}`);
  process.exit(1);
}

function parseFlags(argv: string[]): {
  slug: string;
  keep: string[];
  keepLastUsed: boolean;
  includeExpired: boolean;
  allActive: boolean;
  apply: boolean;
} {
  const out = {
    slug: 'kinetix-agent',
    keep: [] as string[],
    keepLastUsed: false,
    includeExpired: false,
    allActive: false,
    apply: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    switch (tok) {
      case '--keep-last-used':
        out.keepLastUsed = true;
        break;
      case '--include-expired':
        out.includeExpired = true;
        break;
      case '--all-active':
        out.allActive = true;
        break;
      case '--apply':
        out.apply = true;
        break;
      case '--slug':
      case '--keep': {
        const val = argv[++i];
        if (val === undefined || val.startsWith('--')) {
          die(`flag ${tok} requires a value`);
        }
        if (tok === '--slug') out.slug = val;
        else out.keep.push(...val.split(',').map((s) => s.trim()).filter(Boolean));
        break;
      }
      default:
        die(`unknown argument: ${tok}`);
    }
  }
  return out;
}

function fmt(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : '—';
}

function line(t: TokenRow): string {
  return `  id=${t.id} ${t.prefix}  last_used=${fmt(t.lastUsedAt)}  expires=${fmt(t.expiresAt)}  ${t.label ?? '(no label)'}`;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) die('DATABASE_URL is required');
  const flags = parseFlags(process.argv.slice(2));

  const hasKeep =
    flags.keep.length > 0 || flags.keepLastUsed || flags.allActive;
  if (!hasKeep) {
    die(
      'refusing to revoke without a keep rule — pass --keep <id|prefix> ' +
        '(e.g. your live token), --keep-last-used, or --all-active to confirm.',
    );
  }

  const db = getDb();
  const [agent] = await db
    .select({ id: agents.id, userId: agents.userId, slug: agents.slug })
    .from(agents)
    .where(eq(agents.slug, flags.slug))
    .limit(1);
  if (!agent) die(`no agents row with slug='${flags.slug}'`);

  const rows = await db
    .select({
      id: agentTokens.id,
      prefix: agentTokens.prefix,
      label: agentTokens.label,
      lastUsedAt: agentTokens.lastUsedAt,
      expiresAt: agentTokens.expiresAt,
      revokedAt: agentTokens.revokedAt,
    })
    .from(agentTokens)
    .where(eq(agentTokens.agentId, agent.id));

  const keepIds = new Set(
    flags.keep.filter((k) => /^\d+$/.test(k)).map((k) => Number(k)),
  );
  const keepPrefixes = flags.keep.filter((k) => !/^\d+$/.test(k));

  const part = partitionAgentTokens(rows, {
    now: new Date(),
    keepIds,
    keepPrefixes,
    keepLastUsed: flags.keepLastUsed,
    includeExpired: flags.includeExpired,
  });

  console.error(
    `\n[revoke-agent-tokens] agent='${agent.slug}' (id=${agent.id}) — ${rows.length} tokens total`,
  );
  console.error(
    `  keep=${part.keep.length}  revoke=${part.revoke.length}  ` +
      `already-revoked=${part.alreadyRevoked.length}  ` +
      `skipped-expired=${part.skippedExpired.length}`,
  );
  if (part.keep.length) {
    console.error('\nKEEP:');
    for (const t of part.keep) console.error(line(t));
  }
  if (part.revoke.length === 0) {
    console.error('\nNothing to revoke. Done.');
    return;
  }
  console.error(`\n${flags.apply ? 'REVOKING' : 'WOULD REVOKE'}:`);
  for (const t of part.revoke) console.error(line(t));

  if (!flags.apply) {
    console.error(
      `\n[dry-run] ${part.revoke.length} token(s) would be revoked. Re-run with --apply to do it.`,
    );
    return;
  }

  let done = 0;
  for (const t of part.revoke) {
    await revokeAgentToken({
      agentId: agent.id,
      tokenId: t.id,
      actorId: agent.userId,
    });
    done++;
  }
  console.error(`\n[revoke-agent-tokens] revoked ${done} token(s).`);
}

// Only run the CLI when invoked directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] !== undefined &&
  process.argv[1] === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error('[revoke-agent-tokens] error:', err);
    process.exit(1);
  });
}
