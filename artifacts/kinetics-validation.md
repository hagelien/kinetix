# kinetics-core validation suite 1.0.0

Core: `1.10.0` · Registry: `0.9.0` (`adcc1cec`)

| Model | Fixture | Scientific endpoint | Result | Evidence status | Change | Detail |
|---|---|---|---|---|---|---|
| 2cb-one-comp-v1 | 2cb-sanity | dimensional-consistency | ✅ pass | implementation/invariant only | new | model=2cb-one-comp-v1; unit=mg/L; ordered finite mg/L curve=true |
| amphetamine-one-comp-v1 | amphetamine-sanity | dimensional-consistency | ✅ pass | implementation/invariant only | new | model=amphetamine-one-comp-v1; unit=mg/L; ordered finite mg/L curve=true |
| cocaine-one-comp-v2 | cocaine-iv-jeffcoat-1989 | dimensional-consistency | ✅ pass | implementation/invariant only | new | model=cocaine-one-comp-v2; unit=mg/L; ordered finite mg/L curve=true |
| cocaine-one-comp-v2 | cocaine-iv-jeffcoat-1989 | mass-balance | ✅ pass | implementation/invariant only | new | model=cocaine-one-comp-v2; endpoint=mass at 0h; expected=100mg; recovered=100mg |
| cocaine-one-comp-v2 | cocaine-iv-jeffcoat-1989 | literature-landmark | ✅ pass | externally validated | new | model=cocaine-one-comp-v2; endpoint=terminalHalfLifeHours; expected=1.225; computed=1.5000000000000038 |
| ethanol-michaelis-menten-v1 | ethanol-sanity | dimensional-consistency | ✅ pass | implementation/invariant only | new | model=ethanol-michaelis-menten-v1; unit=mg/L; ordered finite mg/L curve=true |
| ghb-michaelis-menten-v1 | ghb-sanity | dimensional-consistency | ✅ pass | implementation/invariant only | new | model=ghb-michaelis-menten-v1; unit=mg/L; ordered finite mg/L curve=true |
| ketamine-one-comp-v1 | ketamine-sanity | dimensional-consistency | ✅ pass | implementation/invariant only | new | model=ketamine-one-comp-v1; unit=mg/L; ordered finite mg/L curve=true |
| lisdexamfetamine-one-comp-v1 | lisdexamfetamine-sanity | dimensional-consistency | ✅ pass | implementation/invariant only | new | model=lisdexamfetamine-one-comp-v1; unit=mg/L; ordered finite mg/L curve=true |
| lsd-one-comp-v1 | lsd-sanity | dimensional-consistency | ✅ pass | implementation/invariant only | new | model=lsd-one-comp-v1; unit=mg/L; ordered finite mg/L curve=true |
| mdma-michaelis-menten-v1 | mdma-sanity | dimensional-consistency | ✅ pass | implementation/invariant only | new | model=mdma-michaelis-menten-v1; unit=mg/L; ordered finite mg/L curve=true |
| methylphenidate-one-comp-v1 | methylphenidate-sanity | dimensional-consistency | ✅ pass | implementation/invariant only | new | model=methylphenidate-one-comp-v1; unit=mg/L; ordered finite mg/L curve=true |
| psilocybin-one-comp-v1 | psilocybin-sanity | dimensional-consistency | ✅ pass | implementation/invariant only | new | model=psilocybin-one-comp-v1; unit=mg/L; ordered finite mg/L curve=true |
| thc-two-comp-v1 | thc-sanity | dimensional-consistency | ✅ pass | implementation/invariant only | new | model=thc-two-comp-v1; unit=mg/L; ordered finite mg/L curve=true |
