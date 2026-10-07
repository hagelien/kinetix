# Display precision for concentrations and doses

## Status

Proposed Kinetix-wide formatting policy.

## Decision summary

Kinetix should use **three significant figures** as the default for derived concentrations and doses, rather than a fixed number of decimal places.

Source-reported and measured quantities should retain their reported precision. Full numeric precision must be preserved internally, in calculations, and in machine-readable exports. Rounding is a presentation operation only.

This policy provides approximately 1% visual resolution across the relevant magnitude range without implying unrealistic pharmacological, analytical, or model precision.

## Why fixed decimal places do not work

Kinetix contains concentration values spanning many orders of magnitude:

- Buprenorphine: 2–10 nmol/L
- Fentanyl: ≤10 nmol/L
- Amphetamine: 100–800 nmol/L
- Methylphenidate: 1,000–4,000 nmol/L
- Phenytoin: 40–80 µmol/L
- Valproate: 300–700 µmol/L
- Lithium: 0.5–1.0 mmol/L

The reference ranges are stored in clinically sensible units in
`resources/referanseomrader_diakonhjemmet_serum.csv`.

After conversion to mg/L, the same ranges span from less than 0.001 mg/L to more than 100 mg/L:

| Drug | Converted value or range | Recommended derived display |
|---|---:|---:|
| Buprenorphine | 0.0009352–0.004676 mg/L | 0.000935–0.00468 mg/L |
| Fentanyl | ≤0.0033647 mg/L | ≤0.00336 mg/L |
| Amphetamine | 0.013521–0.108168 mg/L | 0.0135–0.108 mg/L |
| Methylphenidate | 0.23331–0.93324 mg/L | 0.233–0.933 mg/L |
| Diazepam | ≤0.99659 mg/L | ≤0.997 mg/L |
| Phenytoin | 10.0908–20.1816 mg/L | 10.1–20.2 mg/L |
| Valproate | 43.263–100.947 mg/L | 43.3–101 mg/L |
| Lithium | 3.47–6.94 mg/L | 3.47–6.94 mg/L |

A rule such as “always show three decimal places” would therefore either erase small but meaningful values or display excessive precision for larger values.

## Current repository behavior

Formatting currently varies between surfaces:

- `src/lib/rangeUtils.ts` provides `formatWithMaxDecimals(value, 3)`. For values greater than or equal to 1, it keeps decimals only up to three significant figures (`43.263` → `43.3`, `100.947` → `101`), but never rounds the integer part (`43 263` stays `43 263`); it is used for stored, possibly source-reported values. Computed values — unit conversions, simulator estimates and their plain-text export — use `formatSignificant`, which applies the full three-significant-figure rule including integer places (`43 263` → `43 300`). The authored-unit row of a unit-conversion tooltip keeps the source's own digits.
- `src/components/drug-table/DrugInlineConverter.tsx` uses four significant figures for its range hint.
- `src/lib/compute/report.ts` uses a separate magnitude-dependent formatter: exponential notation below 0.01, three decimals below 1, two decimals below 100, and integers above 100.
- `src/components/admin/ReferenceConcentrationsAdminSection.tsx` displays raw JavaScript numbers and cannot retain source formatting such as `1.0`.
- Simulator results, plain-text exports, range displays, and unit tooltips generally call `formatWithMaxDecimals`, but not all surfaces use it in the same way.

A central quantity-formatting policy should replace these divergent implementations.

## Rule set

### 1. Preserve full precision internally

Do not round values when:

- storing numeric values;
- converting between units;
- positioning graph data;
- comparing a result with a therapeutic, toxic, fatal, analytical, or statutory threshold;
- performing subsequent calculations;
- serializing machine-readable results.

Rounding must occur only when producing human-readable output.

### 2. Use three significant figures for derived quantities

Use three significant figures for:

- unit conversions;
- simulator estimates;
- posterior medians and interval endpoints;
- back-calculated doses;
- calculated concentrations;
- graph ticks and tooltips;
- derived values in reports and exports.

Three significant figures have a worst-case relative rounding error of approximately 0.5%. Values differing by more than approximately 1% therefore remain visually distinguishable. Two significant figures permit errors approaching 5%, while four significant figures will often imply more certainty than the underlying pharmacokinetic, toxicological, or analytical evidence supports.

For three significant figures, the ordinary decimal-place equivalents are:

| Absolute value | Displayed decimal places |
|---:|---:|
| 100–999 | 0 |
| 10–99.9 | 1 |
| 1–9.99 | 2 |
| 0.1–0.999 | 3 |
| 0.01–0.0999 | 4 |
| 0.001–0.00999 | 5 |
| 0.0001–0.000999 | 6 |

Values of 1,000 or more must also be rounded at the appropriate integer position. For example, `43 263` should become `43 300`, not `43 263`.

The general rounding quantum is:

```text
quantum = 10^(floor(log10(abs(value))) - significantFigures + 1)
```

With three significant figures:

```text
quantum = 10^(floor(log10(abs(value))) - 2)
```

### 3. Preserve source-reported precision

Do not automatically replace source precision with the three-significant-figure policy for:

- measured laboratory results;
- published therapeutic, toxic, impairment, or fatal ranges;
- administered or prescribed doses;
- LOD and LOQ;
- method-defined cutoffs;
- statutory thresholds.

If a source reports `0.5–1.0 mmol/L`, Kinetix should retain `1.0` rather than displaying `1`. A trailing zero can communicate the resolution used by the source or laboratory.

The existing numeric model cannot distinguish source strings such as `1`, `1.0`, and `1.00`. Kinetix should therefore support optional precision metadata, for example:

```ts
interface NumericPrecision {
  mode: 'source' | 'derived';
  decimals?: number;
  significantFigures?: number;
}
```

