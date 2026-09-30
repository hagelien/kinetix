import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { parseLocaleNumber } from "@/lib/parseNumber";
import type { EtohParityInput } from "@/lib/etohWorkbookFlows";
import {
  DEFAULT_ABSORPTION_HIGH_HOURS,
  DEFAULT_ELIMINATION_HIGH,
  DEFAULT_ELIMINATION_LOW_BAC,
  DEFAULT_FIRST_PASS_HIGH_PERCENT,
  SEX_FEMALE,
  SEX_MALE,
  evaluateEtohWorkbookFlowsV3,
  type EtohV3ParityInput,
  type SexEnum,
} from "@/lib/etohWorkbookFlowsV3";

interface Props {
  inputs: EtohParityInput;
  onChange: (updates: Partial<EtohParityInput>) => void;
  onChangeDrink: (idx: number, field: "ml" | "abv", value: number) => void;
}

/**
 * Adapt the persisted v1-shape store input into the v3 engine's input shape.
 * v3-only fields (`eliminationLowBac`, `eliminationHigh`, `absorptionHighHours`,
 * `firstPassHighPercent`) use the workbook defaults until the panel grows
 * controls for them. `sexMale01` (0/1) maps to `sexEnum` (1/2). `drinksMl`
 * scales to `drinksDl` (Phase G).
 */
function promoteToV3(input: EtohParityInput): EtohV3ParityInput {
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
    drinkStopTime: input.drinkStopTime,
    eventTime: input.eventTime,
    sampleTime: input.sampleTime,
    detectedPromille: input.detectedPromille,
    eliminationMin: input.eliminationMin,
    eliminationLikely: input.eliminationLikely,
    eliminationHigh: DEFAULT_ELIMINATION_HIGH,
    eliminationLowBac: DEFAULT_ELIMINATION_LOW_BAC,
    absorptionMinHours: input.absorptionMinHours,
    absorptionLikelyHours: input.absorptionLikelyHours,
    absorptionHighHours: DEFAULT_ABSORPTION_HIGH_HOURS,
    drinksDl,
    drinksAbvPercent: input.drinksAbvPercent,
    firstPassMinPercent: input.firstPassMinPercent,
    firstPassLikelyPercent: input.firstPassLikelyPercent,
    firstPassHighPercent: DEFAULT_FIRST_PASS_HIGH_PERCENT,
    weightKg: input.weightKg,
    widmarkR: input.widmarkR,
    sexEnum,
    heightCm: input.heightCm,
    ageYears: input.ageYears,
  };
}

