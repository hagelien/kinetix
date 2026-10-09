import {
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  SortableHeader,
} from '@/components/ui/table';
import { useDrugStore } from '@/stores/drugStore';
import { useAuthStore } from '@/stores/authStore';
import { loadComponents, loadMethods } from '@/data';
import { trackDrugInteraction } from '@/lib/drugApi';
import { canAccessAnalyticalMethods } from '@/lib/featureAccess';
import { methodIncludesDrug } from '@/lib/analyticalMethods';
import { formatMethodLabel, searchMethods } from '@/lib/methodSearch';
import { drugComponentKey } from '@/lib/drugSearch';
import {
  formatRange,
  showFractionAsPercent,
  type FractionDisplay,
  normalizeRangeInput,
  extremeForSort,
  representativeValue,
} from '@/lib/rangeUtils';
import {
  DRUG_VALUE_PARAMETER_IDS,
  DRUG_PARAMETERS,
  getParameterLabelKey,
  getParameterLongLabelKey,
  isRangeKind,
  isRangeSpec,
  type DrugParameterId,
  type ParameterSpec,
} from '@/lib/drugParameters';
import { useRefsDetectionTimes } from '@/lib/useRefsDetectionTimes';
import { refsStatementText } from '@/lib/refsStatementText';
import { refsStatementForRole } from '@/lib/refsDetectionTimes';
import { REFS_URINE_COLUMN_ID } from '@/lib/detectionColumnPresets';
import { parseLocaleNumber } from '@/lib/parseNumber';
import { buildSimulatorUrl } from '@/lib/simulatorRouting';
import { loadTableColumns, saveTableColumns } from '@/lib/storage';
import {
  convertBetweenKinds,
  molarUnitOptions,
  massUnitOptions,
  matrixOptions,
  type MatrixType,
} from '@/lib/conversions';
import type { DrugComponent, NumericRange } from '@/types';
import { UnitTooltip } from '@/components/ui/UnitTooltip';
import { isConcentrationParameterId } from '@/lib/unitTooltip';
import {
  Search,
  Table as TableIcon,
  ChevronDown,
  FlaskConical,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import {
  useAppStore,
  useFractionDisplay,
  type ConcentrationUnit,
} from '@/stores/appStore';
import { isMolarUnit } from '@/lib/unitConversion';

/**
 * Concentration units that BOTH the drug-table row converter
 * (`src/lib/conversions.ts`'s `massUnits` / `molarUnits`) AND the
 * simulator worker (`montecarlo.worker.ts:152`) understand. The
 * preferences picker may enable other units (per-dL, ng/mL, etc.) for
 * tooltip and converter-modal display, but the user's PRIMARY must
 * stay in this intersection or the row's `<select>` ends up with no
 * matching option, `convertBetweenKinds` returns null, and the
 * send-to-simulator launch silently mis-scales (#317 P1 / P2 review).
 */
const PRIMARY_ELIGIBLE_UNITS = new Set<ConcentrationUnit>([
  'mg/L',
  'µg/L',
  'mmol/L',
  'µmol/L',
  'nmol/L',
]);
import { useTranslation } from 'react-i18next';
import { useDrugName, activeLangCode } from '@/lib/useDrugName';
import { capitalizeGenericDrugName, resolveDrugName } from '@/lib/drugNames';
import { useDrugRowSelect } from './drug-table/useDrugRowSelect';
import { useDrugTableSearchResults } from './drug-table/useDrugTableSearchResults';
import { MethodSearchMatches } from './drug-table/MethodSearchMatches';
import { DrugNameCell } from './drug-table/DrugNameCell';

function toSortable(
  val: unknown,
  direction: 'asc' | 'desc',
): number | string | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) {
    const joined = val.filter(Boolean).join(', ');
    return joined || null;
  }
  if (typeof val === 'object') {
    const r = val as NumericRange;
    if (
      typeof r.median === 'number' ||
      typeof r.mean === 'number' ||
      typeof r.min === 'number' ||
      typeof r.max === 'number'
    ) {
      return extremeForSort(r, direction);
    }
  }
  return null;
}

function compareSortable(
  a: number | string | null,
  b: number | string | null,
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return 0;
}

/**
 * Placeholder for a cell with no value. A full-contrast em dash repeated
 * down every empty cell reads as visual noise in a dense table, so it's
 * dimmed well below the body text colour to keep the eye on real values.
 */
const EMPTY_VALUE = (
  <span className="text-muted-foreground/40">—</span>
);

/**
 * Unit shown in a column header, in square brackets. Dimensionless kinds
 * (fraction, ratio, scalar) and metadata without a unit return '' so the
 * header omits the brackets entirely.
 */
function getParameterHeaderUnit(spec: ParameterSpec): string {
  if (spec.kind === 'number') return spec.unitLabel || '';
  if (isRangeSpec(spec)) {
    const unit = spec.canonicalUnit;
    if (!unit || unit === 'fraction' || unit === 'ratio') return '';
    return unit;
  }
  return '';
}

/**
 * Full descriptive column header: the parameter's symbol, its full
 * (translated) name in parentheses, then the unit in square brackets —
 * e.g. "Vd (Distribusjonsvolum) [L/kg]". Parameters without a symbol fall
 * back to just the full name; parameters without a unit omit the brackets.
 */
function buildParameterHeaderLabel(
  parameterId: DrugParameterId,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const spec = DRUG_PARAMETERS[parameterId];
  const fullName = t(getParameterLongLabelKey(parameterId), {
    defaultValue: spec.longLabel,
  });
  const unit = getParameterHeaderUnit(spec);
  const base = spec.symbol ? `${spec.symbol} (${fullName})` : fullName;
  return unit ? `${base} [${unit}]` : base;
}

