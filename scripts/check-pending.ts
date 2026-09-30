import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL!);

// Accept drug IDs (and optional parameter IDs) from CLI args:
//   npx tsx scripts/check-pending.ts <drugId1> <drugId2> ...
//   npx tsx scripts/check-pending.ts <drugId1>:<paramId> <drugId2> ...
// Falls back to an empty result if no IDs are supplied.
const args = process.argv.slice(2);
if (args.length === 0) {
  console.log("PENDING:[]");
  process.exit(0);
}

const drugIds: number[] = [];
const filters: Array<{ drugId: number; parameter?: string }> = [];

for (const arg of args) {
  const [drugPart, paramPart] = arg.split(':');
  const drugId = Number(drugPart);
  if (!Number.isInteger(drugId) || drugId <= 0) {
    console.error(`Skipping invalid arg: ${arg}`);
    continue;
  }
  drugIds.push(drugId);
  filters.push(paramPart ? { drugId, parameter: paramPart } : { drugId });
}

if (drugIds.length === 0) {
  console.log("PENDING:[]");
  process.exit(0);
}

// Fetch all pending parameter edits for the requested drug IDs, then
// filter client-side so callers can optionally narrow by parameter too.
const rows = await sql`
  SELECT target_id, parameter, status
  FROM pending_edits
  WHERE edit_type = 'parameter'
    AND status = 'pending'
    AND target_id = ANY(${drugIds}::int[])
`;

const filtered = rows.filter((row) =>
  filters.some(
    (f) =>
      f.drugId === row.target_id &&
      (f.parameter === undefined || f.parameter === row.parameter),
  ),
);

console.log("PENDING:" + JSON.stringify(filtered));