function timeFractionToHHMM(fraction: number): string {
  const minutes = Math.round(fraction * 24 * 60);
  const wrapped = ((minutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const hh = Math.floor(wrapped / 60)
    .toString()
    .padStart(2, "0");
  const mm = (wrapped % 60).toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

function hhmmToTimeFraction(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return (h * 60 + m) / (24 * 60);
}

function fmt(value: number | null, fractionDigits = 2): string {
  if (value === null || value === undefined) return "—";
  if (!Number.isFinite(value)) return "#ERR";
  return value.toLocaleString("nb-NO", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

function deltaHours(end: number, start: number): number {
  return (end - start + (end < start ? 1 : 0)) * 24;
}

function workbookBmi(weightKg: number, heightCm: number): number {
  const raw =
    weightKg > 0 && heightCm > 0 ? weightKg / (heightCm / 100) ** 2 : 0;
  return Math.round(raw * 10) / 10;
}

function bmiCategoryKey(bmi: number): string {
  if (bmi >= 40) return "verySevereObesity";
  if (bmi >= 35) return "severeObesity";
  if (bmi >= 30) return "obesity";
  if (bmi > 25) return "overweight";
  if (bmi >= 18.5) return "normalWeight";
  return "underweight";
}

export function WorkbookBackcalcPanel({
  inputs,
  onChange,
  onChangeDrink,
}: Props) {
  const { t, i18n } = useTranslation();
  const v3Input = useMemo(() => promoteToV3(inputs), [inputs]);
  const outputs = useMemo(
    () => evaluateEtohWorkbookFlowsV3(v3Input),
    [v3Input],
  );
  const bmi = useMemo(
    () => workbookBmi(inputs.weightKg, inputs.heightCm),
    [inputs.heightCm, inputs.weightKg],
  );
  const bmiCategory = t(
    `ethanol.workbookPanel.bmiCategories.${bmiCategoryKey(bmi)}`,
  );
  const secondSampleTime = inputs.secondSampleTime ?? null;
  const secondSamplePromille = inputs.secondSamplePromille ?? 0;
  const secondSampleOverThreshold = secondSamplePromille > 0.2;
  const secondSampleFalling = inputs.detectedPromille > secondSamplePromille;
  const secondSampleMinutes =
    secondSampleTime === null
      ? null
      : Math.round(deltaHours(secondSampleTime, inputs.sampleTime) * 60);
  const conclusion = buildConclusionText();

  const warnings: string[] = [];
  if (inputs.detectedPromille > 0 && inputs.detectedPromille < 0.2) {
    warnings.push(t("ethanol.workbookPanel.warnings.sub02"));
  }
  if (inputs.eliminationMin !== 0.1) {
    warnings.push(t("ethanol.workbookPanel.warnings.eliminationMin"));
  }
  if (inputs.eliminationLikely !== 0.15) {
    warnings.push(t("ethanol.workbookPanel.warnings.eliminationLikely"));
  }
  if (secondSamplePromille > 0 && !secondSampleFalling) {
    warnings.push(t("ethanol.workbookPanel.warnings.notFallingBetweenSamples"));
  }

  return (
    <Card data-testid="workbook-backcalc-panel">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          {t("ethanol.workbookPanel.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <TimeField
            label={t("ethanol.workbookPanel.drinkStopTime")}
            value={inputs.drinkStopTime}
            onChange={(v) => onChange({ drinkStopTime: v })}
          />
          <TimeField
            label={t("ethanol.workbookPanel.eventTime")}
            value={inputs.eventTime}
            onChange={(v) => onChange({ eventTime: v })}
          />
          <TimeField
            label={t("ethanol.workbookPanel.sampleTime")}
            value={inputs.sampleTime}
            onChange={(v) => onChange({ sampleTime: v })}
          />
          <NumberField
            label={t("ethanol.workbookPanel.detectedPromille")}
            step="0.01"
            value={inputs.detectedPromille}
            onChange={(v) => onChange({ detectedPromille: v })}
          />
          <NumberField
            label={t("ethanol.workbookPanel.eliminationMin")}
            step="0.01"
            value={inputs.eliminationMin}
            onChange={(v) => onChange({ eliminationMin: v })}
          />
          <NumberField
            label={t("ethanol.workbookPanel.eliminationLikely")}
            step="0.01"
            value={inputs.eliminationLikely}
            onChange={(v) => onChange({ eliminationLikely: v })}
          />
          <NumberField
            label={t("ethanol.workbookPanel.absorptionMin")}
            step="0.5"
            value={inputs.absorptionMinHours}
            onChange={(v) => onChange({ absorptionMinHours: v })}
          />
          <NumberField
            label={t("ethanol.workbookPanel.absorptionLikely")}
            step="0.5"
            value={inputs.absorptionLikelyHours}
            onChange={(v) => onChange({ absorptionLikelyHours: v })}
          />
        </div>

        <section
          aria-label={t("ethanol.workbookPanel.secondSampleSection")}
          data-testid="workbook-second-sample"
          className="grid grid-cols-1 md:grid-cols-4 gap-3 border-t border-border pt-3 text-sm"
        >
          <OptionalTimeField
            label={t("ethanol.workbookPanel.secondSampleTime")}
            value={secondSampleTime}
            onChange={(v) => onChange({ secondSampleTime: v })}
          />
          <NumberField
            label={t("ethanol.workbookPanel.secondSamplePromille")}
            step="0.01"
            value={secondSamplePromille}
            onChange={(v) => onChange({ secondSamplePromille: v })}
          />
          <OutputText
            label={t("ethanol.workbookPanel.secondSampleOverThreshold")}
            value={
              secondSampleOverThreshold
                ? t("ethanol.workbookPanel.yes")
                : t("ethanol.workbookPanel.no")
            }
          />
          <OutputText
            label={t("ethanol.workbookPanel.secondSampleFalling")}
            value={
              secondSamplePromille > 0 && secondSampleFalling
                ? t("ethanol.workbookPanel.yes")
                : t("ethanol.workbookPanel.no")
            }
          />
          {secondSampleMinutes !== null && (
            <OutputText
              label={t("ethanol.workbookPanel.secondSampleMinutes")}
              value={t("ethanol.workbookPanel.minutes", {
                count: secondSampleMinutes,
              })}
            />
          )}
        </section>

        <div>
          <div className="text-xs font-medium text-muted-foreground mb-2">
            {t("ethanol.workbookPanel.drinks")}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {inputs.drinksMl.map((ml, i) => {
              const drinkLabel = t("ethanol.workbookPanel.drink", { n: i + 1 });
              return (
                <div key={i} className="grid grid-cols-12 gap-2 items-end">
                  <div className="col-span-3 text-xs text-muted-foreground pb-2">
                    {drinkLabel}
                  </div>
                  <label className="col-span-4 block">
                    <span className="text-[10px] text-muted-foreground mb-1 block">
                      {t("ethanol.workbookPanel.drinkVolume", {
                        drink: drinkLabel,
                      })}
                    </span>
                    <Input
                      aria-label={t("ethanol.workbookPanel.drinkVolume", {
                        drink: drinkLabel,
                      })}
                      type="text"
                      inputMode="decimal"
                      value={ml}
                      onChange={(e) => {
                        const v = parseLocaleNumber(e.target.value);
                        if (Number.isFinite(v)) onChangeDrink(i, "ml", v);
                      }}
                    />
                  </label>
                  <label className="col-span-4 block">
                    <span className="text-[10px] text-muted-foreground mb-1 block">
                      {t("ethanol.workbookPanel.drinkAbv", {
                        drink: drinkLabel,
                      })}
                    </span>
                    <Input
                      aria-label={t("ethanol.workbookPanel.drinkAbv", {
                        drink: drinkLabel,
                      })}
                      type="text"
                      inputMode="decimal"
                      value={inputs.drinksAbvPercent[i]}
                      onChange={(e) => {
                        const v = parseLocaleNumber(e.target.value);
                        if (Number.isFinite(v)) onChangeDrink(i, "abv", v);
                      }}
                    />
                  </label>
                </div>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <NumberField
            label={t("ethanol.workbookPanel.firstPassMin")}
            step="1"
            value={inputs.firstPassMinPercent}
            onChange={(v) => onChange({ firstPassMinPercent: v })}
          />
          <NumberField
            label={t("ethanol.workbookPanel.firstPassLikely")}
            step="1"
            value={inputs.firstPassLikelyPercent}
            onChange={(v) => onChange({ firstPassLikelyPercent: v })}
          />
          <NumberField
            label={t("ethanol.workbookPanel.weight")}
            step="0.1"
            min={1}
            value={inputs.weightKg}
            onChange={(v) => onChange({ weightKg: v })}
          />
          <NumberField
            label={t("ethanol.workbookPanel.widmarkR")}
            step="0.01"
            min={0.01}
            value={inputs.widmarkR}
            onChange={(v) => onChange({ widmarkR: v })}
          />
          <label className="block">
            <span className="text-xs text-muted-foreground mb-1 block">
              {t("ethanol.workbookPanel.sex")}
            </span>
            <select
              aria-label={t("ethanol.workbookPanel.sex")}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={inputs.sexMale01}
              onChange={(e) =>
                onChange({ sexMale01: Number(e.target.value) === 1 ? 1 : 0 })
              }
            >
              <option value={1}>{t("ethanol.workbookPanel.male")}</option>
              <option value={0}>{t("ethanol.workbookPanel.female")}</option>
            </select>
          </label>
          <NumberField
            label={t("ethanol.workbookPanel.height")}
            step="1"
            value={inputs.heightCm}
            onChange={(v) => onChange({ heightCm: v })}
          />
          <NumberField
            label={t("ethanol.workbookPanel.age")}
            step="1"
            value={inputs.ageYears}
            onChange={(v) => onChange({ ageYears: v })}
          />
        </div>

        <section
          aria-label={t("ethanol.workbookPanel.bmiSection")}
          data-testid="workbook-bmi"
          className="grid grid-cols-1 md:grid-cols-2 gap-2 border-t border-border pt-3 text-sm"
        >
          <Output
            label={t("ethanol.workbookPanel.bmi")}
            value={bmi}
            digits={1}
          />
          <OutputText
            label={t("ethanol.workbookPanel.bmiCategory")}
            value={bmiCategory}
          />
        </section>

        {conclusion && (
          <section
            aria-label={t("ethanol.workbookPanel.conclusionSection")}
            data-testid="workbook-conclusion"
            className="border-t border-border pt-3 text-sm"
          >
            <div className="text-xs font-medium text-muted-foreground mb-1">
              {t("ethanol.workbookPanel.conclusionSection")}
            </div>
            <p className="leading-relaxed">{conclusion}</p>
          </section>
        )}

        <section
          aria-label={t("ethanol.workbookPanel.outputsManualSection")}
          data-testid="workbook-outputs"
          className="grid grid-cols-1 md:grid-cols-2 gap-2 border-t border-border pt-3 text-sm"
        >
          <Output
            label={t("ethanol.workbookPanel.backcalcMin")}
            value={outputs.backcalcMinPromille}
          />
          <Output
            label={t("ethanol.workbookPanel.backcalcLikely")}
            value={outputs.backcalcLikelyPromille}
          />
          <Output
            label={t("ethanol.workbookPanel.backcalcHigh")}
            value={outputs.backcalcHighPromille}
          />
          <Output
            label={t("ethanol.workbookPanel.ethanolGrams")}
            value={outputs.ethanolGrams}
          />
          <Output
            label={t("ethanol.workbookPanel.afterIntakeMax")}
            value={outputs.afterIntakeMaxPromille}
          />
          <Output
            label={t("ethanol.workbookPanel.afterIntakeLikely")}
            value={outputs.afterIntakeLikelyPromille}
          />
          <Output
            label={t("ethanol.workbookPanel.afterIntakeMin")}
            value={outputs.afterIntakeMinPromille}
          />
          <Output
            label={t("ethanol.workbookPanel.backcalcMinusIntakeMin")}
            value={outputs.afterIntakeBackcalcMinPromille}
          />
          <Output
            label={t("ethanol.workbookPanel.backcalcMinusIntakeLikely")}
            value={outputs.afterIntakeBackcalcLikelyPromille}
          />
          <Output
            label={t("ethanol.workbookPanel.backcalcMinusIntakeHigh")}
            value={outputs.afterIntakeBackcalcHighPromille}
          />
        </section>

        <section
          aria-label={t("ethanol.workbookPanel.outputsWattsonSection")}
          data-testid="workbook-outputs-wattson"
          className="grid grid-cols-1 md:grid-cols-2 gap-2 border-t border-border pt-3 text-sm"
        >
          <div className="md:col-span-2 text-xs font-medium text-muted-foreground">
            {t("ethanol.workbookPanel.wattsonHeading")}
          </div>
          <Output
            label={t("ethanol.workbookPanel.wattsonR")}
            value={outputs.wattsonR}
            digits={2}
          />
          <Output
            label={t("ethanol.workbookPanel.afterIntakeMaxWattson")}
            value={outputs.afterIntakeMaxPromilleWattson}
          />
          <Output
            label={t("ethanol.workbookPanel.afterIntakeLikelyWattson")}
            value={outputs.afterIntakeLikelyPromilleWattson}
          />
          <Output
            label={t("ethanol.workbookPanel.afterIntakeMinWattson")}
            value={outputs.afterIntakeMinPromilleWattson}
          />
          <Output
            label={t("ethanol.workbookPanel.backcalcMinusIntakeMinWattson")}
            value={outputs.afterIntakeBackcalcMinPromilleWattson}
          />
          <Output
            label={t("ethanol.workbookPanel.backcalcMinusIntakeLikelyWattson")}
            value={outputs.afterIntakeBackcalcLikelyPromilleWattson}
          />
          <Output
            label={t("ethanol.workbookPanel.backcalcMinusIntakeHighWattson")}
            value={outputs.afterIntakeBackcalcHighPromilleWattson}
          />
        </section>

        {warnings.length > 0 && (
          <div className="border-l-4 border-accent bg-accent/10 p-3 text-sm space-y-1">
            {warnings.map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );

  function TimeField({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: number;
    onChange: (next: number) => void;
  }) {
    return (
      <label className="block">
        <span className="text-xs text-muted-foreground mb-1 block">
          {label}
        </span>
        <Input
          aria-label={label}
          type="time"
          value={timeFractionToHHMM(value)}
          onChange={(e) => {
            const next = hhmmToTimeFraction(e.target.value);
            if (next !== null) onChange(next);
          }}
        />
      </label>
    );
  }

  function OptionalTimeField({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: number | null;
    onChange: (next: number | null) => void;
  }) {
    return (
      <label className="block">
        <span className="text-xs text-muted-foreground mb-1 block">
          {label}
        </span>
        <Input
          aria-label={label}
          type="time"
          value={value === null ? "" : timeFractionToHHMM(value)}
          onChange={(e) => {
            if (e.target.value === "") {
              onChange(null);
              return;
            }
            const next = hhmmToTimeFraction(e.target.value);
            if (next !== null) onChange(next);
          }}
        />
      </label>
    );
  }

  function NumberField({
    label,
    value,
    onChange,
    step,
    min,
  }: {
    label: string;
    value: number;
    onChange: (next: number) => void;
    step?: string;
    min?: number;
  }) {
    // Step/min retained as visual hints only — using type="text" so commas
    // can be typed as decimal separators on Norwegian keyboards.
    void step;
    void min;
    return (
      <label className="block">
        <span className="text-xs text-muted-foreground mb-1 block">
          {label}
        </span>
        <Input
          aria-label={label}
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(e) => {
            const v = parseLocaleNumber(e.target.value);
            if (Number.isFinite(v)) onChange(v);
          }}
        />
      </label>
    );
  }

  function Output({
    label,
    value,
    digits = 2,
  }: {
    label: string;
    value: number | null;
    digits?: number;
  }) {
    return (
      <div className="flex justify-between gap-2">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">{fmt(value, digits)}</span>
      </div>
    );
  }

  function OutputText({ label, value }: { label: string; value: string }) {
    return (
      <div className="flex justify-between gap-2">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium text-right">{value}</span>
      </div>
    );
  }

  function buildConclusionText(): string {
    if (inputs.detectedPromille <= 0) return "";
    const afterIntakeMin = outputs.afterIntakeBackcalcMinPromille;
    if (
      outputs.ethanolGrams > 0 &&
      afterIntakeMin !== null &&
      afterIntakeMin < 0.1
    ) {
      return t("ethanol.workbookPanel.conclusionAllExplained");
    }

    const eventAfterDrinkHours = deltaHours(
      inputs.eventTime,
      inputs.drinkStopTime,
    );
    const laterAlcoholClause =
      eventAfterDrinkHours < inputs.absorptionMinHours ||
      eventAfterDrinkHours < inputs.absorptionLikelyHours
        ? t("ethanol.workbookPanel.laterAlcoholClause")
        : "";
    const subject =
      inputs.sexMale01 === 1
        ? t("ethanol.workbookPanel.subjectMale")
        : t("ethanol.workbookPanel.subjectFemale");
    const values = {
      subject,
      time: timeFractionToHHMM(inputs.eventTime),
      laterAlcoholClause,
      min: formatRounded(outputs.backcalcMinPromille, 2),
      likely: formatRounded(outputs.backcalcLikelyPromille, 1),
    };

    if (
      outputs.ethanolGrams > 0 &&
      afterIntakeMin !== null &&
      afterIntakeMin >= 0.1
    ) {
      return t("ethanol.workbookPanel.conclusionAfterIntake", {
        ...values,
        min: formatRounded(afterIntakeMin, 2),
        likely: formatRounded(
          outputs.afterIntakeBackcalcLikelyPromille ?? 0,
          1,
        ),
      });
    }

    return t("ethanol.workbookPanel.conclusionPlain", values);
  }

  function formatRounded(value: number, digits: number): string {
    const factor = 10 ** digits;
    const rounded = Math.round(value * factor) / factor;
    const locale = i18n.language?.startsWith("en") ? "en-US" : "nb-NO";
    return rounded.toLocaleString(locale, {
      maximumFractionDigits: digits,
    });
  }
}