function buildParameterCompactHeaderLabel(
  parameterId: DrugParameterId,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const spec = DRUG_PARAMETERS[parameterId];
  const shortName = t(getParameterLabelKey(parameterId), {
    defaultValue: spec.label,
  });
  const unit = getParameterHeaderUnit(spec);
  const base = spec.symbol || shortName;
  return unit ? `${base} [${unit}]` : base;
}

function getDrugSortValue(
  drug: DrugComponent,
  sortColumn: string,
  lang: string,
): unknown {
  if (sortColumn === 'name') return resolveDrugName(drug.names, lang);
  if (sortColumn === '_popularityScore') return drug._popularityScore;
  if (sortColumn === 'nameNb') return drug.names.nb;
  if (sortColumn === 'nameEn') return drug.names.en;
  if (sortColumn === 'aliases') return drug.aliases;
  return (drug as unknown as Record<string, unknown>)[sortColumn];
}

/**
 * Column descriptor for the drug table. `sortKey` is the DrugComponent field
 * used for sorting; if omitted, the column is not sortable.
 */
interface ColumnSpec {
  id: string;
  label: string;
  parameterId?: DrugParameterId;
  // Sort by drug field, popularity, or the synthetic "name" key (resolved to
  // the localized display name at sort time).
  sortKey?: keyof DrugComponent | DrugParameterId | '_popularityScore' | 'name';
  defaultVisible: boolean;
  headClassName?: string;
  align?: 'left' | 'right';
}

const COLUMN_I18N_KEYS: Record<string, string> = {
  name: 'drugTable.name',
  conversion: 'drugTable.unitConversion',
  molecularWeight: 'drugTable.mw',
  halfLife: 'drugTable.halfLife',
  volumeOfDistribution: 'drugTable.vd',
  bioavailability: 'drugTable.f',
  bloodPlasmaRatio: 'drugTable.bp',
  proteinBinding: 'drugTable.fb',
  tmax: 'drugTable.tmax',
  pKa: 'drugTable.pKa',
  refsUrineDetection: 'drugTable.refsUrineDetection',
};

const BUILT_IN_PARAMETER_COLUMN_IDS = new Set<DrugParameterId>([
  'molecularWeight',
  'halfLife',
  'volumeOfDistribution',
  'bioavailability',
  'bloodPlasmaRatio',
  'proteinBinding',
  'tmax',
  'pKa',
]);

/**
 * Explicit sort options surfaced in the toolbar dropdown. "Popularity"
 * is the default and is not a visible column header, so without this
 * dropdown there was no way for the user to re-select it after sorting
 * by something else (#290).
 */
type SortOption =
  | { id: '_popularityScore' | 'name'; labelKey: string }
  | { id: DrugParameterId; parameterId: DrugParameterId };

const DRUG_TABLE_SORT_PARAMETER_IDS: DrugParameterId[] = [
  ...DRUG_VALUE_PARAMETER_IDS,
];

const SORT_OPTIONS: SortOption[] = [
  { id: '_popularityScore', labelKey: 'drugTable.sort.popularity' },
  { id: 'name', labelKey: 'drugTable.name' },
  ...DRUG_TABLE_SORT_PARAMETER_IDS.map((parameterId) => ({
    id: parameterId,
    parameterId,
  })),
];

function toSimulatorDrugRef(drug: DrugComponent): {
  id: string;
  pubchemCid: number | null;
  dbId: number | null;
} {
  const parsedId = Number(drug.id);
  const hasNumericId = Number.isFinite(parsedId);
  const idMatchesDbId = drug._dbId != null && String(drug._dbId) === drug.id;

  return {
    id: drug.id,
    pubchemCid: hasNumericId && !idMatchesDbId ? parsedId : null,
    dbId: drug._dbId ?? null,
  };
}

/**
 * Extended (non built-in) parameter columns that are visible by default.
 * Clearance is part of the standard view; the rest of the extended
 * parameters remain opt-in via the column picker.
 */
const DEFAULT_VISIBLE_EXTRA_PARAMETER_IDS = new Set<DrugParameterId>([
  'clearance',
]);

const ALL_COLUMNS: ColumnSpec[] = [
  {
    id: 'name',
    label: 'Name',
    sortKey: 'name',
    defaultVisible: true,
    headClassName: 'w-[180px]',
  },
  {
    id: 'conversion',
    label: 'Unit Conversion',
    defaultVisible: false,
    headClassName: 'w-[260px]',
  },
  {
    id: 'molecularWeight',
    label: 'MW (g/mol)',
    parameterId: 'molecularWeight',
    sortKey: 'molecularWeight',
    defaultVisible: true,
    headClassName: 'text-right',
    align: 'right',
  },
  {
    id: 'halfLife',
    label: 't½ (h)',
    parameterId: 'halfLife',
    sortKey: 'halfLife',
    defaultVisible: false,
  },
  {
    id: 'volumeOfDistribution',
    label: 'Vd (L/kg)',
    parameterId: 'volumeOfDistribution',
    sortKey: 'volumeOfDistribution',
    defaultVisible: true,
  },
  {
    id: 'bioavailability',
    label: 'F',
    parameterId: 'bioavailability',
    sortKey: 'bioavailability',
    defaultVisible: true,
  },
  {
    id: 'bloodPlasmaRatio',
    label: 'B/P',
    parameterId: 'bloodPlasmaRatio',
    sortKey: 'bloodPlasmaRatio',
    defaultVisible: true,
  },
  {
    id: 'proteinBinding',
    label: 'Fb',
    parameterId: 'proteinBinding',
    sortKey: 'proteinBinding',
    defaultVisible: true,
  },
  {
    id: 'tmax',
    label: 'Tmax (h)',
    parameterId: 'tmax',
    sortKey: 'tmax',
    defaultVisible: true,
  },
  {
    id: 'pKa',
    label: 'pKa',
    parameterId: 'pKa',
    sortKey: 'pKa',
    defaultVisible: true,
  },
  ...DRUG_VALUE_PARAMETER_IDS.filter(
    (parameterId) => !BUILT_IN_PARAMETER_COLUMN_IDS.has(parameterId),
  ).map((parameterId) => ({
    id: parameterId,
    label: DRUG_PARAMETERS[parameterId].label,
    parameterId,
    sortKey: parameterId,
    // Clearance (CL) joins MW, Vd, F, B/P, Fb, Tmax and pKa in the default
    // standard view; every other extended parameter stays opt-in.
    defaultVisible: DEFAULT_VISIBLE_EXTRA_PARAMETER_IDS.has(parameterId),
  })),
  // Last on the axis, and last in `DrugRow`'s cell order — the two lists are
  // positional, not keyed, so a column added in one place has to be added at
  // the same place in the other.
  {
    id: REFS_URINE_COLUMN_ID,
    label: 'Urin (REFS)',
    defaultVisible: false,
    headClassName: 'w-[160px]',
  },
];

