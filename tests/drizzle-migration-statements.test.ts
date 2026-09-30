/**
 * Guards the one property of a migration file that only production can check:
 * how many SQL commands live between two statement-breakpoint markers.
 *
 * The build-time runner (scripts/apply-migrations-build.ts) applies pending
 * migrations with drizzle-orm's neon-http migrator, which splits each file on
 * that marker and sends every chunk over Neon's HTTP endpoint as a *prepared*
 * statement. Postgres accepts exactly one command per prepared statement, so a
 * chunk holding two commands aborts the deploy with
 *
 *   NeonDbError: cannot insert multiple commands into a prepared statement
 *
 * `drizzle-kit generate` emits the markers itself, so only hand-written
 * migrations drift — and they drift silently, because the split is a plain
 * string split that knows nothing about SQL. This test is the fast gate (the
 * DB-integration harness replays the same files through PGlite's extended
 * protocol, which catches it too but needs a database).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DOLLAR_TAG,
  IDENT_CHAR,
  dropIndexConcurrently,
  matchKeywordRun,
  skipTrivia,
} from './support/sql-lex.js';
import {
  RETIRED_MIGRATION_HASHES,
  UNATTRIBUTED_LEGACY_ROWS,
  ambiguouslyAttributedRows,
  attributedMigrationWhens,
  migrationsBehindWatermark,
  misattributedRows,
  reconciliationWatermark,
  recordedWatermark,
  unrecognisedRows,
  unrecordedBorrowerSlots,
  unrecordedMigrations,
} from '../scripts/lib/migration-gaps.js';

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'drizzle');
const MARKER = '--> statement-breakpoint';
const DEPLOY_WORKFLOW = 'deploy-production.yml';
const GUARD_TEST = 'tests/drizzle-migration-statements.test.ts';
const MIGRATIONS_WORKFLOW = 'migrations.yml';
const RUNNER = path.resolve(
  __dirname,
  '..',
  'scripts',
  'apply-migrations-build.ts',
);

/**
 * Journal entries as they actually arrive: JSON, so every field is a claim
 * until checked. Typing `when` as a number here would make the guard below
 * look redundant to the reader and let a missing one through at runtime —
 * `undefined <= 123` is false, so a hand-edited entry with no timestamp would
 * pass an ordering check written against the declared type.
 */
type JournalEntry = Record<string, unknown>;

function readJournal(): JournalEntry[] {
  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
  ) as { entries?: unknown };
  return Array.isArray(journal.entries)
    ? (journal.entries as JournalEntry[])
    : [];
}

function tagOf(entry: JournalEntry): string {
  return typeof entry.tag === 'string' ? entry.tag : '(no tag)';
}

/** The runner's `main()`, where the order of the migration steps is decided. */
function readRunnerMain(): string {
  const runner = fs.readFileSync(RUNNER, 'utf8');
  return runner.slice(runner.indexOf('async function main()'));
}

type Marker = {
  offset: number;
  /**
   * Whether the marker sits between commands rather than partway through one.
   * `SELECT --> statement-breakpoint\n1;` is top level and still cuts a single
   * command into two fragments, each of which counts as one command and
   * neither of which Postgres can prepare.
   */
  atStatementBoundary: boolean;
};

type Scan = {
  /** Top-level commands, i.e. what a prepared statement would have to hold. */
  statements: number;
  /**
   * Every place the marker opens a comment at top level. An occurrence
   * anywhere else (inside a string, a dollar-quoted body, or partway through
   * a comment) is absent from this list, and still splits the file.
   */
  markers: Marker[];
};

// Identifier and dollar-tag rules live in tests/support/sql-lex.ts, shared
// with the integration harness — both need them, and each had grown its own
// half-right version of the same corner cases.

/**
 * Walk a SQL text, skipping comments, string literals, dollar-quoted bodies
 * (function definitions, DO blocks) and quoted identifiers, so that a `;` or a
 * marker inside any of them is not mistaken for the real thing.
 *
 * Known limit: a SQL-standard `BEGIN ATOMIC … END` function body (PG14+)
 * holds semicolons that belong to one `CREATE FUNCTION`, and this counts each
 * of them. No migration here defines a function — every one is DDL or DML —
 * and the failure would be a *rejected* valid migration with a legible
 * message, not a bad one waved through. Detecting the body needs a real
 * parser: `CASE … END`, `IF … END IF` and loops all nest inside it, so a
 * keyword heuristic would close it in the wrong place. If a migration ever
 * needs one, write it as a dollar-quoted body (which this does handle) or
 * lean on the integration harness, which prepares each chunk for real.
 */
