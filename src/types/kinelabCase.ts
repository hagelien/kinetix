import { z } from 'zod';
import {
  inferenceInputSchema,
  inferenceResultSchema,
} from '@/lib/compute/types';

// `KineLabCaseData` is the JSONB shape persisted in `simulator_cases.case_data`
// for KineLab cases (forensic inverse-inference scenarios). The `kind`
// discriminator lets the existing simulator-cases API serve both Kinetix's
// multi-drug forward simulator cases and KineLab cases without a schema
// migration. See docs/kinelab-integration.md.

export const KINELAB_CASE_KIND = 'kinelab-case' as const;

export const kinelabCaseDataSchema = z.object({
  kind: z.literal(KINELAB_CASE_KIND),
  schemaVersion: z.literal(1),
  /** Inputs are stored verbatim so a saved case re-runs identically. */
  input: inferenceInputSchema,
  /** Last computed result, optional — old cases may have been saved before
   *  the run completed. */
  result: inferenceResultSchema.optional(),
  notes: z.string().optional(),
});

export type KineLabCaseData = z.infer<typeof kinelabCaseDataSchema>;

export function isKinelabCaseData(value: unknown): value is KineLabCaseData {
  if (!value || typeof value !== 'object') return false;
  return (value as { kind?: unknown }).kind === KINELAB_CASE_KIND;
}
