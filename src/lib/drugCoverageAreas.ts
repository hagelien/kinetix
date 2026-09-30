/**
 * Coverage areas — the relationship-shaped halves of a drug's record.
 *
 * Most of what the agents maintain is a flat (drug, parameter) pair with a
 * pooled value or a cited declaration behind it, and `DRUG_PARAMETER_IDS` is
 * the register of those. Two parts of a monograph are not shaped like that at
 * all:
 *
 *   - **metabolism** is a graph — per-enzyme and per-excretion routes on
 *     `drug_elimination_routes`, parent → metabolite edges on
 *     `drug_metabolites`, and the profile's evidence note. There is no single
 *     number to pool, so it was never given a parameter id (#436).
 *   - **pharmacodynamics** is a ranked list of receptor-target relationships on
 *     `drug_receptor_targets`. The drug-level Ki/IC50/EC50/Emax parameters were
 *     retired precisely because the quantities belong to a mechanism, not to
 *     the drug.
 *
 * Having no parameter id kept them out of every surface that steers the
 * agents: an admin could not put them in the agent focus, a moderator could not
 * flag one for the queue, and the gap queue never asked whether a drug had
 * either. The two most editorially expensive sections of a monograph were the
 * two nobody could point an agent at.
 *
 * So they get ids here rather than in the parameter register. They are work
 * TARGETS — valid in `agent_focus_config.parameters` and in
 * `parameter_priority_flags.parameter` — without becoming parameters: nothing
 * writes a `drug_parameters` row for them, no monograph sidebar row renders
 * one, and no pending edit proposes one. Keeping the two lists apart is what
 * stops "can be pointed at" from being read as "has a value".
 *
 * Deliberately dependency-free so `api/` can import it directly instead of
 * keeping a hand-synced mirror the way it must for `drugParameters.ts` (which
 * drags in zod and the formatters).
 */

export const DRUG_COVERAGE_AREA_IDS = [
  'metabolism',
  'pharmacodynamics',
] as const;

export type DrugCoverageAreaId = (typeof DRUG_COVERAGE_AREA_IDS)[number];

export interface DrugCoverageAreaDef {
  id: DrugCoverageAreaId;
  /** i18n key under `coverageAreas.*` for the picker / flag label. */
  i18nKey: string;
  /**
   * Which monograph sidebar section shows this area, so a flag raised in the
   * admin panel and a flag raised on the monograph land on the same target.
   */
  sidebarSection: 'metabolism' | 'pharmacodynamics';
}

export const DRUG_COVERAGE_AREAS: readonly DrugCoverageAreaDef[] = [
  {
    id: 'metabolism',
    i18nKey: 'coverageAreas.metabolism',
    sidebarSection: 'metabolism',
  },
  {
    id: 'pharmacodynamics',
    i18nKey: 'coverageAreas.pharmacodynamics',
    sidebarSection: 'pharmacodynamics',
  },
];

export function isDrugCoverageAreaId(id: string): id is DrugCoverageAreaId {
  return (DRUG_COVERAGE_AREA_IDS as readonly string[]).includes(id);
}

export function getDrugCoverageArea(
  id: string,
): DrugCoverageAreaDef | undefined {
  return DRUG_COVERAGE_AREAS.find((area) => area.id === id);
}
