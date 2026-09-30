/**
 * Where is stored Norwegian prose missing its æ, ø and å?
 *
 * Agent-authored content is Norwegian bokmål by instruction, but some of it
 * was written with the three Norwegian vowels transliterated away ("en aerlig
 * karakteristikk ... ikke ny malt, verdi"). The cause was transport, not
 * language: request bodies were once mangled on a Windows runner (#1222), and
 * an author who has seen `æ` come back broken starts avoiding it. The transport
 * is UTF-8-safe now and the agent instructions forbid the workaround, so what
 * is left is the backlog — prose already in the database, which no future
 * instruction reaches.
 *
 * This reads it, read-only by default:
 *
 *   TRANSLITERATED  Norwegian prose that contains no æ/ø/å at all and at least
 *                   one folded spelling. That combination is the finding.
 *   STRONG hits     folded spellings that are not words in their own right
 *                   ("ogsaa", "forste", "sporsmal") — mechanically repairable.
 *   LIKELY hits     folded spellings that are also real words ("malt",
 *                   "bade", "veske") — a lead to read in context, never a
 *                   correction to apply blind.
 *
 * `--apply` writes back the STRONG repairs, and only those, and only in rows
 * the detector calls transliterated, and only in the plain-text prose columns.
 * Wiki page content and the JSON `note` on a parameter are reported but never
 * rewritten: they are structured documents whose repair belongs in a normal
 * edit with a summary attached, not in a bulk UPDATE underneath the review
 * queue.
 *
 * Usage:
 *   npm run audit:norwegian              # report
 *   npm run audit:norwegian -- --check   # exit 1 when anything is found
 *   npm run audit:norwegian -- --apply   # repair the unambiguous spellings
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { getDb } from '../api/_lib/db';
import {
  inspectNorwegianOrthography,
  repairStrongTransliterations,
} from '../src/lib/norwegianOrthography';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const check = process.argv.includes('--check');
const apply = process.argv.includes('--apply');

async function query<T>(text: string): Promise<T[]> {
  const res = await getDb().execute(sql.raw(text));
  return ((res as { rows?: unknown[] }).rows ?? res) as unknown as T[];
}

interface Source {
  /** Human label for the report. */
  label: string;
  table: string;
  /** Primary-key column, used to address a row for repair. */
  idColumn: string;
  /** The prose column. */
  column: string;
  /** Extra columns to print alongside the id, as `alias` → SQL expression. */
  context?: Record<string, string>;
  /**
   * False for structured documents: they are reported but never written back
   * (see the header — a wiki fact is repaired through an edit, not an UPDATE).
   */
  repairable: boolean;
  /** Optional row filter, e.g. only the current wiki revision. */
  where?: string;
}

const SOURCES: Source[] = [
  {
    label: 'verification log (agent notes)',
    table: 'verification_log',
    idColumn: 'id',
    column: 'agent_notes',
    context: { target: "target_type || coalesce(' #' || target_id, '')" },
    repairable: true,
  },
  {
    label: 'peer verification rationales',
    table: 'agent_verifications',
    idColumn: 'id',
    column: 'rationale_md',
    context: { target: "target_type || ' #' || target_id" },
    repairable: true,
  },
  {
    label: 'discussion comments',
    table: 'drug_parameter_discussions',
    idColumn: 'id',
    column: 'body',
    context: {
      target: "coalesce('drug ' || drug_id, 'page ' || wiki_page_id)",
    },
    repairable: true,
  },
  {
    label: 'source-value comments',
    table: 'parameter_entries',
    idColumn: 'id',
    column: 'comments',
    context: { target: "'drug ' || drug_id || ' · ' || parameter" },
    repairable: true,
  },
  {
    label: 'paper reviews',
    table: 'paper_reviews',
    idColumn: 'id',
    column: 'review_markdown',
    context: { target: "'citation ' || citation_id" },
    repairable: true,
  },
  {
    label: 'proposed facts (review queue)',
    table: 'pending_edits',
    idColumn: 'id',
    column: 'fact_statement',
    context: { target: "edit_type || ' · ' || status" },
    repairable: true,
  },
  {
    label: 'rejection comments',
    table: 'pending_edits',
    idColumn: 'id',
    column: 'rejection_comment',
    context: { target: "edit_type || ' · ' || status" },
    repairable: true,
  },
  {
    label: 'parameter notes (JSON)',
    table: 'drug_parameters',
    // Composite key (drug_id, parameter): the drug id addresses the row, and
    // the context column names which parameter on it.
    idColumn: 'drug_id',
    column: "value->>'note'",
    context: { target: 'parameter' },
    repairable: false,
  },
  {
    label: 'live wiki content (JSON)',
    // The published document on the page row, not `wiki_revisions` — history
    // is immutable, and re-reporting every superseded draft would bury the
    // findings a reader can still act on.
    table: 'wiki_pages',
    idColumn: 'id',
    column: 'content::text',
    context: { target: 'slug' },
    repairable: false,
  },
];

