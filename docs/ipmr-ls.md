# Intrinsic Postmortem Redistribution Liability Score (iPMR-LS v1.1)

The iPMR-LS is a **comparative liability index** estimating how intrinsically
prone a drug is to **postmortem redistribution (PMR)** from commonly available
physicochemical/PK properties. It answers *"compared with other drugs, how much
should I worry that this drug's postmortem blood concentration is affected by
redistribution?"* — it is **not** a way to correct a postmortem concentration
back to an antemortem concentration.

In Kinetix it is a **derived, read-only value** shown in the *Postmortem*
parameter box. It is computed client-side and is **not** a stored or editable
`drug_parameters` value. Implementation: `src/lib/ipmr.ts`.

## Inputs

| iPMR input | Symbol | Kinetix source parameter | Notes |
| ---------- | ------ | ------------------------ | ----- |
| Volume of distribution (L/kg) | `Vd` | `volumeOfDistribution` | **Required**, must be > 0 |
| Neutral logP | `logP` | `logP` | **Required** |
| Basic pKa (pKa of BH⁺) | `pKaB` | `ionizationConstants` (the `+1 → 0` transition) | Optional → basicity term 0 when absent |
| Distribution coefficient at pH 7.4 | `logD7.4` | `logD`, else derived from `logP` + `ionizationConstants` | Optional → falls back to `logP` when neither is available |
| Unbound fraction | `fu` | `proteinBinding` | `fu = 1 − boundFraction`; 0.5 imputed when absent |

`pKaB` is the pKa of the `+1 → 0` equilibrium (BH⁺ ⇌ B + H⁺), read from the
drug's structured ionization profile (`deriveBasicPKa`, macroscopic constants
only, experimental preferred). An acid-only or neutral profile has no such
transition, so `B = 0` follows from the chemistry rather than from acidic pKa
values happening to be numerically low. A drug with **no** ionization constants
at all falls back to the legacy scalar `pKa` treated as basic — a conservative
bridge kept only until the ionization profile is populated (see the
structured-ionization-constants migration plan).

`logD7.4` prefers the measured `logD` parameter. When that is absent but `logP`
and an adequate ionization profile are available, it is derived **transiently**
(never stored, and flagged `logD74Derived`) as `logP + log10(f_neutral(7.4))`,
where `f_neutral` is the neutral-species fraction from the macroscopic ionization
ladder. Only if neither a measured `logD` nor a usable profile exists does it
fall back to `logP`.

The score is only displayed for drugs that have set the two required inputs
(`Vd` and `logP`).

## Formula

With `clip(x) = min(1, max(0, x))` and `sigmoid(x) = 1 / (1 + e^⁻ˣ)`:

```
V   = sigmoid(1.6 · ln(Vd / 3))
B   = 0                                   if no basic centre
    = sigmoid(1.2 · (pKaB − 8.0))         if basic
L_N = clip((logP    − 0.5) / 3.0)
L_D = clip((logD7.4 − 0.5) / 3.0)
U   = sqrt(clip(fu))
T   = (V · L_N · (0.25 + 0.75·B))^(1/3)

iPMR-LS = round(100 · (0.45·V + 0.20·B + 0.10·L_N + 0.05·L_D + 0.05·U + 0.15·T))
```

Result is an integer **0–100**.

## Interpretation bands

| Score | Band | Meaning |
| ----- | ---- | ------- |
| 0–20 | Low | Low intrinsic PMR liability |
| 21–40 | Low–moderate | Consider PMR, but profile does not strongly predict it |
| 41–60 | Moderate | Sampling site, interval, and matrix may matter |
| 61–80 | High | Prefer peripheral blood; seek published PMR data |
| 81–100 | Very high | Marked site dependence plausible; caveat heavily |

## Limitations

The iPMR-LS is a heuristic scientific index, not a validated forensic diagnostic
model. It does not account for postmortem interval, decomposition, trauma,
sampling technique, active metabolites, postmortem formation/degradation, or many
other factors. It must **not** be used as `measured postmortem ÷ iPMR factor =
antemortem`.
