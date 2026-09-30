import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  convertBetweenKinds,
  describeRatio,
  getUnitKind,
  molarUnitOptions,
  massUnitOptions,
  matrixOptions,
  type MatrixType,
} from '@/lib/conversions';
import type { DrugComponent, UnitType } from '@/types';

interface DrugInlineConverterProps {
  drug: DrugComponent;
}

/** The converted output evaluated at both ends of a B/P-ratio range. */
interface ConvertedRange {
  lo: number;
  hi: number;
  unit: string;
}

/** Trim floating-point noise from a ratio for display (e.g. 0.55, 0.5, 0.6). */
function formatRatio(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '–';
  return String(Number(value.toFixed(3)));
}

/**
 * Format a converted concentration for the range hint: ~4 significant figures
 * with trailing zeros stripped, so 181.66667 reads as 181.7 and 218 stays 218.
 */
function formatConc(value: number): string {
  if (!Number.isFinite(value)) return '–';
  if (value === 0) return '0';
  return String(Number(value.toPrecision(4)));
}

/**
 * Bidirectional unit converter rendered inline in the drug-name tooltip.
 *
 * Edits in either field flow through `convertBetweenKinds()` immediately —
 * there is no submit button. Each side picks any unit (molar *or* mass), so the
 * converter also handles same-kind conversions across matrices — e.g. blood
 * µmol/L → plasma µmol/L. The unit kind (molar/mass) is inferred from the
 * chosen unit. Defaults match the in-table converter (`µmol/L` blood ↔ `mg/L`
 * blood) so the experience stays consistent across surfaces (#298).
 *
 * When the two matrices differ, the blood/plasma ratio is applied. Because that
 * ratio is often a published range (e.g. 0.5–0.6), only its midpoint can drive
 * a single number — so the midpoint actually used and the underlying range are
 * surfaced below the fields rather than hidden in the maths.
 */
