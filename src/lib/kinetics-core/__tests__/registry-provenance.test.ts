/**
 * Registry ↔ catalog provenance gate.
 *
 * Enforces the harmonization plan's registry-provenance guarantee (plan §18;
 * `docs/kinetics-core/roadmap.md`): the frozen registry release is the pinned
 * run-time snapshot, but every parameter it declares to TRACK the reviewed
 * catalog (`data/components.ts`) must actually stay within tolerance of it, and
 * every parameter that intentionally departs must carry a reviewer rationale.
 *
 * If a future catalog edit pulls a `catalog`-sourced value out of tolerance, or a
 * new registry parameter ships without a provenance decision, this fails — the
 * same assertion `scripts/generate-registry-provenance.ts --check` makes in CI.
 */
import { describe, it, expect } from 'vitest';
import {
  crossCheckRegistry,
  auditProvenanceCompleteness,
  reviewerAuthoredRouteParams,
  NOT_IN_CATALOG_PARAMS,
  REGISTRY_PROVENANCE,
} from '../provenance';
import { registeredAnalytes, findModel } from '../registry';
// Imported through the PACKAGE ENTRY POINT (not '../registry') to guard that the
// alias-aware helper is actually re-exported for consumers like Redose.
import { supportedAnalyteIds } from '../index';
import { catalogLookup } from '../../kinetics-provenance/catalog-lookup';

describe('registry analyte resolution', () => {
  it('supportedAnalyteIds (from the package index) includes aliases and every id resolves', () => {
    const ids = supportedAnalyteIds();
    // Aliases are included (psilocin → psilocybin model) beyond the primary ids…
    expect(ids).toContain('psilocin');
    expect(ids).toContain('psilocybin');
    expect(ids.length).toBeGreaterThan(registeredAnalytes().length);
    // …and every supported id actually resolves to a model.
    for (const id of ids) expect(findModel(id), `unresolved id ${id}`).toBeTruthy();
    // The alias and its primary resolve to the SAME model.
    expect(findModel('psilocin')).toBe(findModel('psilocybin'));
  });
});