function scanSql(sql: string): Scan {
  const markers: Marker[] = [];
  let statements = 0;
  let pendingText = false; // non-whitespace seen since the last `;`
  let i = 0;

  while (i < sql.length) {
    if (sql.startsWith('--', i)) {
      // The marker is itself a line comment, so it can only be a separator
      // where a comment may start — which is exactly "top level". Whether it
      // separates anything is a further question: `pendingText` means a
      // command is still open, so the cut would land inside it.
      if (sql.startsWith(MARKER, i))
        markers.push({ offset: i, atStatementBoundary: !pendingText });
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      // Postgres block comments nest, so the first `*/` need not close the
      // outer one. Bailing out at it would parse the rest of the comment as
      // SQL and reject a migration Postgres accepts.
      let depth = 0;
      do {
        if (sql.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else i++;
      } while (depth > 0 && i < sql.length);
      continue;
    }
    // A dollar quote opens only at a token boundary: `$` is legal inside an
    // unquoted identifier, so the `$tag$` in `foo$tag$` is part of the name,
    // not a quote — reading it as one would skip to EOF and hide every
    // command after it. Postgres allows non-ASCII letters in an unquoted
    // identifier (`é$tag$` is one token), so the neighbour test is Unicode
    // letters and digits, not `[A-Za-z0-9]`.
    DOLLAR_TAG.lastIndex = i;
    const dollarTag = IDENT_CHAR.test(sql[i - 1] ?? '')
      ? null
      : DOLLAR_TAG.exec(sql);
    if (dollarTag) {
      const tag = dollarTag[0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end === -1 ? sql.length : end + tag.length;
      pendingText = true;
      continue;
    }
    if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i];
      // Only a PostgreSQL escape string (E'…') honours backslash escapes;
      // in an ordinary literal a backslash is a plain character
      // (standard_conforming_strings, on by default). Getting this wrong
      // would run `E'foo\''` past its real closing quote and swallow every
      // following command. The `E` has to be the whole token: a typed literal
      // whose type name merely ends in one (`name'a\'`, `bytea'…'`) is an
      // ordinary string, so the character before it must not be identifier.
      const prefix = sql[i - 1];
      const backslashEscapes =
        quote === "'" &&
        (prefix === 'E' || prefix === 'e') &&
        !IDENT_CHAR.test(sql[i - 2] ?? '');
      i++;
      while (i < sql.length) {
        if (backslashEscapes && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2; // doubled quote escape
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      pendingText = true;
      continue;
    }
    if (sql[i] === ';') {
      if (pendingText) statements++;
      pendingText = false;
      i++;
      continue;
    }
    const ch = sql[i];
    if (ch !== undefined && !/\s/.test(ch)) pendingText = true;
    i++;
  }

  // A trailing command without its terminating semicolon still counts.
  if (pendingText) statements++;
  return { statements, markers };
}

function countStatements(sql: string): number {
  return scanSql(sql).statements;
}

/** Every offset at which the raw marker text occurs, separator or not. */
function rawMarkerOffsets(sql: string): number[] {
  const offsets: number[] = [];
  for (
    let at = sql.indexOf(MARKER);
    at !== -1;
    at = sql.indexOf(MARKER, at + 1)
  )
    offsets.push(at);
  return offsets;
}

function lineOf(sql: string, offset: number): number {
  return sql.slice(0, offset).split('\n').length;
}

/** Tags the runner applies whole-file via `sql.query(body)`, outside migrate(). */
function readNonTransactionalTags(): string[] {
  const source = fs.readFileSync(RUNNER, 'utf8');
  const start = source.indexOf('const NON_TRANSACTIONAL_MIGRATIONS');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n];', start);
  expect(end).toBeGreaterThan(start);
  return Array.from(
    source.slice(start, end).matchAll(/tag: '([^']+)'/g),
    (m) => m[1]!, // the group is mandatory in the pattern
  );
}

function readMigration(tag: string): string {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, `${tag}.sql`), 'utf8');
}

