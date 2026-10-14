import { useMemo } from 'react';
import {
  canonicalConcentrationUnit,
  concentrationTooltipArgs,
  splitConcentrationText,
} from '@/lib/concentrationText';
import { UnitTooltip } from './UnitTooltip';

interface ConcentrationTextProps {
  /** Plain prose, e.g. a source quote or an observation note. */
  text: string;
  /** Drug molecular weight — required for molar↔mass conversions. */
  molecularWeight: number | null | undefined;
}

/**
 * Render plain prose with every concentration in it ("cut-off 1 µg/L",
 * "0,2 til 0,5 mg/L") carrying the unit-conversion tooltip on its unit — the
 * React counterpart of the wiki renderer's HTML annotation, matched by the same
 * pattern.
 *
 * The figures stay exactly as written: this prose is often a quotation, and
 * re-expressing its numbers in the reader's unit would misquote the source. The
 * other units are one hover away instead.
 */
export function ConcentrationText({ text, molecularWeight }: ConcentrationTextProps) {
  const segments = useMemo(() => splitConcentrationText(text), [text]);
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === 'text' ? (
          segment.text
        ) : (
          <UnitTooltip
            key={index}
            {...concentrationTooltipArgs(segment.value)}
            unit={canonicalConcentrationUnit(segment.unit)}
            molecularWeight={molecularWeight}
          >
            {segment.text}
          </UnitTooltip>
        ),
      )}
    </>
  );
}
