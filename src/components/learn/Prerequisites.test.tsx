import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Prerequisites } from './Prerequisites';
import type { LearningUnitPrerequisite } from '@/lib/learnApi';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const prerequisites: LearningUnitPrerequisite[] = [
  { concept: 'Drug clearance', level: 'essential', why: 'needed for VD' },
  { concept: 'Protein binding', level: 'helpful', why: 'context only' },
];

describe('Prerequisites', () => {
  it('renders each prerequisite with its level label', () => {
    render(<Prerequisites prerequisites={prerequisites} />);
    expect(screen.getByText('Drug clearance')).toBeInTheDocument();
    expect(screen.getByText('Protein binding')).toBeInTheDocument();
    expect(screen.getByText('learn.prereq.essential')).toBeInTheDocument();
    expect(screen.getByText('learn.prereq.helpful')).toBeInTheDocument();
  });

  it('renders nothing when there are no prerequisites', () => {
    const { container } = render(<Prerequisites prerequisites={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