describe('drizzle migrations', () => {
  const entries = readJournal();
  const tags = entries.map(tagOf);

  it('every journal entry has a tag and a finite timestamp', () => {
    // Checked before the ordering test rather than folded into it: a missing
    // `when` makes every comparison against it false, so an absent timestamp
    // would slip through an ordering check silently. In production it is worse
    // than out of order — migrate() compares against `undefined`, which is
    // never greater, so the migration is skipped on every deploy forever.
    expect(entries.length).toBeGreaterThan(0);
    const malformed = entries
      .filter(
        (e) =>
          typeof e.tag !== 'string' ||
          e.tag.length === 0 ||
          typeof e.when !== 'number' ||
          !Number.isFinite(e.when),
      )
      .map((e) => `${tagOf(e)} (when=${JSON.stringify(e.when)})`);
    expect(
      malformed,
      'journal entr(ies) missing a tag or a finite `when`; migrate() gates ' +
        'on that number and skips what it cannot compare',
    ).toEqual([]);
  });

  it('journal timestamps increase strictly', () => {
    // migrate() compares each entry's `when` against the newest recorded
    // created_at (`Number(lastDbMigration.created_at) < migration.folderMillis`)
    // rather than tracking which tags ran. An entry whose `when` is not past
    // its predecessor's is therefore behind the high-water mark the moment the
    // one before it records, and is skipped in silence — the deploy goes
    // green, the schema change never lands, and the code that needs it ships.
    const outOfOrder = entries.filter(
      (entry, i) => i > 0 && Number(entry.when) <= Number(entries[i - 1]!.when),
    );
    expect(
      outOfOrder.map((e) => `${tagOf(e)} (when=${JSON.stringify(e.when)})`),
      'journal entr(ies) not newer than the one before them; migrate() ' +
        'would skip them without an error',
    ).toEqual([]);
  });

  it('no journal tag appears twice', () => {
    // migrate() gates regular migrations by `when`, not by hash or by tag, so
    // a tag repeated with a later timestamp is applied a second time. DDL
    // written with IF NOT EXISTS survives that; a data migration does not, and
    // the replay has no reason to notice either.
    const seen = new Set<string>();
    const duplicates = tags.filter((tag) => {
      const repeat = seen.has(tag);
      seen.add(tag);
      return repeat;
    });
    expect(
      duplicates,
      'journal tag(s) listed more than once; migrate() would apply the ' +
        'migration again',
    ).toEqual([]);
  });

  it('journal and drizzle/*.sql are the same set', () => {
    // The journal is the only thing the migrator reads: a `.sql` file with no
    // entry is never applied, silently, while the code that needs its schema
    // change deploys anyway. A tag with no file is the reverse — the migrator
    // throws mid-deploy. Neither is visible without comparing both ways.
    expect(tags.length).toBeGreaterThan(0);
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => name.slice(0, -'.sql'.length));
    expect(
      files.filter((f) => !tags.includes(f)),
      'migration file(s) with no drizzle/meta/_journal.json entry — the ' +
        'migrator would never apply them',
    ).toEqual([]);
    expect(
      tags.filter((t) => !files.includes(t)),
      'journal entr(ies) with no migration file — the migrator throws on ' +
        'the missing file',
    ).toEqual([]);
  });

  it.each(tags)(
    '%s has at most one command per statement-breakpoint chunk',
    (tag) => {
      const body = readMigration(tag);
      const chunks = body.split(MARKER);
      chunks.forEach((chunk, index) => {
        expect(
          countStatements(chunk),
          `drizzle/${tag}.sql chunk ${index + 1}/${chunks.length} holds more ` +
            'than one SQL command. Neon sends each chunk as a prepared ' +
            'statement, which takes exactly one — separate them with a ' +
            'statement-breakpoint marker.',
        ).toBeLessThanOrEqual(1);
      });
    },
  );

  it.each(tags)('%s only carries the marker as a separator', (tag) => {
    // The split is a plain string search: drizzle (and the integration
    // harness) cut the file at *every* occurrence of the marker text,
    // including one buried in a comment, a string literal or a dollar-quoted
    // body. Both sides of such a cut are then fed to Postgres as SQL. So each
    // occurrence must sit at top level AND end its line — drizzle-kit writes
    // the marker either alone or appended to the terminating `;`, and anything
    // after it becomes the head of the next chunk.
    const body = readMigration(tag);
    const markers = new Map(
      scanSql(body).markers.map((m) => [m.offset, m.atStatementBoundary]),
    );
    for (const offset of rawMarkerOffsets(body)) {
      expect(
        markers.has(offset),
        `drizzle/${tag}.sql:${lineOf(body, offset)} carries the ` +
          'statement-breakpoint marker inside a comment, string or ' +
          'dollar-quoted body; the file is still split there, so the marker ' +
          'text must never appear except as a separator',
      ).toBe(true);
      expect(
        markers.get(offset),
        `drizzle/${tag}.sql:${lineOf(body, offset)} puts the ` +
          'statement-breakpoint marker inside an unfinished command; the cut ' +
          'lands mid-statement and Neon gets two fragments it cannot prepare',
      ).toBe(true);
      const lineEnd = body.indexOf('\n', offset);
      const tail = body.slice(offset, lineEnd === -1 ? body.length : lineEnd);
      expect(
        tail.trimEnd(),
        `drizzle/${tag}.sql:${lineOf(body, offset)} has text after the ` +
          'statement-breakpoint marker; nothing may follow it on its line',
      ).toBe(MARKER);
    }
  });

  it('the deploy still runs the migration runner', () => {
    // Everything else here checks the runner. Nothing checked that the deploy
    // still calls it: vercel.json's buildCommand is the only thing that does,
    // and a rename or a typo there would strand this whole gate — green CI
    // over a build that quietly stopped migrating (or, worse, one that
    // migrates via some other command nobody is guarding).
    const vercel = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', 'vercel.json'), 'utf8'),
    ) as { buildCommand?: string };
    expect(
      vercel.buildCommand ?? '',
      'vercel.json buildCommand no longer invokes ' +
        'scripts/apply-migrations-build.ts — either the deploy stopped ' +
        'applying migrations, or it applies them by a path this gate does ' +
        'not cover',
    ).toContain('scripts/apply-migrations-build.ts');
  });

  it('the production deploy runs the guard before it builds', () => {
    // The guard's value is entirely in its position: `vercel build` applies
    // migrations to the live database, so a step moved below it — or deleted —
    // still leaves a green workflow and an unguarded deploy. Assert the order
    // rather than the presence.
    const workflow = fs.readFileSync(
      path.resolve(__dirname, '..', '.github', 'workflows', DEPLOY_WORKFLOW),
      'utf8',
    );
    // Compare the `run:` commands, not the file text: both strings also occur
    // in the comments explaining them, and a comment does not move when the
    // step it describes does.
    const commands = Array.from(
      workflow.matchAll(/^\s*run:\s*(.+)$/gm),
      (m) => m[1] ?? '',
    );
    const guard = commands.findIndex((c) => c.includes(GUARD_TEST));
    const build = commands.findIndex((c) => c.includes('vercel build'));
    expect(
      guard,
      `${DEPLOY_WORKFLOW} no longer runs ${GUARD_TEST}`,
    ).toBeGreaterThan(-1);
    expect(
      build,
      `${DEPLOY_WORKFLOW} no longer runs vercel build`,
    ).toBeGreaterThan(-1);
    expect(
      guard < build,
      `${DEPLOY_WORKFLOW} runs the migration guard after \`vercel build\`, ` +
        'which has already applied the migrations to production',
    ).toBe(true);
  });

  it('non-transactional migrations hold exactly one command in total', () => {
    const nonTransactional = readNonTransactionalTags();
    expect(nonTransactional.length).toBeGreaterThan(0);
    for (const tag of nonTransactional) {
      const file = path.join(MIGRATIONS_DIR, `${tag}.sql`);
      expect(fs.existsSync(file), `drizzle/${tag}.sql is missing`).toBe(true);
      // These bypass migrate() and are sent whole by `sql.query(body)`, so the
      // marker does not split them — the file itself must be one command
      // (CREATE INDEX CONCURRENTLY, which cannot run in a transaction).
      expect(
        countStatements(fs.readFileSync(file, 'utf8')),
        `drizzle/${tag}.sql is applied whole, outside migrate(), so it must ` +
          'contain exactly one SQL command',
      ).toBe(1);
    }
  });
});

describe('sql-lex', () => {
  it('skips whitespace and comments, nesting block comments', () => {
    expect(skipTrivia('  SELECT')).toBe(2);
    expect(skipTrivia('-- a\nSELECT')).toBe(5);
    expect(skipTrivia('/* a */ SELECT')).toBe(8);
    expect(skipTrivia('/* a /* b */ c */ SELECT')).toBe(18);
    expect(skipTrivia('   ')).toBe(3);
  });

  it('matches keywords as whole tokens', () => {
    expect(matchKeywordRun('CREATE INDEX', ['create', 'index'])).toEqual({
      start: 7,
      end: 12,
    });
    expect(
      matchKeywordRun('CREATE /* x */ INDEX', ['create', 'index']),
    ).not.toBeNull();
    // `$` continues an identifier in Postgres, so this is not the keyword.
    expect(matchKeywordRun('CREATE INDEXES', ['create', 'index'])).toBeNull();
    expect(matchKeywordRun('CREATE INDEX$X', ['create', 'index'])).toBeNull();
  });

  it('drops CONCURRENTLY only from the statement it heads', () => {
    const strip = dropIndexConcurrently;
    // Only the keyword's own span goes; the whitespace around it stays, so
    // every other byte — comments included — reaches PGlite as written.
    expect(strip('CREATE INDEX CONCURRENTLY "i" ON t (a);')).toBe(
      'CREATE INDEX  "i" ON t (a);',
    );
    expect(strip('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "i";')).toBe(
      'CREATE UNIQUE INDEX  IF NOT EXISTS "i";',
    );
    expect(strip('DROP INDEX CONCURRENTLY IF EXISTS "i";')).toBe(
      'DROP INDEX  IF EXISTS "i";',
    );
    expect(strip('-- lead\nCREATE INDEX CONCURRENTLY "i";')).toBe(
      '-- lead\nCREATE INDEX  "i";',
    );
    // Comments sit wherever whitespace does, including nested ones.
    expect(strip('CREATE /* a /* b */ c */ INDEX CONCURRENTLY "i";')).toBe(
      'CREATE /* a /* b */ c */ INDEX  "i";',
    );
    // An index *named* concurrently$… is an identifier, not the keyword.
    expect(strip('CREATE INDEX concurrently$archive ON t (id);')).toBe(
      'CREATE INDEX concurrently$archive ON t (id);',
    );
    // Never inside string data or a quoted identifier.
    expect(
      strip(
        "CREATE TABLE t (cmd text CHECK (cmd <> 'CREATE INDEX CONCURRENTLY'));",
      ),
    ).toBe(
      "CREATE TABLE t (cmd text CHECK (cmd <> 'CREATE INDEX CONCURRENTLY'));",
    );
    expect(strip('CREATE TABLE t ("concurrently" int);')).toBe(
      'CREATE TABLE t ("concurrently" int);',
    );
  });
});