interface Finding {
  source: Source;
  id: number;
  target: string;
  text: string;
  strong: string[];
  likely: string[];
  repaired: string | null;
}

function truncate(s: string, n = 150): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

async function collect(source: Source): Promise<Finding[]> {
  const contextSql = Object.entries(source.context ?? {})
    .map(([alias, expr]) => `, ${expr} AS "${alias}"`)
    .join('');
  const rows = await query<{ id: number; text: string; target?: string }>(`
    SELECT ${source.idColumn} AS id, ${source.column} AS text${contextSql}
    FROM ${source.table}
    WHERE ${source.column} IS NOT NULL AND ${source.column} <> ''
      ${source.where ? `AND ${source.where}` : ''}
    ORDER BY ${source.idColumn}`);

  const findings: Finding[] = [];
  for (const row of rows) {
    const report = inspectNorwegianOrthography(row.text);
    if (!report.transliterated) continue;
    const repaired = source.repairable
      ? repairStrongTransliterations(row.text)
      : null;
    findings.push({
      source,
      id: row.id,
      target: row.target ?? '',
      text: row.text,
      strong: report.hits
        .filter((h) => h.confidence === 'strong')
        .map((h) => `${h.word} → ${h.suggestions.join(' / ')}`),
      likely: report.hits
        .filter((h) => h.confidence === 'likely')
        .map((h) => `${h.word} → ${h.suggestions.join(' / ')}`),
      repaired: repaired && repaired !== row.text ? repaired : null,
    });
  }
  return findings;
}

async function main(): Promise<void> {
  console.log(
    apply
      ? 'Repairing unambiguous æ/ø/å spellings in stored Norwegian prose.\n'
      : 'Stored Norwegian prose written without æ/ø/å.\n',
  );

  let total = 0;
  let repaired = 0;

  for (const source of SOURCES) {
    const findings = await collect(source);
    console.log(
      `${source.label.toUpperCase()} (${source.table}.${source.column})`,
    );
    if (!findings.length) {
      console.log('  none.\n');
      continue;
    }
    total += findings.length;

    for (const f of findings) {
      console.log(`  #${f.id}${f.target ? ` · ${f.target}` : ''}`);
      console.log(`    "${truncate(f.text)}"`);
      if (f.strong.length) console.log(`    certain: ${f.strong.join(', ')}`);
      if (f.likely.length) console.log(`    check:   ${f.likely.join(', ')}`);

      if (!source.repairable) {
        console.log(
          '    → structured content; repair it through a normal edit.',
        );
        continue;
      }
      if (!f.repaired) {
        console.log('    → nothing certain enough to repair automatically.');
        continue;
      }
      if (!apply) {
        console.log(`    → --apply restores the spellings listed as certain.`);
        continue;
      }
      await getDb().execute(
        sql`UPDATE ${sql.raw(source.table)}
            SET ${sql.raw(source.column)} = ${f.repaired}
            WHERE ${sql.raw(source.idColumn)} = ${f.id}`,
      );
      repaired++;
      console.log('    repaired.');
    }
    console.log('');
  }

  console.log(`${total} row${total === 1 ? '' : 's'} written without æ/ø/å.`);
  if (apply) {
    console.log(`${repaired} repaired; the rest need a reader.`);
  } else if (total > 0) {
    console.log(
      'Re-run with --apply to restore the unambiguous spellings. Everything\n' +
        'listed under "check:" stays for a human or an agent to read in context.',
    );
  }
  if (check && total > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
