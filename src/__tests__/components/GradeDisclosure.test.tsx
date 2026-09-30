import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GradeDisclosure } from '@/components/wiki/GradeDisclosure';
import type { GradeDisclosure as GradeDisclosureData } from '@/lib/modelGradeDisclosure';

/**
 * CV-3d — the grade + disclaimer component. Presentational: it renders the CV-3c `describeDerivedModel`
 * contract (grade, limiting factor, band-widening, structured caveats), so it is driven here entirely
 * from fixtures.
 */

describe('CV-3d — GradeDisclosure', () => {
  it('renders the grade and one item per caveat for a graded model', () => {
    const disclosure: GradeDisclosureData = {
      rendersCurve: true,
      grade: 'C',
      limitingFactor: 'completeness',
      bandWideningCv: 0.3,
      caveats: [
        { code: 'defaulted-axes', axes: ['absorption'] },
        { code: 'missing-parameters', parameters: ['ka'] },
        { code: 'not-validated' },
      ],
    };
    render(<GradeDisclosure disclosure={disclosure} />);

    expect(screen.getByText('C')).toBeInTheDocument();
    // One list item per caveat.
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('shows a not-modelable badge and no grade for a not-modelable model', () => {
    const disclosure: GradeDisclosureData = {
      rendersCurve: false,
      grade: null,
      limitingFactor: null,
      bandWideningCv: null,
      caveats: [{ code: 'not-modelable', reason: 'conflicting disposition' }],
    };
    render(<GradeDisclosure disclosure={disclosure} />);

    // The badge renders the not-modelable label (its i18n key in the test's key-echo mode).
    expect(screen.getByText('modelGrade.notModelable')).toBeInTheDocument();
    // No grade badge letter for A–D.
    for (const g of ['A', 'B', 'C', 'D']) {
      expect(screen.queryByText(g)).not.toBeInTheDocument();
    }
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('shows just the badge for a spotless A model (no caveats)', () => {
    const disclosure: GradeDisclosureData = {
      rendersCurve: true,
      grade: 'A',
      limitingFactor: null,
      bandWideningCv: null,
      caveats: [],
    };
    render(<GradeDisclosure disclosure={disclosure} />);

    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });
});

describe('CV-3d — inferred-parameters caveat', () => {
  it('renders an inferred parameter as its own caveat, distinct from a missing one', () => {
    const disclosure: GradeDisclosureData = {
      rendersCurve: true,
      grade: 'C',
      limitingFactor: 'parameterInference',
      bandWideningCv: 0.3,
      caveats: [
        { code: 'inferred-parameters', parameters: ['ka'] },
        { code: 'missing-parameters', parameters: ['bioavailability'] },
      ],
    };
    render(<GradeDisclosure disclosure={disclosure} />);

    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toHaveLength(2);
    // In key-echo mode each caveat renders its own translation key, so the two are provably not
    // collapsed into one another.
    expect(items.some((text) => text?.includes('modelGrade.caveat.inferredParameters'))).toBe(true);
    expect(items.some((text) => text?.includes('modelGrade.caveat.missingParameters'))).toBe(true);
  });
});
