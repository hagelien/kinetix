/**
 * One ratio's track: the band, if it has one, and the case result.
 *
 * Three rules here, all of them about the plot not contradicting the text:
 *
 *  - a band without provenance renders **hatched and mute** and carries no
 *    statistic. The hatching is the entire warning, so it is drawn from theme
 *    tokens and inverts with the theme;
 *  - parity is drawn where the axis actually puts 1. A log axis is not
 *    symmetric around it, so a line at the midpoint would place markers on the
 *    wrong side of parity;
 *  - a censored or interval result draws as a span or a ray, never as the same
 *    solid tick a point uses. The value cell reads `<X`, `>X` or `X–Y`, and a
 *    single tick beside any of those is the graph disagreeing with its own row.
 */

import { useTranslation } from 'react-i18next';

import type { BandVM, MarkerVM } from '../../../lib/pattern/profileModel';

interface Props {
  band: BandVM | null;
  marker: MarkerVM | null;
  parityPct: number;
  label: string;
}

export function RatioTrack({ band, marker, parityPct, label }: Props) {
  const { t } = useTranslation();

  return (
    <div
      className="relative h-6 rounded-sm bg-[hsl(var(--muted))]/40"
      role="img"
      aria-label={label}
    >
      <span
        className="absolute inset-y-0 w-px bg-[hsl(var(--border-subtle))]"
        style={{ left: `${parityPct}%` }}
      />

      {band && (
        <span
          className="absolute inset-y-1 rounded-sm border border-dashed border-[hsl(var(--muted-foreground-faint))] bg-[repeating-linear-gradient(45deg,transparent,transparent_3px,hsl(var(--border-subtle))_3px,hsl(var(--border-subtle))_6px)]"
          style={{ left: `${band.p5Pct}%`, width: `${Math.max(band.p95Pct - band.p5Pct, 0.5)}%` }}
          title={t('pattern.profile.band.provisional')}
        />
      )}

      {marker && (marker.isInterval || marker.bound) && (
        <Span marker={marker} />
      )}

      {marker && <Endpoint pct={marker.positionPct} wide={marker.outOfAxis !== null} />}

      {/* A clamped marker sits at the rim, exactly where a result that really
          is at the boundary would sit. Widening it says "something happened"
          and nothing about what or which way, so the direction is drawn as
          well — and stated in the accessible name, which is composed by the
          caller because `role="img"` hides everything in here from it.

          Either endpoint can leave the axis, and independently: an interval may
          start inside the view and end well outside it. */}
      {[marker?.outOfAxis, marker?.endOutOfAxis]
        .filter((direction): direction is 'low' | 'high' => Boolean(direction))
        .filter((direction, index, all) => all.indexOf(direction) === index)
        .map((direction) => (
          <span
            key={direction}
            aria-hidden="true"
            className="absolute inset-y-0 flex items-center text-[10px] leading-none text-[hsl(var(--foreground))]"
            style={direction === 'high' ? { right: '1px' } : { left: '1px' }}
            title={t(`pattern.profile.track.outOfAxis.${direction}`)}
          >
            {direction === 'high' ? '▸' : '◂'}
          </span>
        ))}

      {/* An interval has two rims and its value cell says so. Marking only one
          would show a point where the row reads X–Y. */}
      {marker?.isInterval && marker.endPct !== undefined && (
        <Endpoint pct={marker.endPct} wide={marker.endOutOfAxis !== null} />
      )}
    </div>
  );
}

function Endpoint({ pct, wide }: { pct: number; wide: boolean }) {
  return (
    <span
      className={[
        'absolute inset-y-1 -translate-x-1/2 rounded-sm bg-[hsl(var(--foreground))]',
        wide ? 'w-[7px]' : 'w-[3px]',
      ].join(' ')}
      style={{ left: `${pct}%` }}
    />
  );
}

/**
 * The extent of a result that has one: an interval between its two endpoints, or
 * a censored bound running to the rim it is open toward.
 */
function Span({ marker }: { marker: MarkerVM }) {
  const from = marker.isInterval
    ? Math.min(marker.positionPct, marker.endPct ?? marker.positionPct)
    : marker.bound === 'lower'
      ? marker.positionPct
      : 0;
  const to = marker.isInterval
    ? Math.max(marker.positionPct, marker.endPct ?? marker.positionPct)
    : marker.bound === 'lower'
      ? 100
      : marker.positionPct;

  return (
    <span
      className="absolute inset-y-[10px] bg-[hsl(var(--foreground))]/35"
      style={{ left: `${from}%`, width: `${Math.max(to - from, 0.5)}%` }}
    />
  );
}
