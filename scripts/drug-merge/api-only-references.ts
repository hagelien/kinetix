/**
 * Drug references `npm run merge:drugs` deliberately does not move, because the
 * admin merge (`POST /api/drug-merge`, api/_lib/drug-merge.ts) does — with the
 * checks a bare repoint would skip.
 *
 * The dose-context references on `parameter_entries` (Cmax release B, #1340)
 * name a drug from ANY drug's entry: a metabolite's Cmax names its parent as
 * the drug administered. Repointing them loser → survivor is not a plain
 * UPDATE. It can turn an interaction arm into a drug interacting with itself,
 * and it can make two of a third drug's entries one observation recorded twice
 * (pooled twice). The admin merge refuses both and repoints the rest; this
 * script would have to re-implement all of it to do the same, and a second
 * copy of those rules is how the two would drift (Codex P1 on #1360).
 *
 * So the script keeps its correct-by-refusal contract for these columns and
 * says where the merge CAN be done, instead of a generic "teach me this table"
 * that invites someone to add a naive repoint.
 */
export const API_ONLY_REFERENCES: ReadonlyMap<string, string> = new Map([
  ['parameter_entries.drug_id', "the loser's own source entries"],
  ['parameter_entries.administered_drug_id', 'entries naming the loser as the drug administered'],
  ['parameter_entries.interacting_drug_id', 'entries naming the loser as the interacting drug'],
]);

/**
 * The refusal for references only the admin merge moves, or null when none of
 * `unhandled` (`table.column (n rows)` strings) is one of them.
 */
export function apiOnlyRefusal(
  refs: readonly { table: string; column: string; rows: number }[],
): string | null {
  const hits = refs.filter((r) => API_ONLY_REFERENCES.has(`${r.table}.${r.column}`));
  if (hits.length === 0) return null;
  const what = hits
    .map((r) => `${API_ONLY_REFERENCES.get(`${r.table}.${r.column}`)} (${r.rows})`)
    .join(', ');
  return (
    `the loser is referenced by ${what}. Only the admin merge moves these ` +
    '(Admin → Merge drugs, or POST /api/drug-merge): it repoints them and refuses ' +
    'an interaction arm or a duplicate observation the repoint would create. Merge there instead'
  );
}
