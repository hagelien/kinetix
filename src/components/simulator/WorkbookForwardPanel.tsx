import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { EtohParityInput } from '@/lib/etohWorkbookFlows';
import {
  DEFAULT_FORWARD_ELIMINATION_HIGH,
  DEFAULT_FORWARD_ELIMINATION_LIKELY,
  DEFAULT_FORWARD_ELIMINATION_LOW,
  evaluateEtohForwardFlowsV3,
  type EtohForwardInput,
} from '@/lib/etohForwardFlowsV3';
import {
  DEFAULT_FIRST_PASS_HIGH_PERCENT,
  SEX_FEMALE,
  SEX_MALE,
  type SexEnum,
} from '@/lib/etohWorkbookFlowsV3';

interface Props {
  inputs: EtohParityInput;
}

/**
 * Map the persisted v1-shape store input to the forward-engine's input.
 *
 * Conflates `drinkStopTime` from the back-calc store with the forward
 * engine's `drinkStartTime`: in practice users compute back- and
 * forward-projection separately, and the field is semantically "when was
 * the alcohol consumed". A future PR can split these once the store grows
 * a dedicated `drinkStartTime` field.
 *
 * Drink volumes scale from the store's mL to the engine's dL (Phase G).
 * `firstPassHighPercent` and the three forward elimination rates use the
 * workbook defaults until the panel grows controls for them.
 */
function promoteToForward(input: EtohParityInput): EtohForwardInput {
  const sexEnum: SexEnum = input.sexMale01 === 1 ? SEX_MALE : SEX_FEMALE;
  const drinksDl: [number, number, number, number, number, number] = [
    input.drinksMl[0] / 100,
    input.drinksMl[1] / 100,
    input.drinksMl[2] / 100,
    input.drinksMl[3] / 100,
    input.drinksMl[4] / 100,
    input.drinksMl[5] / 100,
  ];
  return {
    drinkStartTime: input.drinkStopTime,
    eventTime: input.eventTime,
    drinksDl,
    drinksAbvPercent: input.drinksAbvPercent,
    firstPassMinPercent: input.firstPassMinPercent,
    firstPassLikelyPercent: input.firstPassLikelyPercent,
    firstPassHighPercent: DEFAULT_FIRST_PASS_HIGH_PERCENT,
    weightKg: input.weightKg,
    heightCm: input.heightCm,
    widmarkR: input.widmarkR,
    sexEnum,
    ageYears: input.ageYears,
    forwardEliminationHigh: DEFAULT_FORWARD_ELIMINATION_HIGH,
    forwardEliminationLikely: DEFAULT_FORWARD_ELIMINATION_LIKELY,
    forwardEliminationLow: DEFAULT_FORWARD_ELIMINATION_LOW,
  };
}

function fmt(value: number, fractionDigits = 2): string {
  if (!Number.isFinite(value)) return '#ERR';
  return value.toLocaleString('nb-NO', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

export function WorkbookForwardPanel({ inputs }: Props) {
  const { t } = useTranslation();
  const forwardInput = useMemo(() => promoteToForward(inputs), [inputs]);
  const outputs = useMemo(() => evaluateEtohForwardFlowsV3(forwardInput), [forwardInput]);

  return (
    <Card data-testid="workbook-forward-panel">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{t('ethanol.forwardPanel.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="text-xs text-muted-foreground">
          {t('ethanol.forwardPanel.description', { hours: fmt(outputs.forwardHours, 2) })}
        </div>

        <section
          aria-label={t('ethanol.forwardPanel.theoreticalSection')}
          data-testid="forward-theoretical"
          className="grid grid-cols-1 md:grid-cols-2 gap-2 border-t border-border pt-3 text-sm"
        >
          <div className="md:col-span-2 text-xs font-medium text-muted-foreground">
            {t('ethanol.forwardPanel.theoreticalSection')}
          </div>
          <Output
            label={t('ethanol.forwardPanel.theoreticalHigh')}
            value={outputs.theoreticalHighPromille}
          />
          <Output
            label={t('ethanol.forwardPanel.theoreticalLikely')}
            value={outputs.theoreticalLikelyPromille}
          />
          <Output
            label={t('ethanol.forwardPanel.theoreticalLow')}
            value={outputs.theoreticalLowPromille}
          />
          <Output
            label={t('ethanol.forwardPanel.theoreticalHighWattson')}
            value={outputs.theoreticalHighPromilleWattson}
          />
          <Output
            label={t('ethanol.forwardPanel.theoreticalLikelyWattson')}
            value={outputs.theoreticalLikelyPromilleWattson}
          />
          <Output
            label={t('ethanol.forwardPanel.theoreticalLowWattson')}
            value={outputs.theoreticalLowPromilleWattson}
          />
        </section>

        <section
          aria-label={t('ethanol.forwardPanel.projectedSection')}
          data-testid="forward-projected"
          className="grid grid-cols-1 md:grid-cols-2 gap-2 border-t border-border pt-3 text-sm"
        >
          <div className="md:col-span-2 text-xs font-medium text-muted-foreground">
            {t('ethanol.forwardPanel.projectedSection')}
          </div>
          <Output
            label={t('ethanol.forwardPanel.forwardHigh')}
            value={outputs.forwardHighPromille}
          />
          <Output
            label={t('ethanol.forwardPanel.forwardLikely')}
            value={outputs.forwardLikelyPromille}
          />
          <Output
            label={t('ethanol.forwardPanel.forwardLow')}
            value={outputs.forwardLowPromille}
          />
          <Output
            label={t('ethanol.forwardPanel.forwardHighWattson')}
            value={outputs.forwardHighPromilleWattson}
          />
          <Output
            label={t('ethanol.forwardPanel.forwardLikelyWattson')}
            value={outputs.forwardLikelyPromilleWattson}
          />
          <Output
            label={t('ethanol.forwardPanel.forwardLowWattson')}
            value={outputs.forwardLowPromilleWattson}
          />
        </section>
      </CardContent>
    </Card>
  );
}

function Output({
  label,
  value,
  digits = 2,
}: {
  label: string;
  value: number;
  digits?: number;
}) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{fmt(value, digits)}</span>
    </div>
  );
}
