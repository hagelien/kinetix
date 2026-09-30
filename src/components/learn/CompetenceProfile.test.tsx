import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CompetenceProfile } from './CompetenceProfile';
import type { CompetenceProfile as Profile } from '@/lib/learnApi';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const profile: Profile = {
  dimensions: [
    { dimension: 'factual_knowledge', accuracyPct: 80, sampleCount: 5 },
    { dimension: 'critical_appraisal', accuracyPct: null, sampleCount: 0 },
    { dimension: 'statistical_reasoning', accuracyPct: 40, sampleCount: 3 },
    { dimension: 'clinical_reasoning', accuracyPct: 60, sampleCount: 2 },
  ],
  retention: { accuracyPct: null, sampleCount: 0 },
};

describe('CompetenceProfile', () => {
  it('renders a bar per dimension plus retention', () => {
    render(<CompetenceProfile profile={profile} />);
    expect(screen.getByText('learn.dimension.factual_knowledge')).toBeInTheDocument();
    expect(screen.getByText('learn.dimension.statistical_reasoning')).toBeInTheDocument();
    expect(screen.getByText('learn.dimension.retention')).toBeInTheDocument();
  });

  it('shows the "not measured" state for dimensions without samples', () => {
    render(<CompetenceProfile profile={profile} />);
    // critical_appraisal and retention are both unmeasured
    expect(
      screen.getAllByText('learn.competence.notMeasured').length,
    ).toBeGreaterThanOrEqual(2);
  });
});