const ALL_COLUMN_IDS = new Set(ALL_COLUMNS.map((c) => c.id));
const DEFAULT_VISIBLE_COLUMN_IDS = ALL_COLUMNS.filter(
  (c) => c.defaultVisible,
).map((c) => c.id);

const PARAMETER_HEADER_MIN_FULL_WIDTH_PX = 150;
const NON_PARAMETER_COLUMN_WIDTHS_PX: Record<string, number> = {
  name: 180,
  conversion: 260,
};

function shouldUseCompactParameterHeaders(
  containerWidth: number,
  columns: ColumnSpec[],
): boolean {
  if (containerWidth <= 0) return false;

  const parameterColumnCount = columns.filter((col) => col.parameterId).length;
  if (parameterColumnCount === 0) return false;

  const fixedWidth = columns.reduce((total, col) => {
    if (col.parameterId) return total;
    return total + (NON_PARAMETER_COLUMN_WIDTHS_PX[col.id] ?? 120);
  }, 0);

  const averageParameterWidth =
    (containerWidth - fixedWidth) / parameterColumnCount;
  return averageParameterWidth < PARAMETER_HEADER_MIN_FULL_WIDTH_PX;
}

function loadInitialVisibleColumns(): Set<string> {
  const storedColumns = loadTableColumns().filter((id) =>
    ALL_COLUMN_IDS.has(id),
  );
  return new Set(
    storedColumns.length > 0 ? storedColumns : DEFAULT_VISIBLE_COLUMN_IDS,
  );
}

function formatParameterTableValue(
  drug: DrugComponent,
  parameterId: DrugParameterId,
  lang: string,
  fractionDisplay: FractionDisplay,
): string {
  const spec = DRUG_PARAMETERS[parameterId];
  const value = getDrugSortValue(drug, parameterId, lang);
  if (isRangeKind(spec.kind)) {
    return formatRange(
      normalizeRangeInput(value as NumericRange | number | undefined, {
        asFraction: spec.kind === 'fraction',
      }),
      {
        showNote: false,
        showUnit: false,
        asPercent: showFractionAsPercent(spec.kind, fractionDisplay),
      },
    );
  }
  return spec.format(value);
}

/**
 * Render a parameter table cell. Concentration-valued columns (the
 * interpretive concentrations) get the magic unit-conversion tooltip so a
 * hover surfaces the value in every enabled unit — matching the monograph
 * sidebar. The cell text itself stays unit-less (the unit lives in the column
 * header), so `UnitTooltip` underlines the whole value.
 */
function renderParameterTableValue(
  drug: DrugComponent,
  parameterId: DrugParameterId,
  lang: string,
  fractionDisplay: FractionDisplay,
): ReactNode {
  const formatted = formatParameterTableValue(
    drug,
    parameterId,
    lang,
    fractionDisplay,
  );
  if (!formatted) return EMPTY_VALUE;
  if (!isConcentrationParameterId(parameterId)) return formatted;
  const range = normalizeRangeInput(getDrugSortValue(drug, parameterId, lang));
  if (!range) return formatted;
  const spec = DRUG_PARAMETERS[parameterId];
  const unit = range.unit ?? (isRangeSpec(spec) ? spec.canonicalUnit : undefined);
  return (
    <UnitTooltip
      value={representativeValue(range)}
      low={typeof range.min === 'number' ? range.min : null}
      high={typeof range.max === 'number' ? range.max : null}
      unit={unit}
      molecularWeight={drug.molecularWeight ?? null}
    >
      {formatted}
    </UnitTooltip>
  );
}

interface ConversionState {
  sourceValue: string;
  targetValue: string;
  lastEdited: 'source' | 'target';
  massUnit: string;
  molarUnit: string;
  sourceMatrix: MatrixType;
  targetMatrix: MatrixType;
}

