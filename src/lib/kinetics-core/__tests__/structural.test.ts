/**
 * SC-1A structural-parameter identity + identifiability semantics.
 *
 * These are the plan's true-vs-apparent rules (docs/plans/2026-08-18-…-scientific-
 * completion.md §4.1/§5.3) exercised as pure functions: `CL` vs `CL/F` is a
 * difference of identity, an apparent extravascular parameter is never exposed as
 * absolute, and `ke = CL/Vc` (with a derived half-life) is identifiable regardless
 * of basis.
 */
import { describe, it, expect } from 'vitest';
import {
  isApparentBasis,
  isAbsoluteBasis,
  structuralIdentity,
  resolveStructural,
  absoluteValueOrNull,
  isPrimitiveBasis,
  sameIdentifiabilityClass,
  isCoherentClvDisposition,
  clvReferenceSubjectLimitation,
  resolveClvDisposition,
} from '../structural';
import { halfLifeFromK } from '../equations';
import type { IdentifiabilityBasis, StructuralParameterId } from '../types';

const ALL_BASES: IdentifiabilityBasis[] = [
  'iv-anchored',
  'absolute-f-supported',
  'apparent-extravascular',
  'derived',
];

describe('basis predicates', () => {
  it('apparent-extravascular is the only apparent basis', () => {
    for (const b of ALL_BASES) {
      expect(isApparentBasis(b)).toBe(b === 'apparent-extravascular');
    }
  });

  it('only iv-anchored and absolute-f-supported license an absolute reading', () => {
    expect(isAbsoluteBasis('iv-anchored')).toBe(true);
    expect(isAbsoluteBasis('absolute-f-supported')).toBe(true);
    expect(isAbsoluteBasis('apparent-extravascular')).toBe(false);
    // `derived` is a computed quantity, not a measured absolute one.
    expect(isAbsoluteBasis('derived')).toBe(false);
  });

  it('apparent and absolute are mutually exclusive (never both)', () => {
    for (const b of ALL_BASES) {
      expect(isApparentBasis(b) && isAbsoluteBasis(b)).toBe(false);
    }
  });
});

describe('structuralIdentity — CL vs CL/F', () => {
  it('suffixes /F only for the divide-by-F disposition params under an apparent basis', () => {
    const suffixable: StructuralParameterId[] = ['CL', 'Vc', 'Vp', 'Q'];
    for (const id of suffixable) {
      expect(structuralIdentity(id, 'apparent-extravascular')).toBe(`${id}/F`);
      // Absolute / derived keep the bare identity.
      expect(structuralIdentity(id, 'iv-anchored')).toBe(id);
      expect(structuralIdentity(id, 'absolute-f-supported')).toBe(id);
      expect(structuralIdentity(id, 'derived')).toBe(id);
    }
  });

  it('never suffixes params with no apparent counterpart', () => {
    const noApparent: StructuralParameterId[] = ['ka', 'F', 'Vmax', 'Km'];
    for (const id of noApparent) {
      for (const b of ALL_BASES) {
        expect(structuralIdentity(id, b)).toBe(id);
      }
    }
  });
});

describe('resolveStructural + absoluteValueOrNull — the apparent-exposure guard', () => {
  it('an apparent CL resolves to identity CL/F and refuses absolute exposure', () => {
    const r = resolveStructural({ id: 'CL', basis: 'apparent-extravascular' }, 21);
    expect(r.identity).toBe('CL/F');
    expect(r.exposableAsAbsolute).toBe(false);
    expect(r.value).toBe(21); // the value IS the apparent CL/F
    expect(absoluteValueOrNull(r)).toBeNull(); // never surfaced as absolute CL
  });

  it('an IV-anchored CL resolves to identity CL and exposes the absolute value', () => {
    const r = resolveStructural({ id: 'CL', basis: 'iv-anchored' }, 21);
    expect(r.identity).toBe('CL');
    expect(r.exposableAsAbsolute).toBe(true);
    expect(absoluteValueOrNull(r)).toBe(21);
  });

  it('an F-supported volume exposes an absolute Vc', () => {
    const r = resolveStructural({ id: 'Vc', basis: 'absolute-f-supported' }, 210);
    expect(r.identity).toBe('Vc');
    expect(absoluteValueOrNull(r)).toBe(210);
  });

  it('derives exposure from basis, not a redundant/inconsistent boolean', () => {
    // A deserialized/hand-built value could carry an inconsistent pair. The guard
    // must trust the authoritative basis and refuse to promote an apparent value.
    const tampered = {
      id: 'CL' as const,
      basis: 'apparent-extravascular' as const,
      value: 21,
      identity: 'CL/F',
      exposableAsAbsolute: true, // inconsistent with the apparent basis
    };
    expect(absoluteValueOrNull(tampered)).toBeNull();
  });
});