export function DrugInlineConverter({ drug }: DrugInlineConverterProps) {
  const { t } = useTranslation();

  const [sourceValue, setSourceValue] = useState('');
  const [targetValue, setTargetValue] = useState('');
  const [lastEdited, setLastEdited] = useState<'source' | 'target'>('source');
  const [sourceUnit, setSourceUnit] = useState<string>('µmol/L');
  const [targetUnit, setTargetUnit] = useState<string>('mg/L');
  const [sourceMatrix, setSourceMatrix] = useState<MatrixType>('blood');
  const [targetMatrix, setTargetMatrix] = useState<MatrixType>('blood');

  const sourceKind: UnitType = getUnitKind(sourceUnit) ?? 'molar';
  const targetKind: UnitType = getUnitKind(targetUnit) ?? 'mass';

  const drugData = useMemo(
    () => ({
      molecularWeight: drug.molecularWeight ?? 0,
      bloodPlasmaRatio: drug.bloodPlasmaRatio,
    }),
    [drug.molecularWeight, drug.bloodPlasmaRatio],
  );

  const matricesDiffer = sourceMatrix !== targetMatrix;
  const ratio = useMemo(() => describeRatio(drug.bloodPlasmaRatio), [drug.bloodPlasmaRatio]);

  const display = useMemo(() => {
    const empty = { source: '', target: '', range: null as ConvertedRange | null };
    if (!drug.molecularWeight) {
      return { source: sourceValue, target: targetValue, range: null };
    }

    // Run the conversion in whichever direction the user last typed, optionally
    // forcing a specific B/P ratio (used to derive the output range below).
    const editingSource = lastEdited === 'source';
    const inputValue = editingSource ? sourceValue : targetValue;
    const outUnit = editingSource ? targetUnit : sourceUnit;
    if (!inputValue) return empty;

    const convert = (ratioOverride?: number) =>
      convertBetweenKinds(
        inputValue,
        editingSource ? sourceKind : targetKind,
        editingSource ? sourceUnit : targetUnit,
        editingSource ? sourceMatrix : targetMatrix,
        editingSource ? targetKind : sourceKind,
        editingSource ? targetUnit : sourceUnit,
        editingSource ? targetMatrix : sourceMatrix,
        ratioOverride === undefined
          ? drugData
          : { molecularWeight: drug.molecularWeight, bloodPlasmaRatio: ratioOverride },
      );

    const computed = convert();
    const out = computed === '' ? '' : String(computed);

    // When the matrices differ and the B/P ratio is a published range, the
    // single midpoint result hides real uncertainty. Convert the same input at
    // both ends of the ratio so the user sees the corresponding output range.
    let range: ConvertedRange | null = null;
    if (
      matricesDiffer &&
      ratio.isRange &&
      ratio.min !== null &&
      ratio.max !== null &&
      computed !== ''
    ) {
      const a = convert(ratio.min);
      const b = convert(ratio.max);
      if (a !== '' && b !== '') {
        range = {
          lo: Math.min(Number(a), Number(b)),
          hi: Math.max(Number(a), Number(b)),
          unit: outUnit,
        };
      }
    }

    return editingSource
      ? { source: sourceValue, target: out, range }
      : { source: out, target: targetValue, range };
  }, [
    drug.molecularWeight,
    sourceValue,
    targetValue,
    lastEdited,
    sourceKind,
    sourceUnit,
    targetKind,
    targetUnit,
    sourceMatrix,
    targetMatrix,
    matricesDiffer,
    ratio,
    drugData,
  ]);

  // Both selects offer every unit, grouped by kind, so either side can be
  // molar or mass.
  const unitGroups = useMemo(
    () => [
      {
        label: t('drugTable.converter.molarGroup'),
        options: molarUnitOptions.map((u) => ({ value: u, label: u })),
      },
      {
        label: t('drugTable.converter.massGroup'),
        options: massUnitOptions.map((u) => ({ value: u, label: u })),
      },
    ],
    [t],
  );
  const matrixOptionsList = useMemo(
    () =>
      matrixOptions.map((m) => ({
        value: m,
        label: t(m === 'blood' ? 'drugTable.matrix.blood' : 'drugTable.matrix.plasmaSerum'),
      })),
    [t],
  );

  // Drugs without molecular weight cannot pivot mass↔molar at all; surface
  // that to the user instead of silently freezing one column.
  if (!drug.molecularWeight) {
    return (
      <div className="text-xs text-muted-foreground">
        {t('drugTable.converter.noMolecularWeight')}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex items-center gap-2">
        <Input
          type="text"
          inputMode="decimal"
          aria-label={t('drugTable.converter.fromInput')}
          placeholder={sourceUnit}
          value={display.source}
          onChange={(e) => {
            setLastEdited('source');
            setSourceValue(e.target.value);
          }}
          className="w-24 h-9 text-sm px-3"
        />
        <Select
          aria-label={t('drugTable.converter.fromUnit')}
          groups={unitGroups}
          value={sourceUnit}
          onChange={(e) => setSourceUnit(e.target.value)}
          className="w-24 h-9 text-sm px-2 py-0"
        />
        <Select
          aria-label={t('drugTable.converter.fromMatrix')}
          options={matrixOptionsList}
          value={sourceMatrix}
          onChange={(e) => setSourceMatrix(e.target.value as MatrixType)}
          className="w-24 h-9 text-sm px-2 py-0"
        />
      </div>
      <div className="flex items-center gap-2">
        <Input
          type="text"
          inputMode="decimal"
          aria-label={t('drugTable.converter.toInput')}
          placeholder={targetUnit}
          value={display.target}
          onChange={(e) => {
            setLastEdited('target');
            setTargetValue(e.target.value);
          }}
          className="w-24 h-9 text-sm px-3"
        />
        <Select
          aria-label={t('drugTable.converter.toUnit')}
          groups={unitGroups}
          value={targetUnit}
          onChange={(e) => setTargetUnit(e.target.value)}
          className="w-24 h-9 text-sm px-2 py-0"
        />
        <Select
          aria-label={t('drugTable.converter.toMatrix')}
          options={matrixOptionsList}
          value={targetMatrix}
          onChange={(e) => setTargetMatrix(e.target.value as MatrixType)}
          className="w-24 h-9 text-sm px-2 py-0"
        />
      </div>
      {matricesDiffer && (
        <div className="text-xs text-muted-foreground">
          {ratio.defined ? (
            <>
              <div>
                {t('drugTable.converter.ratioApplied', {
                  ratio: formatRatio(ratio.applied),
                })}
              </div>
              {display.range && (
                <div className="text-[11px] opacity-80">
                  {t('drugTable.converter.convertedRange', {
                    min: formatConc(display.range.lo),
                    max: formatConc(display.range.hi),
                    unit: display.range.unit,
                  })}
                </div>
              )}
            </>
          ) : (
            <div>{t('drugTable.converter.ratioAssumed')}</div>
          )}
        </div>
      )}
    </div>
  );
}