Ranges may require separate source precision for each endpoint.

If precision metadata is unavailable:

1. Do not pad source values with invented trailing zeros.
2. Do not display more than three significant figures by default.
3. Preserve the submitted text while a user is actively editing a numeric field.

### 4. Dose display

For authored, prescribed, administered, or observed doses, retain the source precision:

- `25 µg`
- `0.25 mg`
- `2.5 mg`
- `12.5 mg`
- `250 mg`
- `1 g`

For inferred or converted doses, use three significant figures.

When no clinically conventional source unit must be preserved, choose `µg`, `mg`, or `g` so the displayed value is normally between approximately 0.1 and 999. Do not silently replace the unit used by a cited source in the primary source display; alternative-unit conversions may be shown separately.

### 5. Narrow therapeutic windows

A narrow therapeutic window does not by itself justify displaying four or five significant figures. Additional digits can create false precision when biological variation, preanalytical factors, analytical uncertainty, sampling time, and model uncertainty are materially larger.

Instead:

- preserve the laboratory’s reported precision;
- compare thresholds using unrounded values;
- show uncertainty where it is available;
- if a derived value and a nearby threshold become identical after three-significant-figure rounding, allow one additional significant figure for disambiguation;
- if their difference is smaller than relevant measurement or model uncertainty, label the result as approximately at the threshold rather than manufacturing a precise distinction.

Interpretive categories must never be determined from the rounded display string.

### 6. Ranges and one-sided limits

Use an en dash without spaces for ordinary stored ranges:

```text
0.303–3.60 mg/L
```

Use the appropriate inequality for one-sided limits:

```text
≤0.997 mg/L
≥10.0 ng/mL
```

For derived ranges, format each endpoint independently to three significant figures. Do not force both endpoints to have the same number of decimal places when they differ substantially in magnitude.

For source ranges, retain the source precision of each endpoint when known.

A missing lower bound must remain a missing bound. In particular, the Diakonhjemmet CSV convention in which `Lav = 0` means “no specified lower bound” should continue to produce `≤high`, not `0–high`.

### 7. Unit selection

Do not use unit conversion merely to hide a precision problem. Preserve conventional clinical and forensic units where they aid recognition and comparison.

For derived results:

1. Prefer the user-selected display unit.
2. Otherwise retain the authored or model unit when it produces a readable value.
3. If necessary, choose an equivalent unit that avoids an excessive number of leading or trailing zeros.
4. Keep the original value and unit accessible in the conversion tooltip.

### 8. Scientific notation

Prefer a more suitable supported unit before using scientific notation.

Use scientific or engineering notation only when:

- no supported unit avoids more than approximately six leading zeros;
- the value is exceptionally large;
- the context is explicitly scientific or computational; or
- a table would otherwise become difficult to read.

Scientific notation should not be the normal presentation for therapeutic concentrations or doses.

### 9. Locale and grouping

Continue using a non-breaking space for digit grouping so values such as `43 300` do not wrap across lines.

Numeric input should accept both comma and point decimal separators. Display should follow the active locale where feasible, while machine-readable exports must continue to use a point as the decimal separator.

## Proposed API

Introduce one central formatter for pharmacological quantities:

```ts
interface QuantityFormatOptions {
  mode: 'source' | 'derived';
  significantFigures?: number; // default 3 for derived
  sourceDecimals?: number;
  sourceSignificantFigures?: number;
  locale?: string;
  unit?: string;
  useGrouping?: boolean;
}

function formatQuantity(
  value: number,
  options: QuantityFormatOptions,
): string;
```

Provide an accompanying range formatter:

```ts
function formatQuantityRange(
  range: NumericRange,
  options: QuantityFormatOptions,
): string;
```

The formatter should:

- preserve zero as `0`;
- never turn a finite nonzero value into `0`;
- round correctly to integer tens, hundreds, and higher positions;
- strip unnecessary trailing zeros for derived values;
- retain requested trailing zeros for source values;
- group thousands with the existing non-breaking-space convention;
- avoid binary floating-point artifacts;
- apply identical behavior in UI surfaces and human-readable exports.

## Integration targets

The shared formatter should be adopted by:

- `src/lib/rangeUtils.ts`
- `src/lib/unitTooltip.ts`
- `src/components/drug-table/DrugInlineConverter.tsx`
- `src/components/admin/ReferenceConcentrationsAdminSection.tsx`
- `src/components/simulator/AnswerCard.tsx`
- `src/components/simulator/ResultsSummary.tsx`
- `src/lib/simulatorExport.ts`
- `src/lib/compute/report.ts`
- drug-table and monograph range displays
- graph axes and tooltips where concentrations or doses are displayed

`formatWithMaxDecimals` may remain for quantities where a fixed number of decimal places is genuinely intended, but it should no longer be the default formatter for concentrations and doses.

## Minimum tests

Add tests covering:

- zero and non-finite values;
- positive and negative values where applicable;
- magnitude boundaries at 0.0001, 0.001, 0.01, 0.1, 1, 10, 100, 1,000, and 10,000;
- rounding across a power-of-ten boundary;
- `43 263 → 43 300` at three significant figures;
- `0.0009352 → 0.000935`;
- `100.947 → 101`;
- preservation of source `1.0`;
- separately specified endpoint precision;
- ranges and one-sided inequalities;
- locale decimal separators;
- non-breaking-space thousands grouping;
- preferred-unit conversions;
- threshold comparison using unrounded values;
- the additional-digit disambiguation rule near a threshold;
- parity between UI, report, and plain-text export formatting.

## Final policy

> Preserve reported precision for source and measured quantities. Display calculated concentrations and doses to three significant figures. Retain full precision internally, and never base interpretation on rounded values.