describe('sameIdentifiabilityClass — coherence of a CL/V pair', () => {
  it('two absolute bases (in any mix) are the same class', () => {
    expect(sameIdentifiabilityClass('iv-anchored', 'absolute-f-supported')).toBe(true);
    expect(sameIdentifiabilityClass('iv-anchored', 'iv-anchored')).toBe(true);
  });

  it('two apparent bases are the same class', () => {
    expect(sameIdentifiabilityClass('apparent-extravascular', 'apparent-extravascular')).toBe(true);
  });

  it('an absolute and an apparent basis are NOT the same class', () => {
    expect(sameIdentifiabilityClass('iv-anchored', 'apparent-extravascular')).toBe(false);
    expect(sameIdentifiabilityClass('apparent-extravascular', 'absolute-f-supported')).toBe(false);
  });

  it('`derived` (or unknown) shares a class with nothing, including itself', () => {
    // Its contract is "both apparent or both absolute"; two derived/unknown bases
    // are neither, so an equality-of-predicates impl would wrongly report `true`.
    expect(sameIdentifiabilityClass('derived', 'derived')).toBe(false);
    expect(sameIdentifiabilityClass('derived', 'iv-anchored')).toBe(false);
    expect(sameIdentifiabilityClass('derived', 'apparent-extravascular')).toBe(false);
    expect(sameIdentifiabilityClass(null as never, null as never)).toBe(false);
  });
});

describe('isCoherentClvDisposition — authoring guard', () => {
  const CL = { id: 'CL' as const };
  const Vc = { id: 'Vc' as const };

  it('accepts a same-class CL/Vc pair (both apparent, or both absolute)', () => {
    expect(
      isCoherentClvDisposition(
        { ...CL, basis: 'apparent-extravascular' },
        { ...Vc, basis: 'apparent-extravascular' },
      ),
    ).toBe(true);
    expect(
      isCoherentClvDisposition(
        { ...CL, basis: 'iv-anchored' },
        { ...Vc, basis: 'absolute-f-supported' },
      ),
    ).toBe(true);
  });

  it('rejects a mixed absolute/apparent pair', () => {
    expect(
      isCoherentClvDisposition(
        { ...CL, basis: 'apparent-extravascular' },
        { ...Vc, basis: 'iv-anchored' },
      ),
    ).toBe(false);
  });

  it('rejects a derived basis on an authored primitive', () => {
    expect(
      isCoherentClvDisposition({ ...CL, basis: 'derived' }, { ...Vc, basis: 'derived' }),
    ).toBe(false);
  });

  it('rejects swapped or foreign ids', () => {
    expect(
      isCoherentClvDisposition(
        { id: 'Vc', basis: 'apparent-extravascular' },
        { id: 'CL', basis: 'apparent-extravascular' },
      ),
    ).toBe(false);
    expect(
      isCoherentClvDisposition(
        { id: 'Q', basis: 'apparent-extravascular' },
        { ...Vc, basis: 'apparent-extravascular' },
      ),
    ).toBe(false);
  });

  it('rejects an unknown / out-of-enum basis on both sides (not just `derived`)', () => {
    // A non-TS caller could pass the SAME unknown value for both bases. Both apparent
    // and absolute predicates return false for it, so a naive same-class test would
    // pass (false === false). isPrimitiveBasis closes that hole.
    for (const bad of [null, undefined, '', 'apparent', 'CL/F'] as unknown[]) {
      expect(isPrimitiveBasis(bad as never)).toBe(false);
      expect(
        isCoherentClvDisposition(
          { id: 'CL', basis: bad as never },
          { id: 'Vc', basis: bad as never },
        ),
      ).toBe(false);
    }
  });
});

