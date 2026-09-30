/**
 * Column axes the substance register can be opened on, for callers that are
 * not the register.
 *
 * Its own module rather than an export from `DrugTable`: the table is lazily
 * loaded behind the shell, and importing a two-element array from it would pull
 * the whole component — sorting, conversion, the parameter registry — into
 * whichever page did the importing.
 */

/**
 * Lab's own urine detection time. A gated, non-parameter column of the
 * substance register; the id lives here so the register and the presets cannot
 * disagree about how to spell it.
 */
export const LAB_URINE_COLUMN_ID = 'labUrineDetection';

/**
 * What the "detection times for every substance" link switches the register to:
 * the substance, then one column per matrix. Everything else is dropped, for
 * the same reason the link exists — the reader asked for one axis.
 */
export const DETECTION_COLUMN_PRESET: readonly string[] = [
  'name',
  'bloodDetectionWindow',
  'oralFluidDetectionWindow',
  'urineDetectionWindow',
];

/** The preset a Lab member gets: the same axis, plus LAB's own band. */
export const LAB_DETECTION_COLUMN_PRESET: readonly string[] = [
  ...DETECTION_COLUMN_PRESET,
  LAB_URINE_COLUMN_ID,
];
