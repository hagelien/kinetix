# Cocaine migration report (legacy → `cocaine-one-comp-v2`)

**Plan:** B1 (`docs/plans/2026-07-23-harmonization-completion.md`) ·
**Registry:** `0.9.0` (checksum `adcc1cec`) · **Core:** `1.2.1`

The reviewed cocaine model is a **deliberate, approved parameter change** from
Redose's legacy `lib/substances/cocaine.ts`, not a numerical mirror. The master
plan (§305, §459–468) requires every result-changing change to ship before/after
benchmark output; this report is that record.

Regenerate the numbers with:

```
npx tsx scripts/kinetics-cocaine-benchmark.ts
```

## What changed

Shared disposition: **Vd 2.0 L/kg (lean-body-mass) → 2.7 L/kg (total-weight)**
(2.7 L/kg is Jeffcoat 1989's Vβ, and >2.5 → lipophilic → total-weight scaling);
**terminal t½ 60 → 90 min** (upper end of the catalog 0.5–1.5 h range).

Per-route bioavailability / absorption (all reviewed literature values, each
traceable to a named paper — see `registry.ts` references and `provenance.ts`):

| Route | Legacy F | v2 F | Legacy abs t½ | v2 abs t½ | Source |
| --- | --- | --- | --- | --- | --- |
| intranasal | 0.30 | 0.80 | 10 min | 11.7 min | Jeffcoat 1989 (nasal insufflation) |
| smoked → inhalation | 0.70 | 0.57 | 1 min | 1.1 min | Jeffcoat 1989 (smoke inhalation) |
| oral | 0.35 | 0.33 | 30 min | 30 min | Wilkinson 1980 (oral kinetics) |
| iv | 1.0 (fast one-comp) | 1.0 (true bolus) | 0.5 min | — | reviewed `iv-one-compartment` |

The **smoked bioavailability is DECREASED** (0.70 → 0.57). 0.57 is Jeffcoat's
*observed* smoked value — intact cocaine is well absorbed, but the observed
figure is reduced by pyrolytic degradation on heating. This is the
evidence-faithful value (it also coincides with the generic catalog F 0.57); it
is **not** rounded up to a conservative estimate. The legacy 0.70 was unsupported
by its own cited source.

## Before/after benchmark

Reference subject: 75 kg, 178 cm, 28 y, male. The v2 parameters are read from the
registry (`cocaine-one-comp-v2`), not duplicated in the script, so the numbers
cannot drift from a later registry correction. Concentrations in mg/L.

For the **absorption routes** (intranasal, smoked, oral) both curves use the
identical kinetics-core one-compartment Bateman equation + Vd scaling, so those
deltas isolate the parameter change. The **IV row is different**: legacy modelled
IV as fast one-compartment *absorption*, whereas v2 uses a **true bolus**
(`C(0)=dose/Vd`) — so its delta combines a model-family change with the Vd/t½
changes and is **not** a pure parameter comparison.

| Route | Dose | Cmax legacy | Cmax v2 | ΔCmax | Tmax legacy | Tmax v2 | C@1h legacy | C@1h v2 | ΔC@1h |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| intranasal | 40 mg | 0.0570 | 0.1165 | +104% | 31.0 min | 39.5 min | 0.0474 | 0.1092 | +130% |
| smoked → inhalation | 40 mg | 0.1776 | 0.1066 | −40% | 6.0 min | 7.0 min | 0.0968 | 0.0718 | −26% |
| oral | 100 mg | 0.1189 | 0.0941 | −21% | 60.0 min | 71.5 min | 0.1189 | 0.0929 | −22% |
| iv *(model-family change)* | 40 mg | 0.2612 | 0.1975 | −24% | 3.5 min | 0.0 min | 0.1371 | 0.1244 | −9% |

Reading the deltas:

- **intranasal +104% Cmax** — dominated by F 0.30 → 0.80 (the legacy value badly
  underestimated nasal bioavailability); the larger Vd partly offsets it.
- **smoked −40% Cmax** — F 0.70 → 0.57 *and* the larger, total-weight-scaled Vd
  both lower the curve; this is the evidence-faithful correction.
- **oral −21%, iv −24%** — driven by the larger distribution volume; oral F barely
  moved (0.35 → 0.33).
- **iv Tmax → 0** — legacy modelled IV as fast one-compartment absorption (peak a
  few minutes in); v2 uses a true bolus (`C(0) = dose/Vd`), so the peak is at t=0.

These are material, intended changes. Redose consumes them as an approved
parameter change once it re-vendors registry `0.9.0`.

## Grid-independent peak (core 1.2.1)

The smoked route peaks ~7 min after dosing — between the samples of a typical
0.5-h output grid. The core previously reported `peak` as the maximum over the
caller's grid samples alone, so a coarse-grid consumer read a **materially low**
smoked Cmax. Core `1.2.1` refines the peak of the closed-form families off the
output grid (max of the exact central curve on a bounded fine internal sub-grid),
a strict, safety-upward correction (peak never decreases; time series unchanged).

Demonstrated by the parity fixtures: `cocaine-inhalation-single-40mg` (0.5-h grid)
and `cocaine-inhalation-single-40mg-finegrid` (0.01-h grid) now report the **same**
peak (0.1066 mg/L @ ~0.117 h), above the coarse grid's largest sample (0.0905).
ODE-family fast routes remain a tracked follow-up (see `roadmap.md`).