describe('isPrimitiveBasis', () => {
  it('is true only for the apparent and absolute bases', () => {
    expect(isPrimitiveBasis('apparent-extravascular')).toBe(true);
    expect(isPrimitiveBasis('iv-anchored')).toBe(true);
    expect(isPrimitiveBasis('absolute-f-supported')).toBe(true);
    expect(isPrimitiveBasis('derived')).toBe(false);
  });
});

describe('clvReferenceSubjectLimitation', () => {
  it('is a standing warning that names the route and states weight was not applied', () => {
    const lim = clvReferenceSubjectLimitation('oral');
    expect(lim.code).toBe('clv-reference-subject');
    expect(lim.severity).toBe('warning');
    expect(lim.text).toContain('oral');
    expect(lim.text.toLowerCase()).toContain('weight');
  });
});

describe('resolveClvDisposition — ke = CL/Vc, derived half-life', () => {
  it('derives ke and half-life from CL and Vc', () => {
    const CL = 10.4; // L/h
    const Vc = 208; // L → ke = 0.05 /h
    const disp = resolveClvDisposition(
      { id: 'CL', basis: 'iv-anchored' },
      { id: 'Vc', basis: 'iv-anchored' },
      CL,
      Vc,
    );
    expect(disp.eliminationRatePerHour).toBeCloseTo(0.05, 12);
    expect(disp.halfLifeHours).toBeCloseTo(halfLifeFromK(0.05), 12);
    expect(disp.scalingVolumeLiters).toBe(Vc);
    expect(disp.clearance.identity).toBe('CL');
    expect(disp.volume.identity).toBe('Vc');
  });

  it('throws on an incoherent pair, so a direct consumer cannot bypass the guard', () => {
    // Mixed absolute/apparent — a scientifically meaningless division.
    expect(() =>
      resolveClvDisposition(
        { id: 'CL', basis: 'apparent-extravascular' },
        { id: 'Vc', basis: 'iv-anchored' },
        12,
        240,
      ),
    ).toThrow(/incoherent/i);
    // Unknown/out-of-enum basis on both sides.
    expect(() =>
      resolveClvDisposition(
        { id: 'CL', basis: null as never },
        { id: 'Vc', basis: null as never },
        12,
        240,
      ),
    ).toThrow(/incoherent/i);
    // Swapped ids (a non-TS caller; TS pins these).
    expect(() =>
      resolveClvDisposition(
        { id: 'Vc' as never, basis: 'apparent-extravascular' },
        { id: 'CL' as never, basis: 'apparent-extravascular' },
        12,
        240,
      ),
    ).toThrow(/incoherent/i);
  });

  it('ke is identical for the apparent pair (CL/F)/(Vc/F) = CL/Vc', () => {
    const F = 0.6;
    const absolute = resolveClvDisposition(
      { id: 'CL', basis: 'iv-anchored' },
      { id: 'Vc', basis: 'iv-anchored' },
      12,
      240,
    );
    // The same physiology observed extravascular-only: both scale by 1/F, so the
    // ratio (the rate) is unchanged — the whole point of the identity distinction.
    const apparent = resolveClvDisposition(
      { id: 'CL', basis: 'apparent-extravascular' },
      { id: 'Vc', basis: 'apparent-extravascular' },
      12 / F,
      240 / F,
    );
    expect(apparent.eliminationRatePerHour).toBeCloseTo(
      absolute.eliminationRatePerHour,
      12,
    );
    // …but the identities and absolute-exposability differ.
    expect(apparent.clearance.identity).toBe('CL/F');
    expect(absolute.clearance.identity).toBe('CL');
    expect(apparent.clearance.exposableAsAbsolute).toBe(false);
    expect(absolute.clearance.exposableAsAbsolute).toBe(true);
  });
});