describe('registry catalog provenance', () => {
  it('has no undeclared divergence (catalog-tracking params stay in tolerance)', () => {
    const report = crossCheckRegistry(catalogLookup);
    // Surface the offending rows in the failure message, not just a count.
    expect(
      report.undeclared.map(
        (r) =>
          `${r.analyte}/${r.route}/${r.param}: ${r.registryValue} vs catalog ${JSON.stringify(
            r.catalog,
          )} (${r.classification}, ${r.provenance?.source ?? 'MISSING'})`,
      ),
    ).toEqual([]);
  });

  it('provenance table is structurally complete and well-formed', () => {
    expect(auditProvenanceCompleteness()).toEqual([]);
  });

  it('every checkable registry parameter is cross-checked exactly once per route', () => {
    const report = crossCheckRegistry(catalogLookup);
    const keys = report.rows.map((r) => `${r.analyte}/${r.route}/${r.param}`);
    expect(new Set(keys).size).toBe(keys.length); // no duplicates
    // Every registered model contributes rows.
    for (const analyte of registeredAnalytes()) {
      expect(report.rows.some((r) => r.analyte === analyte)).toBe(true);
    }
  });

  it('reviewed-override entries all carry a non-empty rationale', () => {
    for (const entry of REGISTRY_PROVENANCE) {
      for (const byRoute of Object.values(entry.params)) {
        for (const prov of Object.values(byRoute ?? {})) {
          if (prov?.source === 'reviewed-override') {
            expect(prov.rationale?.trim()).toBeTruthy();
          }
        }
      }
    }
  });

  it('lists every reviewer-authored (non-catalog) parameter so tooling can classify it', () => {
    // The SC-4A administration parameters are reviewer-authored with no catalog analogue,
    // so they must be identified as such alongside the originals.
    for (const p of [
      'kaPerHour',
      'vdScaling',
      'absorptionLagHours',
      'zeroOrderDurationHours',
      'firstOrderFraction',
    ]) {
      expect(NOT_IN_CATALOG_PARAMS).toContain(p);
    }
  });

  it('records vdScaling (a non-catalog param) for every route so a silent switch is diffable', () => {
    expect(NOT_IN_CATALOG_PARAMS).toContain('vdScaling');
    const rows = reviewerAuthoredRouteParams();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(['total-weight', 'lean-body-mass', 'widmark']).toContain(r.vdScaling);
      // Absorption rate is finite for absorption families, null for IV.
      if (r.kaPerHour !== null) expect(Number.isFinite(r.kaPerHour)).toBe(true);
    }
    // The cocaine IV route reports the IV family with no absorption rate.
    const ivRow = rows.find((r) => r.analyte === 'cocaine' && r.route === 'iv');
    expect(ivRow?.family).toBe('iv-one-compartment');
    expect(ivRow?.kaPerHour).toBeNull();
    // The migrated hydrophilic models must report lean-body-mass, not a silent
    // total-weight fallback.
    for (const analyte of ['methylphenidate', 'lsd', '2cb']) {
      const modelRows = rows.filter((r) => r.analyte === analyte);
      expect(modelRows.length).toBeGreaterThan(0);
      for (const r of modelRows) expect(r.vdScaling).toBe('lean-body-mass');
    }
    // Amphetamine stays total-weight.
    for (const r of rows.filter((r) => r.analyte === 'amphetamine')) {
      expect(r.vdScaling).toBe('total-weight');
    }
    // The Michaelis–Menten models report their scaling AND the (non-catalog)
    // Vmax/Km, so a change to the saturable elimination is a diffable decision.
    const ghbRow = rows.find((r) => r.analyte === 'ghb' && r.route === 'oral');
    expect(ghbRow?.family).toBe('michaelis-menten');
    expect(ghbRow?.vdScaling).toBe('lean-body-mass');
    expect(Number.isFinite(ghbRow?.vmaxMgPerLPerHour)).toBe(true);
    expect(Number.isFinite(ghbRow?.kmMgPerL)).toBe(true);
    const ethRow = rows.find((r) => r.analyte === 'ethanol' && r.route === 'oral');
    expect(ethRow?.vdScaling).toBe('widmark');
    expect(Number.isFinite(ethRow?.vmaxMgPerLPerHour)).toBe(true);
  });

  it('every provenance entry maps to a real registered model', () => {
    for (const entry of REGISTRY_PROVENANCE) {
      expect(findModel(entry.analyte), `unknown analyte ${entry.analyte}`).toBeTruthy();
    }
  });

  it('detects drift: mutating a catalog-tracked value out of range fails the gate', () => {
    // Amphetamine Vd is annotated `catalog`; a synthetic lookup that reports a
    // wildly different catalog Vd must trip the gate for that row.
    const drifted = (analyte: string) => {
      const base = catalogLookup(analyte);
      if (analyte === 'amphetamine' && base) {
        return { ...base, vdLitersPerKg: { min: 40, max: 44, point: 42 } };
      }
      return base;
    };
    const report = crossCheckRegistry(drifted);
    const row = report.undeclared.find(
      (r) => r.analyte === 'amphetamine' && r.param === 'vdLitersPerKg',
    );
    expect(row).toBeDefined();
    expect(row?.classification).toBe('divergent');
  });

  it('treats a complete catalog range as a hard bound (point tolerance cannot rescue it)', () => {
    // Amphetamine elim is annotated `catalog`. Feed a full range that EXCLUDES
    // the registry value (11 h) but a central point NEAR it (within 10%): the
    // value must classify divergent — the range is authoritative, not the point.
    const tightRange = (analyte: string) => {
      const base = catalogLookup(analyte);
      if (analyte === 'amphetamine' && base) {
        return {
          ...base,
          eliminationHalfLifeHours: { min: 5, max: 7, point: 10.5 },
        };
      }
      return base;
    };
    const report = crossCheckRegistry(tightRange);
    const rows = report.rows.filter(
      (r) => r.analyte === 'amphetamine' && r.param === 'eliminationHalfLifeHours',
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.classification).toBe('divergent');
      expect(row.undeclaredDivergence).toBe(true); // annotated `catalog` → gate trips
    }
  });

  it('a total-litre catalog Vd never certifies a catalog claim on its own', () => {
    // If some analyte's Vd were annotated `catalog` but only a total-litre
    // catalog value exists, the gate must NOT pass silently. Simulate by feeding
    // a total-litre Vd for amphetamine (whose Vd is `catalog`): it must be
    // treated as non-certifying and trip the gate.
    const totalLitre = (analyte: string) => {
      const base = catalogLookup(analyte);
      if (analyte === 'amphetamine' && base) {
        return {
          ...base,
          vdLitersPerKg: { point: 4 },
          vdFromTotalLiters: true,
        };
      }
      return base;
    };
    const report = crossCheckRegistry(totalLitre);
    const row = report.rows.find(
      (r) => r.analyte === 'amphetamine' && r.param === 'vdLitersPerKg',
    );
    expect(row?.undeclaredDivergence).toBe(true);
  });
});