describe('scanSql', () => {
  it('ignores semicolons inside comments, strings and dollar quotes', () => {
    expect(countStatements('-- a; b\nSELECT 1;')).toBe(1);
    expect(countStatements('/* a; b */ SELECT 1;')).toBe(1);
    expect(countStatements("SELECT ';';")).toBe(1);
    expect(countStatements("SELECT 'it''s; fine';")).toBe(1);
    expect(countStatements('SELECT $$a; b$$;')).toBe(1);
    expect(countStatements('SELECT $tag$a; b$tag$;')).toBe(1);
    expect(countStatements('CREATE INDEX ON t ("a;b");')).toBe(1);
  });

  it('closes an escape string at its backslash-escaped quote', () => {
    // E'foo\'' ends with an escaped apostrophe followed by the real closing
    // quote — read as a doubled-quote escape, the scan would stay inside the
    // string and miss every following command.
    expect(countStatements("SELECT E'foo\\''; SELECT 2;")).toBe(2);
    expect(countStatements("SELECT E'a\\\\'; SELECT 2;")).toBe(2);
    expect(countStatements("SELECT E'a;b'; SELECT 2;")).toBe(2);
    // A backslash in an ordinary literal is just a character, so the quote
    // right after it still closes the string.
    expect(countStatements("SELECT 'a\\'; SELECT 2;")).toBe(2);
    // A typed literal whose type name ends in `e` is an ordinary string, not
    // an escape string — the `E` prefix has to be a token of its own.
    expect(countStatements("SELECT name'a\\'; SELECT 2;")).toBe(2);
    expect(countStatements("SELECT bytea'a\\'; SELECT 2;")).toBe(2);
    // …while a real prefix still escapes, upper or lower case.
    expect(countStatements("SELECT e'foo\\''; SELECT 2;")).toBe(2);
    expect(countStatements("SELECT (E'a;b'); SELECT 2;")).toBe(2);
  });

  it('tracks nested block comments to their real close', () => {
    // Postgres nests `/* */`, so the inner close does not end the comment.
    // Stopping at the inner close would read `SELECT 9;` out of the comment
    // and reject a migration Postgres accepts.
    expect(countStatements('/* a /* b */ SELECT 9; c */ SELECT 1;')).toBe(1);
    expect(countStatements('/* /* */ */ SELECT 1; SELECT 2;')).toBe(2);
    expect(countStatements('/* unterminated ; SELECT 1;')).toBe(0);
  });

  it('opens a dollar quote only at a token boundary', () => {
    // `$` is legal inside an unquoted identifier, so `foo$tag$` is one name.
    expect(
      countStatements(
        'CREATE TABLE t (foo$tag$ int); CREATE TABLE u (id int);',
      ),
    ).toBe(2);
    expect(countStatements('SELECT a$b$ ; SELECT 2;')).toBe(2);
    // Postgres allows non-ASCII letters in an unquoted identifier.
    expect(
      countStatements('CREATE TABLE t (é$tag$ int); CREATE TABLE u (id int);'),
    ).toBe(2);
    // …including a decomposed one, where the character before the tag is a
    // combining mark rather than a letter.
    expect(
      countStatements('CREATE TABLE t (é$tag$ int); CREATE TABLE u (id int);'),
    ).toBe(2);
    // Postgres continues an identifier on any byte above 0x7F, not only on
    // letters and marks.
    expect(
      countStatements(
        'CREATE TABLE t (a\u263A$tag$ int); CREATE TABLE u (i int);',
      ),
    ).toBe(2);
    // …but a real dollar quote still swallows its body.
    expect(countStatements('SELECT $tag$x; y$tag$;')).toBe(1);
    expect(countStatements('SELECT ($$x; y$$);')).toBe(1);
    // A dollar tag follows identifier rules, so it too may be non-ASCII.
    expect(countStatements('SELECT $é$x; y$é$;')).toBe(1);
  });

  it('counts real command separators, terminated or not', () => {
    expect(countStatements('SELECT 1; SELECT 2;')).toBe(2);
    expect(countStatements('SELECT 1;\n\nSELECT 2')).toBe(2);
    expect(countStatements('SELECT 1;;;')).toBe(1);
    expect(countStatements('  -- only a comment\n')).toBe(0);
    expect(countStatements('')).toBe(0);
  });

  it('reports a marker only where it is a real separator', () => {
    const boundaries = (sql: string) =>
      scanSql(sql).markers.filter((m) => m.atStatementBoundary).length;

    expect(boundaries(`SELECT 1;\n${MARKER}\nSELECT 2;`)).toBe(1);
    expect(boundaries(`SELECT 1;${MARKER}\nSELECT 2;`)).toBe(1);
    expect(boundaries(`-- a comment\n${MARKER}\nSELECT 1;`)).toBe(1);
    // Mentioned in prose or quoted: drizzle still splits here, so it must not
    // be reported at all.
    expect(scanSql(`-- see ${MARKER} above\nSELECT 1;`).markers).toEqual([]);
    expect(scanSql(`SELECT '${MARKER}';`).markers).toEqual([]);
    expect(scanSql(`SELECT $$\n${MARKER}\n$$;`).markers).toEqual([]);
    expect(scanSql(`/*\n${MARKER}\n*/ SELECT 1;`).markers).toEqual([]);
  });

  it('marks a mid-statement separator as not at a boundary', () => {
    // Top level, but it cuts one command in half: each fragment then counts
    // as a single command and slips past the per-chunk check.
    const scan = scanSql(`SELECT ${MARKER}\n1;`);
    expect(scan.markers).toHaveLength(1);
    expect(scan.markers[0]?.atStatementBoundary).toBe(false);
    expect(
      scanSql(`SELECT 1;\n${MARKER}\n`).markers[0]?.atStatementBoundary,
    ).toBe(true);
  });
});