function DrugRow({
  drug,
  conversion,
  onConversionChange,
  visibleColumns,
  preferredUnit,
  onSendToSimulator,
  onOpenDrug,
  refsUrineLabel,
  t,
  lang,
  fractionDisplay,
}: {
  drug: DrugComponent;
  conversion: ConversionState;
  onConversionChange: (updates: Partial<ConversionState>) => void;
  visibleColumns: Set<string>;
  preferredUnit: ConcentrationUnit;
  onSendToSimulator: (drugId: string, value: number, unit: string) => void;
  onOpenDrug: (drug: DrugComponent) => void;
  /** REFS's band for this substance; null when the guideline does not name it. */
  refsUrineLabel: string | null;
  t: (key: string, opts?: Record<string, unknown>) => string;
  lang: string;
  /** How F and protein binding are written — the 0–1 decimal, or a percentage. */
  fractionDisplay: FractionDisplay;
}) {
  const displayValues = useMemo(() => {
    const drugData = {
      molecularWeight: drug.molecularWeight ?? 0,
      bloodPlasmaRatio: drug.bloodPlasmaRatio,
    };

    if (conversion.lastEdited === 'source') {
      if (!conversion.sourceValue || !drug.molecularWeight) {
        return { source: conversion.sourceValue, target: '' };
      }
      const computed = convertBetweenKinds(
        conversion.sourceValue,
        'molar',
        conversion.molarUnit,
        conversion.sourceMatrix,
        'mass',
        conversion.massUnit,
        conversion.targetMatrix,
        drugData,
      );
      return {
        source: conversion.sourceValue,
        target: computed === '' ? '' : String(computed),
      };
    }
    if (!conversion.targetValue || !drug.molecularWeight) {
      return { source: '', target: conversion.targetValue };
    }
    const computed = convertBetweenKinds(
      conversion.targetValue,
      'mass',
      conversion.massUnit,
      conversion.targetMatrix,
      'molar',
      conversion.molarUnit,
      conversion.sourceMatrix,
      drugData,
    );
    return {
      source: computed === '' ? '' : String(computed),
      target: conversion.targetValue,
    };
  }, [conversion, drug.molecularWeight, drug.bloodPlasmaRatio]);

  const molarOptions = useMemo(
    () => molarUnitOptions.map((u) => ({ value: u, label: u })),
    [],
  );
  const massOptions = useMemo(
    () => massUnitOptions.map((u) => ({ value: u, label: u })),
    [],
  );
  const matrixOptionsList = useMemo(
    () =>
      matrixOptions.map((m) => ({
        value: m,
        label: t(m === 'blood' ? 'drugTable.matrix.blood' : 'drugTable.matrix.plasmaSerum'),
      })),
    [t],
  );

  // #860: the drug table shows generic names with a capitalised first letter
  // (`Diazepam`), reverting the lower-case house style applied elsewhere. The
  // standard (INN) name is shown by default; the shortname and aliases move to
  // the hover tooltip (see `DrugNameCell`) rather than replacing the name.
  const { displayName: standardName } = useDrugName(drug);
  const displayName = capitalizeGenericDrugName(standardName);

  return (
    // `[&>td]:py-2` compacts each cell vertically (was the default p-3 →
    // 12px) so the row is visibly tighter without changing horizontal
    // padding or the cell-by-cell width hints (#399).
    <TableRow
      onClick={() => onOpenDrug(drug)}
      className="cursor-pointer [&>td]:py-2"
    >
      {visibleColumns.has('name') && (
        <TableCell className="w-[180px] max-w-[180px]">
          {/* Wrapper enforces width-based truncation: the <table> uses
              auto layout, so cells can grow to fit content unless the
              inner block has an explicit max-width plus overflow:hidden.
              Without this a long drug name would push the conversion
              column off-screen — see #290. */}
          <div className="block w-full max-w-full overflow-hidden">
            <DrugNameCell drug={drug} displayName={displayName} t={t} />
          </div>
        </TableCell>
      )}
      {visibleColumns.has('conversion') && (
        <TableCell className="w-[260px]" onClick={(e) => e.stopPropagation()}>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <Input
                type="text"
                inputMode="decimal"
                placeholder={conversion.molarUnit}
                value={displayValues.source}
                onChange={(e) =>
                  onConversionChange({
                    sourceValue: e.target.value,
                    lastEdited: 'source',
                  })
                }
                className="w-20 h-7 text-xs px-2"
              />
              <Select
                options={molarOptions}
                value={conversion.molarUnit}
                onChange={(e) =>
                  onConversionChange({ molarUnit: e.target.value })
                }
                className="w-20 h-7 text-xs px-1.5 py-0"
              />
              <Select
                options={matrixOptionsList}
                value={conversion.sourceMatrix}
                onChange={(e) =>
                  onConversionChange({
                    sourceMatrix: e.target.value as MatrixType,
                  })
                }
                className="w-20 h-7 text-xs px-1.5 py-0"
              />
            </div>
            <div className="flex items-center gap-1">
              <Input
                type="text"
                inputMode="decimal"
                placeholder={conversion.massUnit}
                value={displayValues.target}
                onChange={(e) =>
                  onConversionChange({
                    targetValue: e.target.value,
                    lastEdited: 'target',
                  })
                }
                className="w-20 h-7 text-xs px-2"
              />
              <Select
                options={massOptions}
                value={conversion.massUnit}
                onChange={(e) =>
                  onConversionChange({ massUnit: e.target.value })
                }
                className="w-20 h-7 text-xs px-1.5 py-0"
              />
              <Select
                options={matrixOptionsList}
                value={conversion.targetMatrix}
                onChange={(e) =>
                  onConversionChange({
                    targetMatrix: e.target.value as MatrixType,
                  })
                }
                className="w-20 h-7 text-xs px-1.5 py-0"
              />
            </div>
            {(displayValues.source || displayValues.target) && (
              <button
                onClick={() => {
                  // Any molar primary (nmol/L, µmol/L, mmol/L, …) routes
                  // through the molar source field; everything else through
                  // the mass side. The previous `=== 'µmol/L'` check
                  // misclassified non-µmol molar primaries as mass once
                  // the multi-select preference let users choose them
                  // (#317 review).
                  const isMolar = isMolarUnit(preferredUnit);
                  const val = isMolar
                    ? displayValues.source
                    : displayValues.target;
                  const unit = isMolar
                    ? conversion.molarUnit
                    : conversion.massUnit;
                  const num = parseLocaleNumber(val);
                  if (Number.isFinite(num) && num > 0) {
                    onSendToSimulator(drug.id, num, unit);
                  }
                }}
                title={t('drugTable.sendToSimulator', {
                  kind: isMolarUnit(preferredUnit) ? 'molar' : 'mass',
                })}
                className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 font-medium mt-1"
              >
                <FlaskConical className="h-3.5 w-3.5" />
                {t('drugTable.openInSimulator')}
              </button>
            )}
          </div>
        </TableCell>
      )}
      {visibleColumns.has('molecularWeight') && (
        <TableCell className="text-right whitespace-nowrap">
          {drug.molecularWeight ? drug.molecularWeight.toFixed(1) : EMPTY_VALUE}
        </TableCell>
      )}
      {visibleColumns.has('halfLife') && (
        <TableCell className="whitespace-nowrap">
          {formatRange(normalizeRangeInput(drug.halfLife), {
            showNote: false,
            showUnit: false,
          }) || EMPTY_VALUE}
        </TableCell>
      )}
      {visibleColumns.has('volumeOfDistribution') && (
        <TableCell className="whitespace-nowrap">
          {formatRange(normalizeRangeInput(drug.volumeOfDistribution), {
            showNote: false,
            showUnit: false,
          }) || EMPTY_VALUE}
        </TableCell>
      )}
      {visibleColumns.has('bioavailability') && (
        <TableCell className="whitespace-nowrap">
          {formatRange(
            normalizeRangeInput(drug.bioavailability, { asFraction: true }),
            {
              showNote: false,
              showUnit: false,
              asPercent: fractionDisplay === 'percent',
            },
          ) || EMPTY_VALUE}
        </TableCell>
      )}
      {visibleColumns.has('bloodPlasmaRatio') && (
        <TableCell className="whitespace-nowrap">
          {formatRange(normalizeRangeInput(drug.bloodPlasmaRatio), {
            showNote: false,
            showUnit: false,
          }) || EMPTY_VALUE}
        </TableCell>
      )}
      {visibleColumns.has('proteinBinding') && (
        <TableCell className="whitespace-nowrap">
          {formatRange(
            normalizeRangeInput(drug.proteinBinding, { asFraction: true }),
            {
              showNote: false,
              showUnit: false,
              asPercent: fractionDisplay === 'percent',
            },
          ) || EMPTY_VALUE}
        </TableCell>
      )}
      {visibleColumns.has('tmax') && (
        <TableCell className="whitespace-nowrap">
          {formatRange(normalizeRangeInput(drug.tmax), {
            showNote: false,
            showUnit: false,
          }) || EMPTY_VALUE}
        </TableCell>
      )}
      {visibleColumns.has('pKa') && (
        <TableCell className="whitespace-nowrap">
          {formatRange(normalizeRangeInput(drug.pKa), {
            showNote: false,
            showUnit: false,
          }) || EMPTY_VALUE}
        </TableCell>
      )}
      {DRUG_VALUE_PARAMETER_IDS.filter(
        (parameterId) =>
          !BUILT_IN_PARAMETER_COLUMN_IDS.has(parameterId) &&
          visibleColumns.has(parameterId),
      ).map((parameterId) => (
        <TableCell key={parameterId} className="whitespace-nowrap">
          {renderParameterTableValue(drug, parameterId, lang, fractionDisplay)}
        </TableCell>
      ))}
      {visibleColumns.has(REFS_URINE_COLUMN_ID) && (
        <TableCell className="text-xs">{refsUrineLabel ?? EMPTY_VALUE}</TableCell>
      )}
    </TableRow>
  );
}

