/**
 * Drug blocks — the parts of a monograph that are curated as a whole rather
 * than as one value per parameter.
 *
 * Metabolism (a graph of routes and metabolite edges), pharmacodynamics (a
 * ranked list of receptor-target mechanisms) and the PK model structure (the
 * categorical disposition/elimination/absorption declarations) are stored as
 * structured lists, not as `drug_parameters` rows. They still need what every
 * parameter row has — a revision history and a discussion thread — so each
 * block gets one id that both hang off, for the whole block per drug (#37).
 *
 * The ids are deliberately disjoint from `DRUG_PARAMETER_IDS`: a block id is
 * a discussion target and a history key, never a parameter with a value. The
 * module stays dependency-free so `api/` can import it directly.
 */

export const DRUG_BLOCK_IDS = [
  'metabolism',
  'pharmacodynamics',
  'modelStructure',
] as const;

export type DrugBlockId = (typeof DRUG_BLOCK_IDS)[number];

export function isDrugBlockId(value: unknown): value is DrugBlockId {
  return (
    typeof value === 'string' &&
    (DRUG_BLOCK_IDS as readonly string[]).includes(value)
  );
}

/** i18n key for the block's name, as used in dialog headings. */
export function drugBlockLabelKey(block: DrugBlockId): string {
  return `drugBlocks.${block}`;
}

