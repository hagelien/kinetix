/**
 * The shared logarithmic axis (§8.3, §9.2).
 *
 * One axis for every group: two ratios on one screen scaled differently is the
 * incoherence the design exists to avoid. Decade tick labels are literal strings
 * and never run through the number formatter: a tick is a scale marker, not a
 * measurement, so it takes neither the precision ladder nor a rounding step.
 */

import { useTranslation } from 'react-i18next';

import { MAX_FRACTION_DIGITS } from '../../../lib/pattern/format';
import type { AxisVM } from '../../../lib/pattern/profileModel';

interface Props {
  axis: AxisVM;
}

/** Position of a tick along the track, as a percentage. */
function tickPosition(value: number, axis: AxisVM): number {
  const span = Math.log10(axis.hi) - Math.log10(axis.lo);
  return ((Math.log10(value) - Math.log10(axis.lo)) / span) * 100;
}

/**
 * A decade label in the reader's own convention. The separator follows the
 * active language rather than being fixed: an English profile showing `0,1`
 * beside English prose is the same class of error as a Norwegian one showing
 * `0.1`. The value is still chosen for the decade, not run through the
 * precision ladder — a tick is a scale marker, not a measurement.
 */
function tickLabel(value: number, locale: string): string {
  if (value >= 1) return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
  const decimals = Math.max(0, -Math.round(Math.log10(value)));
  // A decade this small has no honest decimal rendering, and which way it
  // fails depends on the engine. `Intl.NumberFormat` v3 raised the
  // fraction-digit ceiling from twenty to a hundred, so a browser predating it
  // throws a `RangeError` here — taking the whole profile down rather than
  // mislabelling one tick — while a current one draws a tick label a hundred
  // characters wide, and clamping to twenty instead would print `0` for a
  // nonzero decade. Scientific notation is what such a decade reads as anyway,
  // and the measurement formatter reaches for it at the same limit.
  if (decimals > MAX_FRACTION_DIGITS) {
    return new Intl.NumberFormat(locale, { notation: 'scientific' }).format(value);
  }
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

export function RatioAxis({ axis }: Props) {
  const { i18n } = useTranslation();
  const locale = i18n.language?.startsWith('en') ? 'en-GB' : 'nb-NO';

  return (
    <div className="relative h-5 select-none" aria-hidden="true">
      {axis.ticks.map((tick) => (
        <span
          key={tick}
          className="absolute -translate-x-1/2 text-[11px] text-[hsl(var(--muted-foreground-faint))]"
          style={{ left: `${tickPosition(tick, axis)}%` }}
        >
          {tickLabel(tick, locale)}
        </span>
      ))}
    </div>
  );
}