interface DrugTableProps {
  /** When true, fill the available viewport height / width (used on the home page). */
  fullScreen?: boolean;
}

export function DrugTable({ fullScreen = false }: DrugTableProps = {}) {
  const { t, i18n } = useTranslation();
  const lang = activeLangCode(i18n.language);
  const navigate = useNavigate();
  // Use the user's primary enabled unit as the default display kind for
  // the table's molar/mass column (#306). enabledUnits is always non-empty.
  // Defensively clamp to a simulator-supported unit even if the persisted
  // primary somehow ended up as a per-dL one — the worker silently
  // mis-scales unsupported units (#317 P1 review).
  const enabledUnits = useAppStore((s) => s.enabledUnits);
  const fractionDisplay = useFractionDisplay();
  const preferredUnit: ConcentrationUnit =
    enabledUnits.find((u) => PRIMARY_ELIGIBLE_UNITS.has(u)) ?? 'µmol/L';
  // Default the per-row converter to the user's primary unit on its
  // matching side, and to the first enabled unit of the other kind on
  // the opposite side. Without this the row's molarUnit/massUnit stayed
  // pinned to µmol/L / mg/L, so a user with nmol/L primary launched the
  // simulator with µmol/L unless they manually edited every row (#317
  // review).
  const defaultMolarUnit = isMolarUnit(preferredUnit)
    ? preferredUnit
    : (enabledUnits.find(
        (u) => isMolarUnit(u) && PRIMARY_ELIGIBLE_UNITS.has(u),
      ) ?? 'µmol/L');
  const defaultMassUnit = !isMolarUnit(preferredUnit)
    ? preferredUnit
    : (enabledUnits.find(
        (u) => !isMolarUnit(u) && PRIMARY_ELIGIBLE_UNITS.has(u),
      ) ?? 'mg/L');

  const components = useDrugStore((s) => s.components);
  const methods = useDrugStore((s) => s.methods);
  const searchQuery = useDrugStore((s) => s.searchQuery);
  const selectedMethod = useDrugStore((s) => s.selectedMethod);
  const sortColumn = useDrugStore((s) => s.sortColumn);
  const sortDirection = useDrugStore((s) => s.sortDirection);
  const setComponents = useDrugStore((s) => s.setComponents);
  const setMethods = useDrugStore((s) => s.setMethods);
  const setSearchQuery = useDrugStore((s) => s.setSearchQuery);
  const setSelectedMethod = useDrugStore((s) => s.setSelectedMethod);
  const setSorting = useDrugStore((s) => s.setSorting);
  const toggleSort = useDrugStore((s) => s.toggleSort);
  const setTableView = useDrugStore((s) => s.setTableView);
  const canLoadMethods = useAuthStore((s) =>
    canAccessAnalyticalMethods(s.user, s.permissionOverrides),
  );

  // Search runs server-side (same endpoint as the Ctrl+K palette) so DB-only,
  // low-popularity drugs outside the preloaded catalog are findable here too;
  // `searchResults` is the preloaded catalog when there's no query.
  const { components: searchResults } = useDrugTableSearchResults();

  // The search box matches drug names only, so a method code ("9001") or a
  // method name ("panel") found nothing. Offer the matching methods as
  // one-click filters instead; the already-active one is dropped since
  // re-applying it is a no-op.
  const methodMatches = useMemo(
    () =>
      searchMethods(methods, searchQuery).filter(
        (m) => m.id !== selectedMethod,
      ),
    [methods, searchQuery, selectedMethod],
  );

  // Applying a method clears the text query: it searched drug names, and
  // keeping it would intersect the method's components with a name filter
  // the user only ever typed to reach the method.
  const applyMethodFilter = useCallback(
    (methodId: string) => {
      setSelectedMethod(methodId);
      setSearchQuery('');
    },
    [setSelectedMethod, setSearchQuery],
  );

  const filteredComponents = useMemo(() => {
    let filtered = searchResults;

    if (selectedMethod) {
      const method = methods.find((m) => m.id === selectedMethod);
      if (method) {
        filtered = filtered.filter((c) => methodIncludesDrug(method, c));
      }
    }

    return [...filtered].sort((a, b) => {
      const aRaw = getDrugSortValue(a, sortColumn, lang);
      const bRaw = getDrugSortValue(b, sortColumn, lang);
      const aVal = toSortable(aRaw, sortDirection);
      const bVal = toSortable(bRaw, sortDirection);
      if (aVal === null && bVal === null) return 0;
      if (aVal === null) return 1;
      if (bVal === null) return -1;
      const cmp = compareSortable(aVal, bVal);
      return sortDirection === 'asc' ? cmp : -cmp;
    });
  }, [
    searchResults,
    selectedMethod,
    methods,
    sortColumn,
    sortDirection,
    lang,
  ]);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const tableMeasureRef = useRef<HTMLDivElement>(null);

  const [conversions, setConversions] = useState<
    Record<string, ConversionState>
  >({});
  const [showColumnPicker, setShowColumnPicker] = useState(false);
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(() =>
    loadInitialVisibleColumns(),
  );

  // The laboratory's guideline table, for the gated REFS column. `canAccess` is
  // false for everyone else, and then the column does not exist at all — it is
  // not merely empty, because an empty column reads as "no detection time" for
  // substances the guideline does in fact name.
  const { canAccess: canAccessRefs, matchFor } = useRefsDetectionTimes();

  /**
   * Columns this reader may see. Filtering here rather than at render time
   * keeps the picker, the header row and the width heuristic looking at one
   * list.
   */
  const availableColumns = useMemo(
    () =>
      canAccessRefs
        ? ALL_COLUMNS
        : ALL_COLUMNS.filter((col) => col.id !== REFS_URINE_COLUMN_ID),
    [canAccessRefs],
  );

  const [compactParameterHeaders, setCompactParameterHeaders] = useState(false);

  /**
   * A column axis another surface asked for — the detection-times page's
   * "every substance" link. Applied once and then forgotten, so the reader's
   * own column picker is not overruled on every subsequent render.
   */
  const consumeColumnPreset = useDrugStore((s) => s.consumeColumnPreset);
  const pendingColumnPreset = useDrugStore((s) => s.pendingColumnPreset);
  useEffect(() => {
    if (!pendingColumnPreset) return;
    const preset = consumeColumnPreset();
    if (!preset) return;
    const allowed = new Set(availableColumns.map((col) => col.id));
    const next = preset.filter((id) => allowed.has(id));
    // A preset that survives no filtering at all (every id unknown, or every
    // id gated) would blank the table. Leave the current axis alone instead.
    if (next.length === 0) return;
    setVisibleColumns(new Set(next));
  }, [pendingColumnPreset, consumeColumnPreset, availableColumns]);

  // Centralized row-click navigation. Owns the wiki-slug lookup so the full
  // table and the sidebar variant stay in sync (#298).
  const { select } = useDrugRowSelect();

  const defaultConversion: ConversionState = useMemo(
    () => ({
      sourceValue: '',
      targetValue: '',
      lastEdited: 'source' as const,
      molarUnit: defaultMolarUnit,
      massUnit: defaultMassUnit,
      sourceMatrix: 'blood' as MatrixType,
      targetMatrix: 'blood' as MatrixType,
    }),
    [defaultMolarUnit, defaultMassUnit],
  );

  // Load public catalog data on mount.
  useEffect(() => {
    let mounted = true;
    loadComponents().then((comps) => {
      if (mounted) {
        setComponents(comps);
      }
    });
    return () => {
      mounted = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Analytical methods are admin/group-grant-gated; avoid a guaranteed
  // auth-only API miss for everyone else.
  useEffect(() => {
    if (!canLoadMethods) {
      setMethods([]);
      return;
    }
    let mounted = true;
    loadMethods().then((meths) => {
      if (mounted) setMethods(meths);
    });
    return () => {
      mounted = false;
    };
  }, [canLoadMethods, setMethods]);

  useEffect(() => {
    saveTableColumns([...visibleColumns]);
  }, [visibleColumns]);

  const getConversion = useCallback(
    (drugId: string): ConversionState =>
      conversions[drugId] ?? defaultConversion,
    [conversions, defaultConversion],
  );

  const updateConversion = useCallback(
    (drugId: string, updates: Partial<ConversionState>) => {
      setConversions((prev) => {
        const current = prev[drugId] ?? defaultConversion;
        return { ...prev, [drugId]: { ...current, ...updates } };
      });
    },
    [defaultConversion],
  );

  const handleSendToSimulator = useCallback(
    (drugId: string, value: number, unit: string) => {
      const drug = filteredComponents.find((c) => c.id === drugId);
      if (drug?._dbId) trackDrugInteraction(drug._dbId, 'simulator_open');
      // Same-route launches (already on /simulator, just changing query
      // params) won't trigger the shell's path-based auto-collapse, so
      // the full overlay would otherwise stay on top of the simulator
      // and hide the drug/concentration that was just sent. Collapse
      // explicitly here (#299 review).
      setTableView('sidebar');
      navigate(
        buildSimulatorUrl(drug ? toSimulatorDrugRef(drug) : { id: drugId }, {
          concentration: value,
          concentrationUnit: unit,
        }),
      );
    },
    [filteredComponents, navigate, setTableView],
  );

  // Picking a row in the full table activates the drug AND collapses the
  // global shell to its sidebar view, per issue #298.
  const handleOpenDrug = useCallback(
    (drug: DrugComponent) => {
      void select(drug, { collapseToSidebar: true });
    },
    [select],
  );

  const methodOptions = useMemo(
    () => [
      { value: '', label: t('drugTable.allMethods') },
      // Prefix each method with its method number (the method's `id` is the
      // analytical-method code, e.g. "9001"); `formatMethodLabel` guards
      // against double-prefixing if a name already leads with its number.
      ...methods.map((m) => ({ value: m.id, label: formatMethodLabel(m) })),
    ],
    [methods, t],
  );

  const visibleColumnSpecs = useMemo(
    () => availableColumns.filter((c) => visibleColumns.has(c.id)),
    [availableColumns, visibleColumns],
  );

  /**
   * The columns the header row actually drew, as a set for the body rows.
   *
   * `visibleColumns` is the reader's *stored* selection and can name a column
   * this reader may not see: the column set is persisted per browser, so a
   * granted member who enables the REFS column leaves its id in local storage
   * for whoever signs in next. Filtering the header alone then left the cell
   * behind in every row and shifted the whole table one column out of step with
   * its own headings. Rows and headings now read the same list, by
   * construction rather than by a second check that could be forgotten on the
   * next gated column.
   */
  const renderedColumnIds = useMemo(
    () => new Set(visibleColumnSpecs.map((c) => c.id)),
    [visibleColumnSpecs],
  );

  /**
   * REFS's band per substance, resolved once for the whole catalog rather than
   * per row: matching folds every name a substance is known by against the
   * guideline's index, and doing that inside the render of ~800 rows would be
   * paid again on every keystroke in the filter box.
   *
   * Only built when the column is actually on screen.
   */
  const refsUrineLabels = useMemo(() => {
    const labels = new Map<string, string>();
    if (!canAccessRefs || !visibleColumns.has(REFS_URINE_COLUMN_ID)) {
      return labels;
    }
    // Over the rows actually RENDERED, not the preloaded catalog: the preload
    // is capped by popularity, and a search resolves DB-only substances the
    // store never held. Keyed off `components` those rows showed "—" — an
    // empty cell claiming the guideline is silent about a substance it names.
    for (const drug of filteredComponents) {
      const [primary] = matchFor(drug);
      if (!primary) continue;
      // Scoped to the half the reader arrived through. A row that splits
      // (etanol: parent a day, metabolites a week) must not answer with the
      // wrong half, and a row whose only reading is the parent's states
      // nothing about its metabolite at all.
      const statement = refsStatementForRole(primary.row, primary.role);
      const text = statement
        ? refsStatementText(statement, t)
        : t('detection.refs.splitReading');
      labels.set(
        drugComponentKey(drug),
        primary.role === 'metabolite'
          ? t('detection.refs.viaShort', { parent: primary.row.parent, text })
          : text,
      );
    }
    return labels;
    // `refs` itself is a fresh object every render; its two useful members are
    // memoised, and depending on them is what keeps this off the render path.
  }, [canAccessRefs, matchFor, visibleColumns, filteredComponents, t]);

  useEffect(() => {
    const el = tableMeasureRef.current;
    if (!el) return;

    const update = () => {
      setCompactParameterHeaders(
        shouldUseCompactParameterHeaders(el.clientWidth, visibleColumnSpecs),
      );
    };

    update();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }

    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [visibleColumnSpecs]);

  // Bound the fullScreen container to viewport height minus the sticky app
  // header so the Table's internal overflow-auto becomes the single scroll
  // container and its sticky thead freezes at the top reliably.
  const containerClass = fullScreen
    ? 'flex flex-col w-full p-4 gap-3 min-h-0 overflow-hidden h-[calc(100dvh-var(--app-header-h,57px))]'
    : 'flex flex-col gap-3 p-4 min-h-0';

  return (
    <div className={containerClass}>
      <div className="flex items-center gap-2 text-lg font-semibold">
        <TableIcon className="h-5 w-5" />
        {t('drugTable.title')}
      </div>

      {/* Controls */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            type="search"
            placeholder={t('drugTable.filterPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        {methods.length > 0 && (
          <Select
            aria-label={t('drugTable.allMethods')}
            options={methodOptions}
            value={selectedMethod ?? ''}
            onChange={(e) => setSelectedMethod(e.target.value || null)}
            className="w-[240px]"
          />
        )}
        <Select
          aria-label={t('drugTable.sortBy')}
          options={SORT_OPTIONS.map((s) => ({
            value: s.id,
            label:
              'parameterId' in s
                ? t(`parameters.${s.parameterId}.label`, {
                    defaultValue: s.parameterId,
                  })
                : t(s.labelKey),
          }))}
          value={sortColumn}
          onChange={(e) => {
            const next = e.target.value;
            // Popularity defaults to descending (most-used first); other
            // sorts default to ascending. If the user re-picks the
            // current sort, just flip direction so the dropdown also
            // works as a toggle.
            if (next === sortColumn) {
              setSorting(next, sortDirection === 'asc' ? 'desc' : 'asc');
            } else {
              setSorting(next, next === '_popularityScore' ? 'desc' : 'asc');
            }
          }}
          className="w-[180px]"
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            setSorting(sortColumn, sortDirection === 'asc' ? 'desc' : 'asc')
          }
          aria-label={t(
            sortDirection === 'asc'
              ? 'drugTable.sortDesc'
              : 'drugTable.sortAsc',
          )}
          title={t(
            sortDirection === 'asc'
              ? 'drugTable.sortDesc'
              : 'drugTable.sortAsc',
          )}
        >
          {sortDirection === 'asc' ? '↑' : '↓'}
        </Button>
        <div className="relative">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowColumnPicker(!showColumnPicker)}
          >
            {t('drugTable.columns')}
            <ChevronDown className="h-4 w-4 ml-1" />
          </Button>
          {showColumnPicker && (
            <div className="absolute top-full right-0 mt-1 max-h-96 w-72 overflow-y-auto p-2 bg-card border rounded-lg shadow-lg z-20">
              {availableColumns.map((col) => {
                const key = COLUMN_I18N_KEYS[col.id];
                const label = key
                  ? t(key)
                  : col.parameterId
                    ? t(getParameterLabelKey(col.parameterId), {
                        defaultValue: DRUG_PARAMETERS[col.parameterId].label,
                      })
                    : col.label;
                return (
                  <label key={col.id} className="flex items-center gap-2 p-1">
                    <input
                      type="checkbox"
                      checked={visibleColumns.has(col.id)}
                      onChange={(e) => {
                        const next = new Set(visibleColumns);
                        if (e.target.checked) next.add(col.id);
                        else next.delete(col.id);
                        setVisibleColumns(next);
                        saveTableColumns([...next]);
                      }}
                    />
                    {label}
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Analytical methods matching the search query — one click filters the
          table down to that method's components, so typing a method code
          such as "9001" is a route into the method rather than a dead end. */}
      <MethodSearchMatches
        methods={methodMatches}
        onSelect={applyMethodFilter}
        className="-mt-1"
      />

      {/* Table */}
      <div ref={tableMeasureRef} className="flex-1 min-h-0">
        {/* `table-fixed` makes the declared column widths (e.g. the name
            column's 180px) enforced rather than treated as hints, so a
            long drug name truncates inside its cell instead of stretching
            the column and pushing the conversion controls off-screen (#399). */}
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              {visibleColumnSpecs.map((col) => {
                const i18nKey = COLUMN_I18N_KEYS[col.id];
                // Parameter columns render as a compact symbol + unit on the
                // primary line with the full descriptive name as a smaller,
                // muted second line. The descriptive subtitle is dropped once
                // the visible columns get crowded, leaving just the symbol so
                // headers never collapse into a wall of wrapping text (#709).
                const primaryLabel = col.parameterId
                  ? buildParameterCompactHeaderLabel(col.parameterId, t)
                  : i18nKey
                    ? t(i18nKey)
                    : col.label;
                const subLabel =
                  col.parameterId && !compactParameterHeaders
                    ? t(getParameterLongLabelKey(col.parameterId), {
                        defaultValue: DRUG_PARAMETERS[col.parameterId].longLabel,
                      })
                    : undefined;
                // Full descriptive label backs the tooltip / screen-reader
                // text so the meaning is reachable even when compacted.
                const fullLabel = col.parameterId
                  ? buildParameterHeaderLabel(col.parameterId, t)
                  : undefined;
                const content = col.sortKey ? (
                  <SortableHeader
                    sorted={sortColumn === col.sortKey ? sortDirection : false}
                    onClick={() => toggleSort(col.sortKey as string)}
                    align={col.align === 'right' ? 'right' : 'left'}
                    subLabel={subLabel}
                    ariaLabel={fullLabel}
                    title={fullLabel}
                  >
                    {primaryLabel}
                  </SortableHeader>
                ) : (
                  primaryLabel
                );
                return (
                  <TableHead
                    key={col.id}
                    className={cn('align-top py-2.5', col.headClassName)}
                    aria-label={fullLabel}
                    title={fullLabel}
                  >
                    {content}
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredComponents.map((drug) => (
              <DrugRow
                key={drugComponentKey(drug)}
                drug={drug}
                conversion={getConversion(drug.id)}
                onConversionChange={(updates) =>
                  updateConversion(drug.id, updates)
                }
                visibleColumns={renderedColumnIds}
                refsUrineLabel={refsUrineLabels.get(drugComponentKey(drug)) ?? null}
                preferredUnit={preferredUnit}
                onSendToSimulator={handleSendToSimulator}
                onOpenDrug={handleOpenDrug}
                t={t}
                lang={lang}
                fractionDisplay={fractionDisplay}
              />
            ))}
          </TableBody>
        </Table>
      </div>

      <p className="text-sm text-muted-foreground">
        {t('drugTable.drugsShown', {
          shown: filteredComponents.length,
          total: components.length,
        })}
      </p>
    </div>
  );
}