/**
 * The other half of the ordering guard above.
 *
 * "Journal timestamps increase strictly" stops this repository from AUTHORING
 * an entry behind the high-water mark. It cannot stop a migration authored in
 * order from being left behind by some other writer — a runner pointed at the
 * production database from a tree that was missing it, which records something
 * newer and buries it for good. That is how 0125 went missing, and the only
 * symptom was a green deploy that took a second to say "Done."
 */
describe('migrations behind the high-water mark', () => {
  const excludeNothing = new Set<string>();

  it('an entry never recorded and older than the mark is reported', () => {
    const entries = [
      { tag: '0124_a', when: 100 },
      { tag: '0125_lost', when: 200 },
      { tag: '0126_b', when: 300 },
    ];
    const recorded = new Set([100, 300]);
    expect(recordedWatermark(recorded)).toBe(300);
    expect(
      migrationsBehindWatermark(entries, recorded, excludeNothing).map(
        (e) => e.tag,
      ),
    ).toEqual(['0125_lost']);
  });

  it('a pending tail is left to migrate(), not applied twice', () => {
    // Anything at or past the mark is an ordinary pending migration. Sending
    // it from here as well would run it once by hand and once through the
    // migrator — which DDL without IF NOT EXISTS, and every data migration,
    // would not survive.
    const entries = [
      { tag: '0124_a', when: 100 },
      { tag: '0125_new', when: 200 },
    ];
    expect(
      migrationsBehindWatermark(entries, new Set([100]), excludeNothing),
    ).toEqual([]);
  });

  it('a fresh database reports nothing', () => {
    // Nothing recorded means no mark, so nothing is behind one: migrate()
    // applies the entire chain itself.
    const entries = [{ tag: '0000_a', when: 100 }];
    expect(recordedWatermark(new Set())).toBeNull();
    expect(
      migrationsBehindWatermark(entries, new Set(), excludeNothing),
    ).toEqual([]);
  });

  it('non-transactional tags are left to their own canary-probed path', () => {
    const entries = [
      { tag: '0041_concurrent', when: 100 },
      { tag: '0042_b', when: 300 },
    ];
    expect(
      migrationsBehindWatermark(
        entries,
        new Set([300]),
        new Set(['0041_concurrent']),
      ),
    ).toEqual([]);
  });

  it('gaps come back in journal order', () => {
    const entries = [
      { tag: '0100_one', when: 100 },
      { tag: '0101_two', when: 200 },
      { tag: '0102_three', when: 300 },
    ];
    expect(
      migrationsBehindWatermark(entries, new Set([400]), excludeNothing).map(
        (e) => e.tag,
      ),
    ).toEqual(['0100_one', '0101_two', '0102_three']);
  });

  it('the post-condition names every unrecorded entry', () => {
    const entries = [
      { tag: '0100_one', when: 100 },
      { tag: '0101_two', when: 200 },
    ];
    expect(
      unrecordedMigrations(entries, new Set([100])).map((e) => e.tag),
    ).toEqual(['0101_two']);
    expect(unrecordedMigrations(entries, new Set([100, 200]))).toEqual([]);
  });

  it('a slot borrowed by another body is not counted as applied', () => {
    // Two branches both appended "the next migration" at when=200. The other
    // branch's body ran from its own tree under 200, then merged renumbered to
    // 300 and ran again there. 200's own body never ran.
    const entries = [
      { tag: '0124_a', when: 100, hash: 'hA' },
      { tag: '0125_kept', when: 200, hash: 'hKept' },
      { tag: '0126_renumbered', when: 300, hash: 'hRenumbered' },
    ];
    const rows = [
      { createdAt: 100, hash: 'hA' },
      { createdAt: 200, hash: 'hRenumbered' },
      { createdAt: 300, hash: 'hRenumbered' },
    ];
    const attributed = attributedMigrationWhens(entries, rows);
    expect([...attributed].sort()).toEqual([100, 300]);
    expect(
      migrationsBehindWatermark(entries, attributed, excludeNothing).map(
        (e) => e.tag,
      ),
    ).toEqual(['0125_kept']);
    expect(unrecordedMigrations(entries, attributed).map((e) => e.tag)).toEqual(
      ['0125_kept'],
    );
    expect(
      misattributedRows(entries, rows).map((m) => [m.slot.tag, m.body.tag]),
    ).toEqual([['0125_kept', '0126_renumbered']]);
  });

  it('a borrowed slot at the very top of the mark is still repaired', () => {
    // The renumbered body has not been deployed under its own slot yet, so the
    // borrowed row IS the mark. migrate() runs only what is strictly newer, so
    // the slot's owner is the runner's to apply or nobody's.
    const entries = [
      { tag: '0124_a', when: 100, hash: 'hA' },
      { tag: '0125_kept', when: 200, hash: 'hKept' },
      { tag: '0126_renumbered', when: 300, hash: 'hRenumbered' },
    ];
    const rows = [
      { createdAt: 100, hash: 'hA' },
      { createdAt: 200, hash: 'hRenumbered' },
    ];
    expect(
      migrationsBehindWatermark(
        entries,
        attributedMigrationWhens(entries, rows),
        excludeNothing,
        reconciliationWatermark(entries, rows),
      ).map((e) => e.tag),
    ).toEqual(['0125_kept']);
    // ...and the borrower is then recorded under its own slot, so the raw mark
    // migrate() reads is past it and its body does not run a second time.
    expect(unrecordedBorrowerSlots(entries, rows).map((e) => e.tag)).toEqual([
      '0126_renumbered',
    ]);
  });

  it('entries between a borrowed slot and its body are repaired too', () => {
    // Recording the borrower at 300 moves the raw mark past 250, which
    // migrate() would otherwise have applied. So 250 is applied by hand first.
    const entries = [
      { tag: '0124_a', when: 100, hash: 'hA' },
      { tag: '0125_kept', when: 200, hash: 'hKept' },
      { tag: '0126_between', when: 250, hash: 'hBetween' },
      { tag: '0127_renumbered', when: 300, hash: 'hRenumbered' },
      { tag: '0128_tail', when: 400, hash: 'hTail' },
    ];
    const rows = [
      { createdAt: 100, hash: 'hA' },
      { createdAt: 200, hash: 'hRenumbered' },
    ];
    expect(reconciliationWatermark(entries, rows)).toBe(300);
    expect(
      migrationsBehindWatermark(
        entries,
        attributedMigrationWhens(entries, rows),
        excludeNothing,
        reconciliationWatermark(entries, rows),
      ).map((e) => e.tag),
    ).toEqual(['0125_kept', '0126_between']);
    expect(unrecordedBorrowerSlots(entries, rows).map((e) => e.tag)).toEqual([
      '0127_renumbered',
    ]);
  });

  it('a borrower already recorded under its own slot is not recorded again', () => {
    const entries = [
      { tag: '0125_kept', when: 200, hash: 'hKept' },
      { tag: '0126_renumbered', when: 300, hash: 'hRenumbered' },
    ];
    const rows = [
      { createdAt: 200, hash: 'hRenumbered' },
      { createdAt: 300, hash: 'hRenumbered' },
    ];
    expect(unrecordedBorrowerSlots(entries, rows)).toEqual([]);
    expect(reconciliationWatermark(entries, rows)).toBe(300);
  });

  it('an edited applied file still counts by its timestamp', () => {
    // AGENTS.md allows a semantically-neutral edit to an applied migration,
    // with the old hash retired. The recorded row then carries that retired
    // hash, and it must not be read as unapplied and run a second time.
    const entries = [
      {
        tag: '0124_a',
        when: 100,
        hash: 'hA-edited',
        retiredHashes: ['hA-original'],
      },
      { tag: '0125_b', when: 200, hash: 'hB' },
    ];
    const rows = [
      { createdAt: 100, hash: 'hA-original' },
      { createdAt: 200, hash: 'hB' },
    ];
    const attributed = attributedMigrationWhens(entries, rows);
    expect(unrecordedMigrations(entries, attributed)).toEqual([]);
    expect(misattributedRows(entries, rows)).toEqual([]);
    expect(unrecognisedRows(entries, rows)).toEqual([]);
  });

  it('a hash no body ever had, in a committed slot, is refused', () => {
    // Without the retired hash the row could be 0124 edited, or a borrower
    // edited after it ran from its branch. Those need opposite repairs, so the
    // runner names the row instead of guessing.
    const entries = [
      { tag: '0124_a', when: 100, hash: 'hA-edited' },
      { tag: '0125_b', when: 200, hash: 'hB' },
    ];
    const rows = [
      { createdAt: 100, hash: 'hA-original' },
      { createdAt: 200, hash: 'hB' },
    ];
    expect(
      unrecognisedRows(entries, rows, []).map(({ row, slot }) => [
        row.createdAt,
        slot?.tag,
      ]),
    ).toEqual([[100, '0124_a']]);
  });

  it('a hash no body ever had, outside every slot, is refused too', () => {
    // A migration that ran from its branch, was renumbered to a new `when`,
    // then edited without retiring its old hash: the row sits at an abandoned
    // timestamp, nothing credits it, and 0125 would run a second time.
    const entries = [
      { tag: '0124_a', when: 100, hash: 'hA' },
      { tag: '0125_moved', when: 300, hash: 'hMoved-edited' },
    ];
    const rows = [
      { createdAt: 100, hash: 'hA' },
      { createdAt: 200, hash: 'hMoved-original' },
    ];
    expect(
      unrecognisedRows(entries, rows, []).map(({ row, slot }) => [
        row.createdAt,
        slot,
      ]),
    ).toEqual([[200, null]]);
    // Only a row checked by hand and listed as no migration's is let through.
    expect(
      unrecognisedRows(entries, rows, [
        { createdAt: 200, hash: 'hMoved-original' },
      ]),
    ).toEqual([]);
    // Listing is by timestamp AND hash: the same hash elsewhere is refused.
    expect(
      unrecognisedRows(entries, rows, [
        { createdAt: 250, hash: 'hMoved-original' },
      ]).map(({ row }) => row.createdAt),
    ).toEqual([200]);
  });

  it('every listed legacy row claims no slot and no body', () => {
    // A legacy row inside a slot, or carrying a real body, would hide exactly
    // the rows the refusal exists to stop.
    const journal = readJournal();
    const whens = new Set(journal.map((e) => Number(e.when)));
    const hashes = new Set(
      journal.map((e) =>
        crypto
          .createHash('sha256')
          .update(
            fs.readFileSync(
              path.join(MIGRATIONS_DIR, `${String(e.tag)}.sql`),
              'utf8',
            ),
          )
          .digest('hex'),
      ),
    );
    const retired = new Set(Object.values(RETIRED_MIGRATION_HASHES).flat());
    for (const row of UNATTRIBUTED_LEGACY_ROWS) {
      expect(whens.has(row.createdAt), `${row.createdAt} is a journal slot`).toBe(
        false,
      );
      expect(
        hashes.has(row.hash) || retired.has(row.hash),
        `${row.createdAt} carries a migration body`,
      ).toBe(false);
    }
  });

  it('a borrower edited after it ran from its branch is recognised', () => {
    // 0126 ran as 0125 from its branch under hB-old, then was edited (hB-old
    // retired) and merged renumbered. Crediting the row to 0125's timestamp
    // would leave 0125 unapplied and let migrate() run 0126 again.
    const entries = [
      { tag: '0124_a', when: 100, hash: 'hA' },
      { tag: '0125_kept', when: 200, hash: 'hKept' },
      {
        tag: '0126_renumbered',
        when: 300,
        hash: 'hB-new',
        retiredHashes: ['hB-old'],
      },
    ];
    const rows = [
      { createdAt: 100, hash: 'hA' },
      { createdAt: 200, hash: 'hB-old' },
    ];
    expect(unrecognisedRows(entries, rows)).toEqual([]);
    expect([...attributedMigrationWhens(entries, rows)].sort()).toEqual([
      100, 300,
    ]);
    expect(
      migrationsBehindWatermark(
        entries,
        attributedMigrationWhens(entries, rows),
        excludeNothing,
        reconciliationWatermark(entries, rows),
      ).map((e) => e.tag),
    ).toEqual(['0125_kept']);
    expect(unrecordedBorrowerSlots(entries, rows).map((e) => e.tag)).toEqual([
      '0126_renumbered',
    ]);
    expect(
      misattributedRows(entries, rows).map((m) => [m.slot.tag, m.body.tag]),
    ).toEqual([['0125_kept', '0126_renumbered']]);
    // Without the retired hash the same row is refused, not trusted.
    const unretired = entries.map(({ retiredHashes: _r, ...e }) => e);
    expect(unrecognisedRows(unretired, rows).map((u) => u.slot?.tag)).toEqual([
      '0125_kept',
    ]);
  });

  it('every retired hash is a distinct earlier body of a committed entry', () => {
    // A retired hash equal to a current body, or listed under two tags, would
    // credit a row to the wrong entry; a tag not in the journal credits none.
    const journalTags = new Set(readJournal().map((e) => String(e.tag)));
    const currentHashes = new Set(
      readJournal().map((e) =>
        crypto
          .createHash('sha256')
          .update(
            fs.readFileSync(
              path.join(MIGRATIONS_DIR, `${String(e.tag)}.sql`),
              'utf8',
            ),
          )
          .digest('hex'),
      ),
    );
    const seen = new Set<string>();
    for (const [tag, hashes] of Object.entries(RETIRED_MIGRATION_HASHES)) {
      expect(journalTags.has(tag), `${tag} is not a journal entry`).toBe(true);
      for (const hash of hashes) {
        expect(hash, `${tag} retires a malformed hash`).toMatch(
          /^[0-9a-f]{64}$/,
        );
        expect(
          currentHashes.has(hash),
          `${tag} retires a hash that is a committed body`,
        ).toBe(false);
        expect(seen.has(hash), `${hash} is retired twice`).toBe(false);
        seen.add(hash);
      }
    }
  });

  it('identical bodies are trusted only for their own slots', () => {
    const entries = [
      { tag: '0100_x', when: 100, hash: 'same' },
      { tag: '0101_y', when: 200, hash: 'same' },
      { tag: '0102_z', when: 300, hash: 'hZ' },
    ];
    expect([
      ...attributedMigrationWhens(entries, [
        { createdAt: 100, hash: 'same' },
        { createdAt: 300, hash: 'same' },
      ]),
    ]).toEqual([100]);
  });

  it('a row identical bodies share, outside all their slots, is refused', () => {
    // The row proves x or y ran but not which, so it credits neither. Left
    // alone, the gap repair would replay both — duplicating whichever one
    // actually ran. The runner must stop before it applies anything.
    const entries = [
      { tag: '0100_x', when: 100, hash: 'same' },
      { tag: '0101_y', when: 200, hash: 'same' },
      { tag: '0102_z', when: 300, hash: 'hZ' },
    ];
    const rows = [
      { createdAt: 300, hash: 'same' },
      { createdAt: 400, hash: 'hZ' },
    ];
    expect(
      ambiguouslyAttributedRows(entries, rows).map(({ row, candidates }) => [
        row.createdAt,
        candidates.map((c) => c.tag),
      ]),
    ).toEqual([[300, ['0100_x', '0101_y']]]);
    // Each identical body in its own slot is unambiguous and not refused.
    expect(
      ambiguouslyAttributedRows(entries, [
        { createdAt: 100, hash: 'same' },
        { createdAt: 200, hash: 'same' },
      ]),
    ).toEqual([]);
  });

  it('the runner refuses unplaceable rows before applying anything', () => {
    // Order, not presence: a refusal after the first back-fill has already
    // replayed the body it could not attribute.
    const runner = fs.readFileSync(RUNNER, 'utf8');
    const repair = runner.slice(
      runner.indexOf('async function applyMigrationsBehindWatermark()'),
    );
    const firstApply = repair.indexOf('sql.query(');
    const firstRecord = repair.indexOf('recordMigration(');
    for (const check of ['unrecognisedRows(', 'ambiguouslyAttributedRows(']) {
      const refusal = repair.indexOf(check);
      expect(refusal, `the gap repair no longer calls ${check}`).toBeGreaterThan(
        -1,
      );
      expect(
        refusal < firstApply && refusal < firstRecord,
        `the gap repair applies or records a migration before ${check}`,
      ).toBe(true);
    }
    expect(
      runner,
      'the runner no longer hands the retired hashes to the gap decision',
    ).toContain('RETIRED_MIGRATION_HASHES[entry.tag]');
  });

  it('a borrower whose own slot holds a third body is still recorded', () => {
    // A chain: B's body sits in A's slot, C's body in B's. B's slot is
    // occupied, but not by B. Without its own row B is credited only through
    // A's slot, and a neutral edit to B's file later turns that row into an
    // unknown hash credited to A — leaving B missing, and replayed.
    const entries = [
      { tag: '0100_a', when: 100, hash: 'hA' },
      { tag: '0101_b', when: 200, hash: 'hB' },
      { tag: '0102_c', when: 300, hash: 'hC' },
    ];
    const rows = [
      { createdAt: 100, hash: 'hB' },
      { createdAt: 200, hash: 'hC' },
      { createdAt: 300, hash: 'hC' },
    ];
    expect(unrecordedBorrowerSlots(entries, rows).map((e) => e.tag)).toEqual([
      '0101_b',
    ]);
    expect(
      migrationsBehindWatermark(
        entries,
        attributedMigrationWhens(entries, rows),
        excludeNothing,
        reconciliationWatermark(entries, rows),
      ).map((e) => e.tag),
    ).toEqual(['0100_a']);

    // After the runner's repair — A back-filled, B recorded under its own
    // slot — the neutral edit to B no longer makes anything look missing.
    const repaired = [
      ...rows,
      { createdAt: 100, hash: 'hA' },
      { createdAt: 200, hash: 'hB' },
    ];
    const edited = entries.map((e) =>
      e.tag === '0101_b' ? { ...e, hash: 'hB-edited' } : e,
    );
    expect(
      unrecordedMigrations(edited, attributedMigrationWhens(edited, repaired)),
    ).toEqual([]);
  });

  it('a borrower whose own slot holds its edited body is not recorded again', () => {
    // The row at B's slot matches no committed body: B ran there, and its file
    // was neutrally edited since. That row already vouches for B.
    const entries = [
      { tag: '0100_a', when: 100, hash: 'hA' },
      { tag: '0101_b', when: 200, hash: 'hB-edited' },
    ];
    const rows = [
      { createdAt: 100, hash: 'hA' },
      { createdAt: 150, hash: 'hB-edited' },
      { createdAt: 200, hash: 'hB-original' },
    ];
    expect(unrecordedBorrowerSlots(entries, rows)).toEqual([]);
  });

  it('the production state that lost 0125 is repaired by this runner', () => {
    // The live table: every committed entry recorded under its own body, except
    // 0125's slot, which 0126's body took when it ran from the branch where it
    // was still numbered 0125.
    // The shape of each field is the first describe block's job; this one
    // only needs them as the runner reads them.
    const entries = readJournal().map((entry) => ({
      tag: String(entry.tag),
      when: Number(entry.when),
      hash: crypto
        .createHash('sha256')
        .update(
          fs.readFileSync(
            path.join(MIGRATIONS_DIR, `${String(entry.tag)}.sql`),
            'utf8',
          ),
        )
        .digest('hex'),
    }));
    const lost = entries.find(
      (e) => e.tag === '0125_agent_focus_skip_wiki_content',
    )!;
    const borrower = entries.find(
      (e) => e.tag === '0126_disputes_target_version',
    )!;
    // Two applied files were edited since they ran, so their rows carry the
    // retired hash, not today's body.
    const withRetired = entries.map((e) => ({
      ...e,
      retiredHashes: RETIRED_MIGRATION_HASHES[e.tag] ?? [],
    }));
    const rows = withRetired.map((e) => ({
      createdAt: e.when,
      hash: e.tag === lost.tag ? borrower.hash : (e.retiredHashes[0] ?? e.hash),
    }));
    // ...and the one hand-written row that belongs to no migration.
    rows.push(...UNATTRIBUTED_LEGACY_ROWS);
    expect(unrecognisedRows(withRetired, rows)).toEqual([]);
    expect(ambiguouslyAttributedRows(withRetired, rows)).toEqual([]);
    expect(
      migrationsBehindWatermark(
        withRetired,
        attributedMigrationWhens(withRetired, rows),
        excludeNothing,
        reconciliationWatermark(withRetired, rows),
      ).map((e) => e.tag),
    ).toEqual([lost.tag]);
    expect(unrecordedBorrowerSlots(withRetired, rows)).toEqual([]);
  });

  it('the runner still reconciles and still asserts it finished', () => {
    // Both calls are the whole point: the reconciliation applies what
    // migrate() cannot see, and the assertion turns a still-missing migration
    // into a failed build instead of a green one. Either call dropped from
    // main() restores the silent skip this file documents.
    const main = readRunnerMain();
    expect(
      main,
      'the runner no longer applies migrations behind the high-water mark',
    ).toContain('applyMigrationsBehindWatermark()');
    expect(
      main,
      'the runner no longer verifies that every committed migration landed',
    ).toContain('assertEveryMigrationRecorded()');
  });

  it('the runner repairs gaps before any migrator runs', () => {
    // Order, not presence. `applyNonTransactionalMigrations` calls
    // `migrateThrough` ahead of each special tag, and that call obeys the same
    // high-water mark — so a buried migration older than a special tag is
    // still missing when it runs, and the entries after the mark meet a schema
    // its predecessor never built. It aborts on the absent relation before the
    // repair is ever reached. Seeding stays ahead of both: it creates the
    // bookkeeping table the gap query reads.
    const main = readRunnerMain();
    const seed = main.indexOf('seedBaseline()');
    const repair = main.indexOf('applyMigrationsBehindWatermark()');
    const special = main.indexOf('applyNonTransactionalMigrations()');
    expect(seed, 'main() no longer seeds the baseline').toBeGreaterThan(-1);
    expect(repair, 'main() no longer repairs gaps').toBeGreaterThan(-1);
    expect(
      special,
      'main() no longer applies the non-transactional migrations',
    ).toBeGreaterThan(-1);
    expect(
      seed < repair,
      'main() repairs gaps before seeding the bookkeeping table the gap ' +
        'query reads',
    ).toBe(true);
    expect(
      repair < special,
      'main() runs the non-transactional loop before repairing gaps, so its ' +
        'migrateThrough() meets a schema a buried migration never built',
    ).toBe(true);
  });

  it('every module the runner imports gates the migration workflow', () => {
    // The runner's own path is listed in migrations.yml; a helper it imports
    // was not, and that helper decides which migrations get applied by hand
    // against the live database. A PR changing only the helper would run the
    // general scripts typecheck and skip both the gap unit tests and the chain
    // replay — the production migration path changing without its gate.
    //
    // Derived from the imports rather than hard-coded, so the next helper is
    // caught the day it is added instead of the day it breaks a deploy.
    const runner = fs.readFileSync(RUNNER, 'utf8');
    const localImports = Array.from(
      runner.matchAll(/from '(\.[^']*)'/g),
      (m) => m[1] ?? '',
    );
    expect(
      localImports.length,
      'the runner imports no local modules — has the import style changed?',
    ).toBeGreaterThan(0);

    const workflow = fs.readFileSync(
      path.resolve(
        __dirname,
        '..',
        '.github',
        'workflows',
        MIGRATIONS_WORKFLOW,
      ),
      'utf8',
    );
    // Once under `pull_request`, once under `push`: a gate that runs on pull
    // requests but not on merges to main lets the regression land anyway.
    for (const specifier of localImports) {
      const file = `scripts/${specifier.replace(/^\.\//, '').replace(/\.js$/, '.ts')}`;
      expect(
        workflow.split(`- '${file}'`).length - 1,
        `${MIGRATIONS_WORKFLOW} does not list ${file} under both its ` +
          '`pull_request` and `push` path filters, so a change to it would ' +
          'skip the migration gate',
      ).toBe(2);
    }
  });
});
