/**
 * Readable lines for a block revision's before/after snapshot (#37).
 *
 * The history endpoint stores each block (metabolism, mechanisms, model
 * structure) as a content snapshot — see `api/_lib/drugBlockRevisions.ts`.
 * The history dialog shows the two sides as lists of lines, one per route,
 * metabolite, mechanism or declaration, and marks the lines only one side has,
 * so a reader sees what changed without reading two JSON documents. Citations
 * are kept on each line (`#id`) because a changed source is a change too.
 */
import { formatRange } from './rangeUtils';
import {
  eliminationRouteEnzymeLabel,
  eliminationRouteKindKey,
  formatFractionRangePercent,
  type EliminationRouteKind,
  type MetabolismEnzyme,
  type MetabolismFractionRange,
} from './metabolism';
import { formatInteractionLabel } from './receptorInteractions';
import { ROUTE_LABEL_KEYS } from './routeLabels';
import { DRUG_PARAMETERS, getParameterLongLabelKey, isDrugParameterId } from './drugParameters';
import type { RouteId } from './kinetics-core';
import type { DrugBlockId } from './drugBlocks';
import { formatGenericDrugName, resolveDrugName } from './drugNames';
import type { NumericRange } from '@/types';

type Translate = (key: string, opts?: Record<string, unknown>) => string;

type SnapshotRow = Record<string, unknown>;

function rows(value: unknown): SnapshotRow[] {
  return Array.isArray(value)
    ? value.filter((v): v is SnapshotRow => Boolean(v) && typeof v === 'object')
    : [];
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function refs(value: unknown): string | null {
  const ids = Array.isArray(value)
    ? value.filter((id): id is number => typeof id === 'number')
    : [];
  return ids.length > 0 ? ids.map((id) => `#${id}`).join(', ') : null;
}

function join(parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => Boolean(p)).join(' · ');
}

function metabolismLines(snapshot: SnapshotRow, t: Translate, lang: string): string[] {
  const lines: string[] = [];
  for (const route of rows(snapshot.routes)) {
    const kind = route.kind as EliminationRouteKind;
    const enzymeLabel =
      kind === 'enzyme'
        ? eliminationRouteEnzymeLabel(
            {
              enzyme: (route.enzyme as MetabolismEnzyme | null) ?? null,
              label: text(route.label),
            },
            lang,
          ) || t('metabolismRoute.enzyme')
        : null;
    const base = enzymeLabel ?? t(`metabolismRoute.${eliminationRouteKindKey(kind)}`);
    const label =
      !enzymeLabel && text(route.label) ? `${base} (${text(route.label)})` : base;
    lines.push(
      join([
        label,
        formatFractionRangePercent(route.fraction as MetabolismFractionRange | null),
        text(route.note),
        refs(route.referenceIds),
      ]),
    );
  }
  const links = (key: 'metabolites' | 'precursors', heading: string) => {
    for (const link of rows(snapshot[key])) {
      const drug = link.drug as { names?: Record<string, string> } | null;
      const name =
        (drug ? formatGenericDrugName(resolveDrugName(drug.names, lang)) : '') ||
        text(link.metaboliteName) ||
        '';
      const activity =
        link.activity === 'active'
          ? t('sidebar.metabolismActive')
          : link.activity === 'inactive'
            ? t('sidebar.metabolismInactive')
            : null;
      lines.push(
        join([
          `${heading}: ${name}`,
          activity,
          formatFractionRangePercent(
            link.conversionFraction as MetabolismFractionRange | null,
          ),
          text(link.evidenceNote),
          refs(link.referenceIds),
        ]),
      );
    }
  };
  links('metabolites', t('sidebar.metabolismMetabolites'));
  links('precursors', t('sidebar.metabolismPrecursors'));
  const note = text(snapshot.evidenceNote);
  if (note) lines.push(`${t('sidebar.metabolismNote')}: ${note}`);
  return lines;
}

const MECHANISM_METRICS: Array<[string, string | null]> = [
  ['affinity', 'sidebar.receptorAffinity'],
  ['potency', 'sidebar.receptorPotency'],
  ['efficacy', 'sidebar.receptorEfficacy'],
  ['ki', null],
  ['ic50', null],
  ['ec50', null],
  ['emax', null],
  ['selectivityRatio', null],
];

const METRIC_SYMBOLS: Record<string, string> = {
  ki: 'Ki',
  ic50: 'IC50',
  ec50: 'EC50',
  emax: 'Emax',
  selectivityRatio: 'Selectivity',
};

const TIER_KEYS: Record<string, string> = {
  primary: 'sidebar.mechanismPrimary',
  secondary: 'sidebar.mechanismSecondary',
  tertiary: 'sidebar.mechanismTertiary',
};

function pharmacodynamicsLines(snapshot: SnapshotRow, t: Translate): string[] {
  return rows(snapshot.mechanisms).map((mechanism) => {
    const target = (mechanism.target ?? {}) as { symbol?: string };
    const tier =
      typeof mechanism.tier === 'string' && TIER_KEYS[mechanism.tier]
        ? t(TIER_KEYS[mechanism.tier]!)
        : t('sidebar.mechanismOther');
    const metrics = MECHANISM_METRICS.map(([key, labelKey]) => {
      const value = mechanism[key] as NumericRange | null | undefined;
      const formatted = value ? formatRange(value, { showNote: false }) : '';
      if (!formatted) return null;
      return `${labelKey ? t(labelKey) : METRIC_SYMBOLS[key]} ${formatted}`;
    });
    return join([
      `${tier}: ${formatInteractionLabel(String(mechanism.interactionType ?? ''), t)} ${t(
        'sidebar.mechanismAt',
      )} ${target.symbol ?? ''}`.trim(),
      ...metrics,
      text(mechanism.assaySpecies)
        ? `${t('sidebar.assaySpecies')} ${text(mechanism.assaySpecies)}`
        : null,
      text(mechanism.evidenceNote),
      refs(mechanism.referenceIds),
    ]);
  });
}

function modelStructureLines(snapshot: SnapshotRow, t: Translate): string[] {
  return rows(snapshot.declarations).map((declaration) => {
    const parameter = String(declaration.parameter ?? '');
    const axis = isDrugParameterId(parameter)
      ? t(getParameterLongLabelKey(parameter), {
          defaultValue: DRUG_PARAMETERS[parameter].longLabel,
        })
      : parameter;
    const value = text(declaration.categoricalValue) ?? '';
    const route = text(declaration.route);
    const routeKey = route ? ROUTE_LABEL_KEYS[route as RouteId] : undefined;
    const quote = text(declaration.sourceQuote);
    return join([
      `${axis}: ${t(`parameters.modelStructure.value.${value}`, { defaultValue: value })}`,
      route ? (routeKey ? t(routeKey) : route) : null,
      typeof declaration.citationId === 'number' ? `#${declaration.citationId}` : null,
      quote ? `“${quote}”` : null,
    ]);
  });
}

/**
 * One line per entry of a block snapshot. A snapshot that is not an object
 * (never expected) yields no lines rather than throwing inside the dialog.
 */
export function blockSnapshotLines(
  block: DrugBlockId,
  snapshot: unknown,
  t: Translate,
  lang: string,
): string[] {
  if (!snapshot || typeof snapshot !== 'object') return [];
  const value = snapshot as SnapshotRow;
  switch (block) {
    case 'metabolism':
      return metabolismLines(value, t, lang);
    case 'pharmacodynamics':
      return pharmacodynamicsLines(value, t);
    case 'modelStructure':
      return modelStructureLines(value, t);
  }
}
