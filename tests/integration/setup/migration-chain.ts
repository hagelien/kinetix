/**
 * Replay of the committed migration chain, shared by both integration targets.
 *
 * This lived inside the PGlite harness until a second target needed it. The
 * two differ only in how a statement is executed — PGlite exposes `query`, a
 * `pg` pool exposes its own — so the chain itself is expressed once here
 * against a `RunStatement` callback and the drivers stay in their harnesses.
 *
 * Keeping it in one place is not tidiness: the replay encodes two rules that
 * production depends on (one statement per prepared send, `CONCURRENTLY`
 * stripped), and a second hand-written copy is a second place for those rules
 * to drift out of agreement with the deploy path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dropIndexConcurrently, skipTrivia } from '../../support/sql-lex.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '../../../drizzle');

/** Executes one SQL statement. Both harnesses supply their driver's version. */
export type RunStatement = (statement: string) => Promise<unknown>;

/** True when a chunk is nothing but whitespace and comments. */
function isTriviaOnly(sql: string): boolean {
  return skipTrivia(sql) >= sql.length;
}

/**
 * Replay the committed migration chain through `run`.
 *
 * drizzle's migrator can't run these files directly: five of them create
 * indexes `CONCURRENTLY`, which cannot run inside the per-migration transaction
 * the migrator wraps each file in. So we replay the journal ourselves — split
 * each file on drizzle's breakpoint marker and drop the `CONCURRENTLY` keyword
 * from index statements (on a fresh single-connection test DB a plain
 * `CREATE INDEX` is equivalent).
 *
 * Each chunk goes out as its own statement rather than as one script. A script
 * run through the simple protocol silently tolerates a migration whose
 * statements were never separated by the marker — exactly what broke the 0086
 * deploy. Production sends every chunk as a *prepared* statement (drizzle's
 * neon-http migrator over Neon's HTTP endpoint), which takes exactly one
 * command, so a missing marker has to fail here instead of at deploy time.
 * Comment-only chunks (the header a hand-written migration opens with) are
 * dropped first — a prepared statement needs an actual command.
 */
export async function replayMigrations(run: RunStatement): Promise<void> {
  const journalPath = path.join(MIGRATIONS_DIR, 'meta', '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  for (const entry of journal.entries) {
    const body = fs.readFileSync(
      path.join(MIGRATIONS_DIR, `${entry.tag}.sql`),
      'utf8',
    );
    const statements = body
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => !isTriviaOnly(s));
    for (const statement of statements) {
      await run(dropIndexConcurrently(statement));
    }
  }
}
