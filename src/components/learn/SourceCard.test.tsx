import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SourceCard } from './SourceCard';
import type { LearningUnitContent, LearningUnitSource } from '@/lib/learnApi';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const card: LearningUnitContent['sourceCard'] = {
  whyItMatters: 'This anchors the foundations.',
  sourceStatus: ['foundational'],
  estimatedReadingMinutes: 25,
};

const source: LearningUnitSource = {
  citationId: 10,
  type: 'doi',
  identifier: '10.1/x',
  url: 'https://doi.org/10.1/x',
  metadata: { title: 'Original paper', authors: ['Smith J'], year: 2024 },
};

describe('SourceCard', () => {
  it('renders the unit title, metadata, and a link-out to the source', () => {
    render(
      <SourceCard
        title="Volume of distribution"
        difficulty="foundational"
        source={source}
        card={card}
      />,
    );
    expect(screen.getByText('Volume of distribution')).toBeInTheDocument();
    expect(screen.getByText('Original paper')).toBeInTheDocument();

    const link = screen.getByRole('link', {
      name: /learn.sourceCard.open/,
    });
    expect(link).toHaveAttribute('href', 'https://doi.org/10.1/x');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('never embeds the source (link-out only)', () => {
    const { container } = render(
      <SourceCard
        title="VD"
        difficulty="foundational"
        source={source}
        card={card}
      />,
    );
    expect(container.querySelector('iframe, embed, object')).toBeNull();
  });

  it('falls back to a resolved url when the API omits one', () => {
    render(
      <SourceCard
        title="VD"
        difficulty="foundational"
        source={{ ...source, url: null }}
        card={card}
      />,
    );
    expect(
      screen.getByRole('link', { name: /learn.sourceCard.open/ }),
    ).toHaveAttribute('href', 'https://doi.org/10.1/x');
  });

  it('ignores an unsafe API source URL and uses the resolved identifier link', () => {
    render(
      <SourceCard
        title="VD"
        difficulty="foundational"
        source={{ ...source, url: 'javascript:alert(1)' }}
        card={card}
      />,
    );
    expect(
      screen.getByRole('link', { name: /learn.sourceCard.open/ }),
    ).toHaveAttribute('href', 'https://doi.org/10.1/x');
  });

  it('renders no link when a URL citation is unsafe', () => {
    render(
      <SourceCard
        title="VD"
        difficulty="foundational"
        source={{
          ...source,
          type: 'url',
          identifier: 'javascript:alert(1)',
          url: 'javascript:alert(1)',
        }}
        card={card}
      />,
    );
    expect(
      screen.queryByRole('link', { name: /learn.sourceCard.open/ }),
    ).toBeNull();
  });
});
