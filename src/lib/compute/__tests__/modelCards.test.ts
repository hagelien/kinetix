import { describe, it, expect } from 'vitest';
import en from '@/locales/en.json';
import nb from '@/locales/nb.json';
import { findModelCardByAnalyte, findModelCardById } from '../modelCards';

// Targeted regression tests for phase 2f-2 round-4 (#346).
// The ethanol model card is rendered both in the KineLab result panel
// and in generated reports, so its assumption text needs to (a) describe
// the engine's actual calculation surface (mg/L/h, not the forward
// Widmark calculator's g/dL/h) and (b) ship localized text for the
// strings KineLab now exposes through the `etanol` analyte picker.

describe('ethanol model card', () => {
  const card = findModelCardByAnalyte('ethanol');

  it('exists and exposes both the widmark-distribution and linear-elimination assumptions', () => {
    expect(card).toBeDefined();
    const ids = card!.assumptions.map((a) => a.id);
    expect(ids).toContain('widmark-distribution');
    expect(ids).toContain('linear-elimination');
  });

  it('states the linear-elimination unit as mg/L per hour in its primary claim', () => {
    // Pre-2f-2 the card said "Elimination is linear (zero-order) in
    // g/dL/hour …" — the units the forward Widmark calculator
    // displays. The KineLab inverse engine, the priors panel, and
    // the report row all use mg/L/h, so the binding claim must too.
    // The text may still mention g/dL/hour as a disambiguating
    // reference to the forward calculator's display unit, but the
    // first-sentence claim about the engine's calculation surface
    // must be mg/L/h.
    const linearElim = card!.assumptions.find(
      (a) => a.id === 'linear-elimination',
    )!;
    const firstSentence = linearElim.text.split('.')[0]!;
    expect(firstSentence).toMatch(/mg\/L per hour|mg\/L\/h/);
    expect(firstSentence).not.toMatch(/g\/dL\/hour/);
  });

  it('routes both ethanol-card assumptions through i18n keys with en + nb translations', () => {
    // Per AGENTS.md, every PR that adds or changes user-facing text
    // ships matching English + Norwegian copy. The card-data layer is
    // engine-side (React-free), so localization is via an `i18nKey`
    // field that the page + report flow resolve before render.
    const widmark = card!.assumptions.find((a) => a.id === 'widmark-distribution')!;
    const linearElim = card!.assumptions.find((a) => a.id === 'linear-elimination')!;
    expect(widmark.i18nKey).toBe('kinelab.modelCard.ethanol.widmarkDistribution');
    expect(linearElim.i18nKey).toBe('kinelab.modelCard.ethanol.linearElimination');

    const enModel = (en as { kinelab: { modelCard: { ethanol: Record<string, string> } } })
      .kinelab.modelCard.ethanol;
    const nbModel = (nb as { kinelab: { modelCard: { ethanol: Record<string, string> } } })
      .kinelab.modelCard.ethanol;
    expect(enModel.widmarkDistribution).toBeTruthy();
    expect(enModel.linearElimination).toBeTruthy();
    expect(nbModel.widmarkDistribution).toBeTruthy();
    expect(nbModel.linearElimination).toBeTruthy();
    // The Norwegian translation must not be a verbatim copy of the
    // English one — that would imply a missed translation.
    expect(nbModel.widmarkDistribution).not.toBe(enModel.widmarkDistribution);
    expect(nbModel.linearElimination).not.toBe(enModel.linearElimination);
  });
});

describe('morphine model card', () => {
  it('is keyed by the English-derived slug so the app analyte id matches it', () => {
    // The app derives an analyte id from `nameEn || name` ('Morphine' →
    // 'morphine'). The card previously used the Norwegian 'morfin' slug, so
    // it never matched and morphine ran card-less.
    expect(findModelCardByAnalyte('morphine')?.id).toBe(
      'morphine-parent-metabolite-v0',
    );
    expect(findModelCardByAnalyte('morfin')).toBeUndefined();
  });

  it('still declares the parent/metabolite model type (guarded, not silently first-order)', () => {
    const card = findModelCardById('morphine-parent-metabolite-v0');
    expect(card?.modelType).toBe('parent_metabolite_simple');
  });
});
