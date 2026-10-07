/**
 * What a T3 case's comparison needs to know about its target: whether it is a
 * numeric drug parameter, and if so its canonical unit and the drug's
 * molecular weight (for a mass↔molar concentration conversion).
 *
 * Only range parameters — the calculation-driving, entry-backed measurements
 * with a canonical unit, the dimensionless `''` included — carry a value an
 * opinion endorses. Everything else
 * (wiki facts, paper reviews, categorical or text parameters) is compared on
 * resolution and scope alone, and an endorsing opinion on it carries no value.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../db.js';
import { VERIFICATION_SOURCE_TABLES } from '../verification-targets.js';
import type { AgentVerificationTargetType } from '../../../db/schema.js';
import {
  drugParameterRevisions,
  parameterEntries,
  pendingEdits,
  wikiPages,
  wikiRevisions,
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
  // Approving a deletion endorses no value: the entry goes (#100).
  if (op === 'delete') return null;
  if (op === 'create') return { parameter: edit.parameter, drugId: edit.targetId };
  if (edit.targetId == null) return { parameter: edit.parameter, drugId: null };
  const [entry] = await db
    .select({ drugId: parameterEntries.drugId })
    .from(parameterEntries)
    .where(eq(parameterEntries.id, edit.targetId));
  return { parameter: edit.parameter, drugId: entry?.drugId ?? null };
}

const WIKI_PAGE_EDIT_TYPES = ['wiki_page', 'wiki_fact', 'wiki_section'];

/**
 * The status of the wiki page a target's content belongs to, for the
 * visibility rule every wiki surface applies (`callerCanReadWikiPage`):
 * `null` when the target is not wiki content at all; `undefined` when the
 * page is gone, which reads as unreadable. A proposed new page (`wiki_new`)
 * is unpublished by definition.
 *
 * A pending edit that is gone (a drug deletion removes its wiki-scoped edits
 * and pages) is placed from the copy the panel was bound to; with no copy to
 * place it by, it fails closed.
 */
export async function targetWikiPageStatus(
  targetType: string,
  targetId: number,
  bound?: { served: Record<string, unknown> } | null,
): Promise<string | null | undefined> {
  const db = getDb();
  let pageId: number | null | undefined = null;
  if (targetType === 'wiki_revision') {
    const [rev] = await db
      .select({ pageId: wikiRevisions.pageId })
      .from(wikiRevisions)
      .where(eq(wikiRevisions.id, targetId));
    pageId = rev?.pageId;
  } else if (targetType === 'pending_edit') {
    const [row] = await db
      .select({ editType: pendingEdits.editType, targetId: pendingEdits.targetId })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, targetId));
    const servedPayload = bound?.served?.payload as
      | { editType?: unknown; targetId?: unknown }
      | undefined;
    const edit =
      row ??
      (typeof servedPayload?.editType === 'string'
        ? {
            editType: servedPayload.editType,
            targetId: typeof servedPayload.targetId === 'number' ? servedPayload.targetId : null,
          }
        : null);
    if (!edit) return undefined;
    if (edit.editType === 'wiki_new') return 'draft';
    if (!WIKI_PAGE_EDIT_TYPES.includes(edit.editType)) return null;
    pageId = edit.targetId;
  } else {
    return null;
  }
  if (pageId == null) return undefined;
  const [page] = await db
    .select({ status: wikiPages.status })
    .from(wikiPages)
    .where(eq(wikiPages.id, pageId));
  return page?.status;
}

/** The target's source row as it stands now, or null when it is gone. */
export async function readTargetRow(
  targetType: string,
  targetId: number,
): Promise<Record<string, unknown> | null> {
  const table = VERIFICATION_SOURCE_TABLES[targetType as AgentVerificationTargetType];
  if (!table) return null;
  const [row] = await getDb().select().from(table).where(eq(table.id, targetId));
  return (row as Record<string, unknown> | undefined) ?? null;
}

/** Null when the target carries no value an opinion could endorse. */
export async function adjudicationTargetParameter(
  targetType: string,
  targetId: number,
): Promise<AdjudicationTargetParameter | null> {
  const found = await parameterAndDrug(targetType, targetId);
  if (!found || !isDrugParameterId(found.parameter)) return null;
  const spec = DRUG_PARAMETERS[found.parameter];
  // `''` is a real canonical unit — the dimensionless one (pKa, logP, logD) —
  // so only an absent unit makes the target valueless.
  if (!isRangeSpec(spec) || typeof spec.canonicalUnit !== 'string') return null;
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
