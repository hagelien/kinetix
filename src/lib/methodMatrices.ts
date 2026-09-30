/**
 * Canonical vocabularies for analytical methods (sample matrix + method type).
 *
 * Single source of truth, deliberately dependency-free so BOTH the React app
 * (`@/lib/methodMeta`, `@/lib/drugApi`) and the serverless API
 * (`api/methods.ts`, via a relative import) can consume the same arrays. They
 * used to be copy-pasted per layer, which let them drift: the editor offered
 * an "Annet"/other matrix toggle that the API's zod enum then rejected with
 * `matrices.N: Invalid option`.
 *
 * Adding a matrix here means also adding: a colour in `MATRIX_COLORS`
 * (`src/lib/methodMeta.ts`) and a `methods.matrix_<slug>` label in every
 * locale file — both are covered by `methodMatrices.test.ts`.
 */

/** Sample media a method applies to, in display order. */
export const METHOD_MATRIX_VALUES = [
  'blood',
  'urine',
  'saliva',
  'muscle',
  'vitreous',
  'organ',
  'hair',
  'other',
] as const;

export type MethodMatrix = (typeof METHOD_MATRIX_VALUES)[number];

/** Method classification, in display order. Null in the DB = unknown. */
export const METHOD_TYPE_VALUES = [
  'screening',
  'confirmatory',
  'screening_confirmatory',
] as const;

export type MethodType = (typeof METHOD_TYPE_VALUES)[number];

export function isMethodMatrix(value: unknown): value is MethodMatrix {
  return METHOD_MATRIX_VALUES.includes(value as MethodMatrix);
}
