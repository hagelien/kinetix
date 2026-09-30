/**
 * What an admin or moderator is allowed to point the agents at.
 *
 * Two registers answer that, and they are not the same list. `DRUG_PARAMETER_IDS`
 * holds the flat quantities and declarations; `DRUG_COVERAGE_AREA_IDS` holds the
 * relationship-shaped sections (metabolism, pharmacodynamics) that have no
 * parameter id because they have no single value to pool. Both are legal in
 * `agent_focus_config.parameters` and in `parameter_priority_flags.parameter`.
 *
 * The union lives here, once, because the two routes that accept these ids —
 * `/api/agent-focus` and `/api/parameter-priority-flags` — have to agree about
 * it. When each held its own test, a focus could name a target the flag route
 * rejected.
 */
import { isDrugParameterId } from './drugParameterIds.js';
import { isDrugCoverageAreaId } from '../../src/lib/drugCoverageAreas.js';
import { parameterAuthoringGated } from '../../src/lib/drugParameters.js';

export function isAgentWorkTarget(id: string): boolean {
  // A parameter whose authoring is still gated (Cmax, before the dose-context
  // writers ship) is not work an agent can do — pointing one at it would only
  // queue refusals.
  if (isDrugParameterId(id)) return !parameterAuthoringGated(id);
  return isDrugCoverageAreaId(id);
}
