/**
 * What a T3 case's comparison needs to know about its target: whether it is a
 * numeric drug parameter, and if so its canonical unit and the drug's
 * molecular weight (for a mass↔molar concentration conversion).
 *
 * Only range parameters — the calculation-driving, entry-backed measurements
 * with a canonical unit — carry a value an opinion endorses. Everything else
 * (wiki facts, paper reviews, categorical or text parameters) is compared on
 * resolution and scope alone, and an endorsing opinion on it carries no value.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../db.js';
import {
  drugParameterRevisions,
  parameterEntries,
  pendingEdits,
} from '../../../db/schema.js';
import { getDrugParameterMap } from '../drugParameterStore.js';
import {
  DRUG_PARAMETERS,
  isDrugParameterId,
  isRangeSpec,
} from '../../../src/lib/drugParameters.js';

export interface AdjudicationTargetParameter {
  parameter: string;
  canonicalUnit: string;
  drugId: number | null;
  molecularWeight: number | null;
}

async function parameterAndDrug(
  targetType: string,
  targetId: number,
): Promise<{ parameter: string; drugId: number | null } | null> {
  const db = getDb();
  if (targetType === 'drug_parameter_revision') {
    const [row] = await db
      .select({ parameter: drugParameterRevisions.parameter, drugId: drugParameterRevisions.drugId })
      .from(drugParameterRevisions)
      .where(eq(drugParameterRevisions.id, targetId));
    return row ?? null;
  }
  if (targetType !== 'pending_edit') return null;
  const [edit] = await db
    .select({
      editType: pendingEdits.editType,
      parameter: pendingEdits.parameter,
      targetId: pendingEdits.targetId,
      proposedValue: pendingEdits.proposedValue,
    })
    .from(pendingEdits)
    .where(eq(pendingEdits.id, targetId));
  if (!edit?.parameter) return null;
  if (edit.editType === 'parameter') {
    return { parameter: edit.parameter, drugId: edit.targetId };
  }
  if (edit.editType !== 'param_entry') return null;
  // A create targets the drug; an update or delete targets the entry.
  const op = (edit.proposedValue as { op?: unknown } | null)?.op;
  if (op === 'create') return { parameter: edit.parameter, drugId: edit.targetId };
  if (edit.targetId == null) return { parameter: edit.parameter, drugId: null };
  const [entry] = await db
    .select({ drugId: parameterEntries.drugId })
    .from(parameterEntries)
    .where(eq(parameterEntries.id, edit.targetId));
  return { parameter: edit.parameter, drugId: entry?.drugId ?? null };
}

/** Null when the target carries no value an opinion could endorse. */
export async function adjudicationTargetParameter(
  targetType: string,
  targetId: number,
): Promise<AdjudicationTargetParameter | null> {
  const found = await parameterAndDrug(targetType, targetId);
  if (!found || !isDrugParameterId(found.parameter)) return null;
  const spec = DRUG_PARAMETERS[found.parameter];
  if (!isRangeSpec(spec) || !spec.canonicalUnit) return null;
  let molecularWeight: number | null = null;
  if (found.drugId != null) {
    const mw = (await getDrugParameterMap(getDb(), found.drugId)).get('molecularWeight');
    molecularWeight = typeof mw === 'number' ? mw : null;
  }
  return {
    parameter: found.parameter,
    canonicalUnit: spec.canonicalUnit,
    drugId: found.drugId,
    molecularWeight,
  };
}
