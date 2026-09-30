import {
  METHOD_MATRIX_VALUES,
  METHOD_TYPE_VALUES,
  type MethodMatrix,
  type MethodType,
} from '@/lib/methodMatrices';

/** Display order for the matrix multi-select / badges. */
export const METHOD_MATRICES: readonly MethodMatrix[] = METHOD_MATRIX_VALUES;

/** Display order for the method-type selector. */
export const METHOD_TYPES: readonly MethodType[] = METHOD_TYPE_VALUES;

/**
 * Canonical colour per sample matrix. Used to colour-code method badges and
 * the matrix toggles in the editor. A method that spans several matrices is
 * rendered with all of these colours (see {@link matrixGradient}).
 */
export const MATRIX_COLORS: Record<MethodMatrix, string> = {
  blood: '#dc2626', // red
  urine: '#ca8a04', // amber
  saliva: '#0891b2', // cyan
  muscle: '#9333ea', // purple
  vitreous: '#2563eb', // blue
  organ: '#ea580c', // orange
  hair: '#65a30d', // lime
  other: '#64748b', // slate
};

/** Solid colour-code for a single matrix. */
export function matrixColor(matrix: MethodMatrix): string {
  return MATRIX_COLORS[matrix];
}

/**
 * CSS `background` value tinting an element with every matrix colour. One
 * matrix → a flat tint; several → equal hard-stop stripes so the badge/button
 * is "partly coloured in all relevant matrix colours". Colours are rendered at
 * ~22 % opacity so text stays legible on top.
 */
export function matrixGradient(matrices: readonly MethodMatrix[]): string {
  const tints = matrices.map((m) => `${MATRIX_COLORS[m]}38`); // ~22% alpha
  if (tints.length === 0) return 'transparent';
  if (tints.length === 1) return tints[0] ?? 'transparent';
  const n = tints.length;
  const stops = tints
    .map((c, i) => `${c} ${(i / n) * 100}%, ${c} ${((i + 1) / n) * 100}%`)
    .join(', ');
  return `linear-gradient(135deg, ${stops})`;
}

/**
 * Border colour for a method-code badge tinted by its matrices. Picks up the
 * first matrix's colour at ~70 % alpha so the pill clearly reads as that matrix
 * (the striped {@link matrixGradient} background conveys any further matrices)
 * without a hard edge fighting the code text. Empty → no override.
 */
export function matrixBorderColor(matrices: readonly MethodMatrix[]): string {
  const first = matrices[0];
  return first ? `${MATRIX_COLORS[first]}b3` : '';
}

/** i18n key for a matrix slug. */
export function matrixLabelKey(matrix: MethodMatrix): string {
  return `methods.matrix_${matrix}`;
}

/** i18n key for a method type (null → unspecified). */
export function methodTypeLabelKey(type: MethodType | null | undefined): string {
  return type ? `methods.type_${type}` : 'methods.type_unknown';
}

/** Badge colour variant for a method type. */
export function methodTypeBadgeVariant(
  type: MethodType | null | undefined,
): 'info' | 'secondary' | 'muted' {
  if (type === 'screening') return 'info';
  if (type === 'confirmatory') return 'secondary';
  return 'muted';
}
