/**
 * The small amount of SQL lexing the migration guards need, in one place.
 *
 * Two of them need it: `tests/drizzle-migration-statements.test.ts` counts the
 * commands in a chunk, and `tests/integration/setup/harness.ts` drops the
 * `CONCURRENTLY` keyword before replaying a chunk on PGlite. Both were built
 * from ad-hoc regexes and both grew the same corner cases separately —
 * non-ASCII identifiers, comments between keywords, nested block comments — so
 * the lexical rules live here and are fixed once.
 *
 * The rules are Postgres's, not JavaScript's:
 *   - an identifier is `[A-Za-z\200-\377_]` then those plus digits and `$`,
 *     so *every* byte above 0x7F continues one (letters, combining marks,
 *     anything else) and `\w`/`\b` are the wrong tools;
 *   - a comment goes wherever whitespace goes, and block comments nest.
 */

const NON_ASCII = String.raw`[^\x00-\x7F]`;

/** A character that may appear inside an unquoted identifier. */
export const IDENT_CHAR = new RegExp(`${NON_ASCII}|[A-Za-z0-9_$]`, 'u');

/** A dollar-quote tag: identifier rules, minus the dollar sign. */
export const DOLLAR_TAG = new RegExp(
  String.raw`\$(?:${NON_ASCII}|[A-Za-z_])(?:${NON_ASCII}|[A-Za-z0-9_])*\$|\$\$`,
  'uy',
);

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && IDENT_CHAR.test(ch);
}

/**
 * Index of the first character at or after `from` that is neither whitespace
 * nor a comment. Block comments are depth-counted rather than ended at the
 * first closing delimiter, because Postgres nests them.
 */
export function skipTrivia(sql: string, from = 0): number {
  let i = from;
  for (;;) {
    const ch = sql[i];
    if (ch === undefined) return i;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith('/*', i)) {
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
    return i;
  }
}

/**
 * Match a run of keywords from the start of `sql`, allowing trivia between
 * them, and report the span of the last one. Each keyword must be a whole
 * token: `concurrently$archive` is one identifier, so it does not match the
 * keyword `concurrently` — which is what `\b` gets wrong, `$` being a
 * non-word character to JavaScript but an identifier character to Postgres.
 */
export function matchKeywordRun(
  sql: string,
  keywords: readonly string[],
): { start: number; end: number } | null {
  let i = 0;
  let start = 0;
  for (const keyword of keywords) {
    i = skipTrivia(sql, i);
    let end = i;
    while (isIdentChar(sql[end])) end++;
    if (end === i || sql.slice(i, end).toLowerCase() !== keyword.toLowerCase())
      return null;
    start = i;
    i = end;
  }
  return { start, end: i };
}

const CONCURRENT_INDEX_HEADS: ReadonlyArray<readonly string[]> = [
  ['create', 'unique', 'index', 'concurrently'],
  ['create', 'index', 'concurrently'],
  ['drop', 'index', 'concurrently'],
];

/**
 * Drop `CONCURRENTLY` from a chunk that *is* a concurrent index statement, so
 * it can be replayed on a single-connection test database (where a plain
 * `CREATE INDEX` is equivalent).
 *
 * Rewriting SQL that the deploy runs verbatim is the risk, so the keywords are
 * matched only from the start of the chunk. Nothing else can be there — not a
 * string literal holding `'CREATE INDEX CONCURRENTLY'`, not a `"concurrently"`
 * column — and anything this does not recognize is replayed as written, which
 * fails loudly rather than passing on altered SQL.
 */
export function dropIndexConcurrently(statement: string): string {
  for (const head of CONCURRENT_INDEX_HEADS) {
    const span = matchKeywordRun(statement, head);
    if (span) return statement.slice(0, span.start) + statement.slice(span.end);
  }
  return statement;
}
